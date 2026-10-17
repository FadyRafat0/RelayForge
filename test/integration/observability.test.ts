import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/migrations.js';
import { createEventStore } from '../../src/events/store.js';
import { processDelivery } from '../../src/worker/process.js';
import { claimDelivery } from '../../src/worker/claims.js';
import { recoverExpiredLeases } from '../../src/worker/recovery.js';
import type { DeliveryLogEvent } from '../../src/observability/events.js';
import { createTestDatabase } from '../helpers/database.js';

function sample(text: string, name: string): number {
  const line = text.split('\n').find(line => line.startsWith(name + ' '));
  if (!line) throw new Error(`Missing sample ${name}`);
  return Number(line.slice(name.length + 1));
}

describe('Database metrics and delivery trace records', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let connectionString: string;
  let endpointId: string;
  let secret: string;
  const sentinel = 'private-event-payload-sentinel';
  beforeEach(async () => {
    database = await createTestDatabase();
    await runMigrations(database.client);
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    connectionString = url.toString();
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 2000 });
    app = buildApp({ ...loadConfig(), logLevel: 'silent', databaseUrl: connectionString });
    const inserted = await database.client.query(`INSERT INTO webhook_endpoints (name, url, event_types)
      VALUES ('observed receiver', 'https://example.com/hooks', ARRAY['telemetry.demo']) RETURNING id, signing_secret`);
    endpointId = inserted.rows[0].id; secret = inserted.rows[0].signing_secret;
  });
  afterEach(async () => { await app?.close(); await pool?.end(); await database?.close(); });
  async function delivery(type = 'telemetry.demo') {
    const accepted = await createEventStore(pool).ingestEvent({ type, payload: { customer: sentinel } });
    const rows = await database.client.query('SELECT id FROM deliveries WHERE event_id = $1', [accepted.event.id]);
    return rows.rows[0].id as string;
  }
  async function scrape() {
    const response = await app.inject('/metrics');
    expect(response.statusCode).toBe(200);
    return response.body;
  }
  async function makeDue(id: string) {
    await database.client.query('UPDATE deliveries SET next_attempt_at = clock_timestamp() WHERE id = $1', [id]);
  }
  async function expire() {
    await database.client.query("UPDATE deliveries SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE status = 'processing'");
  }

  it('exports zero values for an empty schema and retains counts across app restarts', async () => {
    const empty = await scrape();
    expect(sample(empty, 'relayforge_deliveries{status="pending"}')).toBe(0);
    expect(sample(empty, 'relayforge_oldest_due_delivery_lag_seconds')).toBe(0);
    await delivery();
    await app.close();
    app = buildApp({ ...loadConfig(), logLevel: 'silent', databaseUrl: connectionString });
    expect(sample(await scrape(), 'relayforge_deliveries{status="pending"}')).toBe(1);
  });
  it('measures eligible due-work lag, excluding future schedules and disabled endpoints', async () => {
    const dueId = await delivery();
    await database.client.query("UPDATE deliveries SET next_attempt_at = clock_timestamp() - interval '60 seconds' WHERE id = $1", [dueId]);
    const future = await delivery();
    await database.client.query("UPDATE deliveries SET next_attempt_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [future]);
    const other = await database.client.query(`INSERT INTO webhook_endpoints (name, url, event_types)
      VALUES ('disabled later', 'https://example.com', ARRAY['other.demo']) RETURNING id`);
    const disabled = await delivery('other.demo');
    await database.client.query('UPDATE webhook_endpoints SET enabled = false WHERE id = $1', [other.rows[0].id]);
    await database.client.query("UPDATE deliveries SET next_attempt_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [disabled]);
    const metrics = await scrape();
    expect(sample(metrics, 'relayforge_deliveries{status="pending"}')).toBe(3);
    expect(sample(metrics, 'relayforge_deliveries_due')).toBe(1);
    expect(sample(metrics, 'relayforge_oldest_due_delivery_lag_seconds')).toBeGreaterThanOrEqual(60);
    expect(sample(metrics, 'relayforge_oldest_due_delivery_lag_seconds')).toBeLessThan(120);
    expect(metrics).not.toContain(endpointId);
    expect(metrics).not.toContain(secret);
    expect(metrics).not.toContain(sentinel);
  });
  it('reflects live claims, expired leases, abandoned history, retry failure, and eventual success', async () => {
    const id = await delivery();
    expect(await claimDelivery(pool, id)).not.toBeNull();
    let metrics = await scrape();
    expect(sample(metrics, 'relayforge_deliveries{status="processing"}')).toBe(1);
    expect(sample(metrics, 'relayforge_attempts{outcome="in_progress"}')).toBe(1);
    await expire();
    expect(sample(await scrape(), 'relayforge_expired_leases')).toBe(1);
    expect(await recoverExpiredLeases(pool, { random: () => 0.5 })).toBe(1);
    metrics = await scrape();
    expect(sample(metrics, 'relayforge_expired_leases')).toBe(0);
    expect(sample(metrics, 'relayforge_attempts{outcome="abandoned"}')).toBe(1);
    expect(sample(metrics, 'relayforge_deliveries_due')).toBe(0);
    await makeDue(id);
    expect(await processDelivery(pool, id, async () => ({ status: 500 }))).toBe('retry_scheduled');
    await makeDue(id);
    expect(await processDelivery(pool, id, async () => ({ status: 200 }))).toBe('succeeded');
    metrics = await scrape();
    expect(sample(metrics, 'relayforge_deliveries{status="succeeded"}')).toBe(1);
    expect(sample(metrics, 'relayforge_attempts{outcome="failed"}')).toBe(1);
    expect(sample(metrics, 'relayforge_attempts{outcome="succeeded"}')).toBe(1);
    expect(sample(metrics, 'relayforge_attempts{outcome="in_progress"}')).toBe(0);
  });
  it('updates dead and pending gauges after replay while preserving failed attempt counts', async () => {
    const id = await delivery();
    await processDelivery(pool, id, async () => ({ status: 400 }));
    expect(sample(await scrape(), 'relayforge_deliveries{status="dead"}')).toBe(1);
    const replay = await app.inject({ method: 'POST', url: `/api/deliveries/${id}/replay`,
      payload: { expected_attempt_count: 1, reason: 'Observed repair' } });
    expect(replay.statusCode).toBe(202);
    const metrics = await scrape();
    expect(sample(metrics, 'relayforge_deliveries{status="dead"}')).toBe(0);
    expect(sample(metrics, 'relayforge_deliveries{status="pending"}')).toBe(1);
    expect(sample(metrics, 'relayforge_attempts{outcome="failed"}')).toBe(1);
    expect(sample(metrics, 'relayforge_delivery_replays')).toBe(1);
  });
  it('records retry and success context with measured durations and no secret or event payload', async () => {
    const id = await delivery();
    const events: DeliveryLogEvent[] = [];
    const options = { workerId: 'observed-worker', onEvent: (event: DeliveryLogEvent) => events.push(event), random: () => 0.5 };
    expect(await processDelivery(pool, id, async () => ({ status: 500 }), options)).toBe('retry_scheduled');
    expect(events).toContainEqual(expect.objectContaining({ event: 'delivery.processed', delivery_id: id,
      worker_id: 'observed-worker', endpoint_id: endpointId, attempt_number: 1, attempt_id: expect.any(String),
      event_id: expect.any(String), http_status: 500, outcome: 'retry_scheduled', reason: 'transient_failure',
      retry_delay_ms: 3750, duration_ms: expect.any(Number), http_duration_ms: expect.any(Number) }));
    await makeDue(id);
    await processDelivery(pool, id, async () => ({ status: 200 }), options);
    expect(events).toContainEqual(expect.objectContaining({ event: 'delivery.processed', attempt_number: 2,
      outcome: 'succeeded', http_status: 200 }));
    for (const event of events.filter(event => event.event === 'delivery.processed')) {
      expect(event.duration_ms).toBeGreaterThanOrEqual(event.http_duration_ms!);
      expect(event.http_duration_ms).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });
  it('does not log committed success when database completion fails', async () => {
    const id = await delivery();
    const events: DeliveryLogEvent[] = [];
    await database.client.query("ALTER TABLE deliveries ADD CONSTRAINT reject_success CHECK (status <> 'succeeded')");
    await expect(processDelivery(pool, id, async () => ({ status: 200 }), { onEvent: event => events.push(event) }))
      .rejects.toMatchObject({ code: '23514' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'delivery.processing_failed', delivery_id: id,
      attempt_number: 1, error_code: '23514' }));
    expect(events.some(event => event.event === 'delivery.processed')).toBe(false);
    expect(sample(await scrape(), 'relayforge_deliveries{status="processing"}')).toBe(1);
  });
  it('does not report a stale HTTP result as an applied retry after losing the lease', async () => {
    const id = await delivery();
    const events: DeliveryLogEvent[] = [];
    expect(await processDelivery(pool, id, async () => {
      await expire(); await recoverExpiredLeases(pool); return { status: 500 };
    }, { onEvent: event => events.push(event) })).toBe('lost_lease');
    const result = events.find(event => event.event === 'delivery.processed')!;
    expect(result.outcome).toBe('lost_lease');
    expect(result.retry_delay_ms).toBeUndefined();
    expect(sample(await scrape(), 'relayforge_attempts{outcome="abandoned"}')).toBe(1);
  });
  it('logs rate-limited work without an attempt and ignores a failing delivery observer', async () => {
    const id = await delivery();
    const events: DeliveryLogEvent[] = [];
    const send = vi.fn(async () => ({ status: 200 }));
    expect(await processDelivery(pool, id, send, { onEvent: event => events.push(event),
      rateLimiter: { acquire: async () => ({ allowed: false, retryAfterMs: 1000 }) } })).toBe('rate_limited');
    expect(send).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ event: 'delivery.processed', outcome: 'rate_limited' })]);
    expect(events[0]!.attempt_id).toBeUndefined();
    await makeDue(id);
    expect(await processDelivery(pool, id, send, { onEvent: () => { throw new Error('Log sink failed'); } })).toBe('succeeded');
    expect(sample(await scrape(), 'relayforge_deliveries{status="succeeded"}')).toBe(1);
  });
  it('returns 503 rather than zero metrics if migration-dependent tables are unavailable', async () => {
    await database.client.query('ALTER TABLE delivery_replays RENAME TO temporarily_unavailable_replays');
    expect((await app.inject('/health')).statusCode).toBe(200);
    const response = await app.inject('/metrics');
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('relayforge_deliveries');
    expect(response.body).not.toContain('delivery_replays');
  });
});
