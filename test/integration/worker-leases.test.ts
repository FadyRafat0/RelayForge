import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createEventStore } from '../../src/events/store.js';
import { runMigrations } from '../../src/migrations.js';
import { claimDelivery } from '../../src/worker/claims.js';
import { completeDelivery } from '../../src/worker/completion.js';
import { processDelivery } from '../../src/worker/process.js';
import { recoverExpiredLeases } from '../../src/worker/recovery.js';
import type { WebhookResponse } from '../../src/worker/http.js';
import { createTestDatabase } from '../helpers/database.js';

describe('Durable worker leases and crash history', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let connectionString: string;
  let deliveryId: string;
  beforeEach(async () => {
    database = await createTestDatabase();
    await runMigrations(database.client);
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    connectionString = url.toString();
    // A single connection makes it impossible to hide a connection held during send.
    pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
    await database.client.query(`INSERT INTO webhook_endpoints (name, url) VALUES ('receiver', 'https://example.com/hooks')`);
    await createEventStore(pool).ingestEvent({ type: 'lease.test', payload: { test: true } });
    const rows = await database.client.query('SELECT id FROM deliveries');
    deliveryId = rows.rows[0].id;
  });
  afterEach(async () => { await pool?.end(); await database?.close(); });

  async function expire() {
    // Test-only time advancement. Production always uses the database clock.
    await database.client.query("UPDATE deliveries SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [deliveryId]);
  }

  it('commits a visible claim and releases the only pool connection during HTTP', async () => {
    let started!: () => void;
    const arrived = new Promise<void>(resolve => { started = resolve; });
    let respond!: (value: WebhookResponse) => void;
    const response = new Promise<WebhookResponse>(resolve => { respond = resolve; });
    const processing = processDelivery(pool, deliveryId, async () => { started(); return response; }, { workerId: 'worker-A' });
    try {
      await arrived;
      const row = await pool.query(`SELECT d.status, d.attempt_count, d.lease_owner, a.outcome
        FROM deliveries d JOIN delivery_attempts a ON a.id = d.active_attempt_id`);
      expect(row.rows).toEqual([{ status: 'processing', attempt_count: 1, lease_owner: 'worker-A', outcome: 'in_progress' }]);
      expect(await claimDelivery(pool, deliveryId, { workerId: 'worker-B' })).toBeNull();
    } finally { respond({ status: 200 }); }
    expect(await processing).toBe('succeeded');
    const row = await database.client.query('SELECT active_attempt_id, lease_owner, lease_expires_at FROM deliveries');
    expect(row.rows).toEqual([{ active_attempt_id: null, lease_owner: null, lease_expires_at: null }]);
  });

  it('does not recover a live lease and preserves expired attempts as abandoned', async () => {
    const claim = await claimDelivery(pool, deliveryId);
    expect(claim).not.toBeNull();
    expect(await recoverExpiredLeases(pool)).toBe(0);
    await expire();
    expect(await recoverExpiredLeases(pool, { random: () => 0.5 })).toBe(1);
    const rows = await database.client.query(`SELECT d.status, d.attempt_count, a.outcome,
      a.finished_at, a.http_status, a.error_message FROM deliveries d
      JOIN delivery_attempts a ON a.delivery_id = d.id`);
    expect(rows.rows[0]).toMatchObject({ status: 'pending', attempt_count: 1, outcome: 'abandoned', http_status: null });
    expect(rows.rows[0].finished_at).not.toBeNull();
    expect(rows.rows[0].error_message).toContain('HTTP outcome unknown');
    expect(await recoverExpiredLeases(pool)).toBe(0);
  });

  it('exhausts the budget even when a worker dies on its last attempt', async () => {
    await database.client.query('UPDATE deliveries SET max_attempts = 1');
    await claimDelivery(pool, deliveryId);
    await expire();
    expect(await recoverExpiredLeases(pool)).toBe(1);
    const rows = await database.client.query('SELECT status, attempt_count, completed_at FROM deliveries');
    expect(rows.rows[0]).toMatchObject({ status: 'dead', attempt_count: 1 });
    expect(rows.rows[0].completed_at).not.toBeNull();
    expect(await claimDelivery(pool, deliveryId)).toBeNull();
  });

  it('rejects completion after expiry even before another worker recovers it', async () => {
    const claim = (await claimDelivery(pool, deliveryId))!;
    await expire();
    expect(await completeDelivery(pool, claim, { decision: { kind: 'succeeded' }, httpStatus: 200, errorMessage: null })).toBe('lost_lease');
    const rows = await database.client.query(`SELECT d.status, a.outcome FROM deliveries d
      JOIN delivery_attempts a ON a.id = d.active_attempt_id`);
    expect(rows.rows).toEqual([{ status: 'processing', outcome: 'in_progress' }]);
    expect(await recoverExpiredLeases(pool)).toBe(1);
  });

  it('fences a late worker without changing the replacement lease or its completed result', async () => {
    let started!: () => void;
    const arrived = new Promise<void>(resolve => { started = resolve; });
    let respond!: (value: WebhookResponse) => void;
    const response = new Promise<WebhookResponse>(resolve => { respond = resolve; });
    const original = processDelivery(pool, deliveryId, async () => { started(); return response; }, { workerId: 'original' });
    let replacement;
    try {
      await arrived;
      await expire();
      await recoverExpiredLeases(pool);
      await database.client.query('UPDATE deliveries SET next_attempt_at = clock_timestamp()');
      replacement = (await claimDelivery(pool, deliveryId, { workerId: 'replacement' }))!;
    } finally { respond({ status: 200 }); }
    expect(await original).toBe('lost_lease');
    const current = await database.client.query('SELECT active_attempt_id, lease_owner, status FROM deliveries');
    expect(current.rows).toEqual([{ active_attempt_id: replacement.attemptId, lease_owner: 'replacement', status: 'processing' }]);
    expect(await completeDelivery(pool, replacement, { decision: { kind: 'succeeded' }, httpStatus: 204, errorMessage: null })).toBe('succeeded');
    const history = await database.client.query('SELECT attempt_number, outcome, http_status FROM delivery_attempts ORDER BY attempt_number');
    expect(history.rows).toEqual([{ attempt_number: 1, outcome: 'abandoned', http_status: null },
      { attempt_number: 2, outcome: 'succeeded', http_status: 204 }]);
    expect(await completeDelivery(pool, replacement, { decision: { kind: 'dead', reason: 'late' }, httpStatus: 500, errorMessage: 'late' })).toBe('lost_lease');
    const final = await database.client.query('SELECT status FROM deliveries');
    expect(final.rows).toEqual([{ status: 'succeeded' }]);
  });

  it('rolls back both claim and attempt if claim persistence fails', async () => {
    await database.client.query('ALTER TABLE deliveries ADD CONSTRAINT test_reject_claim CHECK (lease_owner IS NULL)');
    await expect(claimDelivery(pool, deliveryId)).rejects.toMatchObject({ code: '23514' });
    const rows = await database.client.query('SELECT status, attempt_count FROM deliveries');
    expect(rows.rows).toEqual([{ status: 'pending', attempt_count: 0 }]);
    const attempts = await database.client.query('SELECT count(*)::integer AS count FROM delivery_attempts');
    expect(attempts.rows[0].count).toBe(0);
  });

  it('rejects ownership pointing at another delivery\'s attempt', async () => {
    const original = (await claimDelivery(pool, deliveryId))!;
    const event = await createEventStore(pool).ingestEvent({ type: 'lease.test', payload: { other: true } });
    const row = await database.client.query('SELECT id FROM deliveries WHERE event_id = $1', [event.event.id]);
    const replacement = (await claimDelivery(pool, row.rows[0].id))!;
    await expect(database.client.query('UPDATE deliveries SET active_attempt_id = $2 WHERE id = $1',
      [replacement.deliveryId, original.attemptId])).rejects.toMatchObject({ code: '23503' });
  });

  it('recovers expired work once across concurrent recovery processes', async () => {
    await claimDelivery(pool, deliveryId);
    for (let i = 0; i < 2; i++) {
      const event = await createEventStore(pool).ingestEvent({ type: 'lease.test', payload: { index: i } });
      const row = await database.client.query('SELECT id FROM deliveries WHERE event_id = $1', [event.event.id]);
      await claimDelivery(pool, row.rows[0].id);
    }
    await database.client.query("UPDATE deliveries SET lease_expires_at = clock_timestamp() - interval '1 second'");
    const second = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
    try {
      const counts = await Promise.all([recoverExpiredLeases(pool, { batchSize: 2 }), recoverExpiredLeases(second, { batchSize: 2 })]);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(3);
      expect(counts.every(count => count <= 2)).toBe(true);
    } finally { await second.end(); }
    const history = await database.client.query("SELECT count(*)::integer AS count FROM delivery_attempts WHERE outcome = 'abandoned'");
    expect(history.rows[0].count).toBe(3);
  });

  it('recovers a committed claim after abrupt termination of a real worker process', async () => {
    const code = `
      import { Pool } from 'pg';
      import { claimDelivery } from './src/worker/claims.ts';
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      const claim = await claimDelivery(pool, process.env.TEST_DELIVERY_ID, { workerId: 'crash-test' });
      if (!claim) process.exit(2);
      console.log('CLAIM_COMMITTED');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: new URL('../../', import.meta.url), windowsHide: true,
      env: { ...process.env, DATABASE_URL: connectionString, TEST_DELIVERY_ID: deliveryId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child worker did not commit its claim')), 5000);
        let output = '';
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.includes('CLAIM_COMMITTED')) { clearTimeout(timer); resolve(); }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', () => { clearTimeout(timer); reject(new Error('Child exited before termination')); });
      });
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
      const row = await database.client.query('SELECT status, attempt_count, lease_owner FROM deliveries');
      expect(row.rows).toEqual([{ status: 'processing', attempt_count: 1, lease_owner: 'crash-test' }]);
      await expire();
      expect(await recoverExpiredLeases(pool)).toBe(1);
      await database.client.query('UPDATE deliveries SET next_attempt_at = clock_timestamp()');
      expect(await processDelivery(pool, deliveryId, async () => ({ status: 200 }))).toBe('succeeded');
      const history = await database.client.query('SELECT attempt_number, outcome FROM delivery_attempts ORDER BY attempt_number');
      expect(history.rows).toEqual([{ attempt_number: 1, outcome: 'abandoned' }, { attempt_number: 2, outcome: 'succeeded' }]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
