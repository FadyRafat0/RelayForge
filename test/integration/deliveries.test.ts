import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createEventStore } from '../../src/events/store.js';
import { runMigrations } from '../../src/migrations.js';
import { claimDelivery } from '../../src/worker/claims.js';
import { processDelivery } from '../../src/worker/process.js';
import { createTestDatabase } from '../helpers/database.js';

describe('Delivery inspection and manual replay with PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let id: string;
  const input = { expected_attempt_count: 1, additional_attempts: 2, reason: 'Fixed receiver configuration' };
  beforeEach(async () => {
    database = await createTestDatabase();
    await runMigrations(database.client);
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    pool = new Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 2000 });
    app = buildApp({ ...loadConfig(), logLevel: 'silent', databaseUrl: url.toString() });
    await database.client.query(`INSERT INTO webhook_endpoints (name, url) VALUES ('receiver', 'https://example.com/hooks')`);
    await createEventStore(pool).ingestEvent({ type: 'replay.demo', payload: { amount: 100 }, idempotency_key: 'original-event' });
    id = (await database.client.query('SELECT id FROM deliveries')).rows[0].id;
    expect(await processDelivery(pool, id, async () => ({ status: 400 }))).toBe('dead');
  });
  afterEach(async () => { await app?.close(); await pool?.end(); await database?.close(); });
  function replay(body = input, deliveryId = id) {
    return app.inject({ method: 'POST', url: `/api/deliveries/${deliveryId}/replay`, payload: body });
  }
  async function auditCount() {
    return (await database.client.query('SELECT count(*)::integer AS count FROM delivery_replays')).rows[0].count;
  }

  it('inspects the terminal failure and exposes no payload or endpoint secret', async () => {
    const response = await app.inject(`/api/deliveries/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().delivery).toMatchObject({ id, status: 'dead', attempt_count: 1,
      endpoint_enabled: true, event_type: 'replay.demo', last_replay: null,
      last_attempt: { attempt_number: 1, outcome: 'failed', http_status: 400 } });
    expect(response.json().delivery.last_attempt.error_message).toContain('permanent_http_response');
    expect(response.body).not.toContain('signing_secret');
    expect(response.body).not.toContain('amount');
  });
  it('preserves IDs and attempts, resets queue hints, and commits an audit row with a bounded new budget', async () => {
    await database.client.query("UPDATE deliveries SET last_enqueued_at = now(), last_stream_id = '123-0'");
    const before = (await database.client.query('SELECT event_id, endpoint_id FROM deliveries')).rows[0];
    const response = await replay();
    expect(response.statusCode).toBe(202);
    expect(response.json().delivery).toMatchObject({ id, ...before, status: 'pending',
      attempt_count: 1, max_attempts: 3, completed_at: null });
    expect(response.json().replay).toMatchObject({ reason: input.reason, previous_attempt_count: 1,
      previous_max_attempts: 5, additional_attempts: 2 });
    const row = (await database.client.query(`SELECT next_attempt_at <= clock_timestamp() AS due,
      last_enqueued_at, last_stream_id, active_attempt_id FROM deliveries`)).rows[0];
    expect(row).toEqual({ due: true, last_enqueued_at: null, last_stream_id: null, active_attempt_id: null });
    expect(await auditCount()).toBe(1);
    expect((await app.inject('/api/deliveries/dead')).json().deliveries).toEqual([]);
    const original = await createEventStore(pool).ingestEvent({ type: 'replay.demo', payload: { amount: 100 },
      idempotency_key: 'original-event' });
    expect(original.replayed).toBe(true);
    expect(original.delivery_count).toBe(1);
    const history = (await app.inject(`/api/deliveries/${id}/attempts`)).json();
    expect(history.attempts).toHaveLength(1);
    expect(history.attempts[0].attempt_number).toBe(1);
  });
  it('allows only one concurrent replay of the same dead generation', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => replay()));
    expect(responses.filter(response => response.statusCode === 202)).toHaveLength(1);
    expect(responses.filter(response => response.statusCode === 409)).toHaveLength(9);
    expect(await auditCount()).toBe(1);
    expect((await app.inject(`/api/deliveries/${id}`)).json().delivery.max_attempts).toBe(3);
  });
  it('stops again after exactly the additional attempt budget is consumed', async () => {
    expect((await replay()).statusCode).toBe(202);
    expect(await processDelivery(pool, id, async () => ({ status: 500 }), { random: () => 0.5 })).toBe('retry_scheduled');
    await database.client.query('UPDATE deliveries SET next_attempt_at = clock_timestamp()');
    expect(await processDelivery(pool, id, async () => ({ status: 500 }))).toBe('dead');
    const detail = (await app.inject(`/api/deliveries/${id}`)).json().delivery;
    expect(detail).toMatchObject({ status: 'dead', attempt_count: 3, max_attempts: 3 });
    expect(detail.last_attempt.error_message).toContain('attempt_limit_reached');
    expect((await app.inject(`/api/deliveries/${id}/attempts`)).json().attempts.map((attempt: { attempt_number: number }) => attempt.attempt_number))
      .toEqual([3, 2, 1]);
  });
  it('rejects a delayed replay from an older failure generation', async () => {
    const oneMore = { ...input, additional_attempts: 1 };
    expect((await replay(oneMore)).statusCode).toBe(202);
    expect(await processDelivery(pool, id, async () => ({ status: 500 }))).toBe('dead');
    expect((await replay(oneMore)).statusCode).toBe(409);
    expect(await auditCount()).toBe(1);
    expect((await replay({ ...oneMore, expected_attempt_count: 2 })).statusCode).toBe(202);
    expect(await auditCount()).toBe(2);
    const detail = (await app.inject(`/api/deliveries/${id}`)).json().delivery;
    expect(detail.last_replay.previous_attempt_count).toBe(2);
    expect(detail.last_attempt.attempt_number).toBe(2);
    expect((await app.inject(`/api/deliveries/${id}/attempts?limit=1&offset=1`)).json().attempts[0].attempt_number).toBe(1);
  });
  it.each(['pending', 'processing', 'succeeded'])('rejects replay while delivery is %s', async status => {
    expect((await replay()).statusCode).toBe(202);
    if (status === 'processing') expect(await claimDelivery(pool, id)).not.toBeNull();
    if (status === 'succeeded') expect(await processDelivery(pool, id, async () => ({ status: 200 }))).toBe('succeeded');
    expect((await replay()).statusCode).toBe(409);
    expect(await auditCount()).toBe(1);
  });
  it('rejects disabled endpoints and stale attempt counts without changing delivery state', async () => {
    expect((await replay({ ...input, expected_attempt_count: 0 })).statusCode).toBe(409);
    await database.client.query('UPDATE webhook_endpoints SET enabled = false');
    expect((await replay()).statusCode).toBe(409);
    expect(await auditCount()).toBe(0);
    expect((await app.inject(`/api/deliveries/${id}`)).json().delivery.status).toBe('dead');
  });
  it('guards integer overflow without recording a replay', async () => {
    await database.client.query('UPDATE deliveries SET attempt_count = 2147483647, max_attempts = 2147483647');
    expect((await replay({ ...input, expected_attempt_count: 2147483647 })).statusCode).toBe(409);
    expect(await auditCount()).toBe(0);
  });
  it.each(['audit', 'delivery'])('rolls back both state and audit when the %s write fails', async failure => {
    if (failure === 'audit') {
      await database.client.query('ALTER TABLE delivery_replays ADD CONSTRAINT test_reject_audit CHECK (false)');
    } else {
      await database.client.query("ALTER TABLE deliveries ADD CONSTRAINT test_reject_replay CHECK (status <> 'pending')");
    }
    expect((await replay()).statusCode).toBe(500);
    expect(await auditCount()).toBe(0);
    const row = (await database.client.query('SELECT status, attempt_count, max_attempts, completed_at FROM deliveries')).rows[0];
    expect(row).toMatchObject({ status: 'dead', attempt_count: 1, max_attempts: 5 });
    expect(row.completed_at).not.toBeNull();
  });
  it('returns 404 for nonexistent deliveries', async () => {
    const missing = randomUUID();
    expect((await app.inject(`/api/deliveries/${missing}`)).statusCode).toBe(404);
    expect((await app.inject(`/api/deliveries/${missing}/attempts`)).statusCode).toBe(404);
    expect((await replay(input, missing)).statusCode).toBe(404);
  });
  it('paginates dead deliveries in stable newest-first order and excludes pending ones', async () => {
    for (let i = 0; i < 2; i++) {
      const event = await createEventStore(pool).ingestEvent({ type: 'replay.demo', payload: { index: i } });
      const deliveryId = (await database.client.query('SELECT id FROM deliveries WHERE event_id = $1', [event.event.id])).rows[0].id;
      await processDelivery(pool, deliveryId, async () => ({ status: 400 }));
    }
    await createEventStore(pool).ingestEvent({ type: 'replay.demo', payload: { pending: true } });
    await database.client.query("UPDATE deliveries SET completed_at = '2026-01-01T00:00:00Z' WHERE status = 'dead'");
    const expected = (await database.client.query("SELECT id FROM deliveries WHERE status = 'dead' ORDER BY id DESC"))
      .rows.map(row => row.id);
    expect((await app.inject('/api/deliveries/dead?limit=2')).json().deliveries.map((row: { id: string }) => row.id))
      .toEqual(expected.slice(0, 2));
    expect((await app.inject('/api/deliveries/dead?limit=2&offset=2')).json().deliveries.map((row: { id: string }) => row.id))
      .toEqual(expected.slice(2));
  });
});
