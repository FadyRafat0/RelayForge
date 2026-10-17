import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { loadQueueConfig } from '../../src/queue/config.js';
import { runMigrations } from '../../src/migrations.js';
import { createEventStore } from '../../src/events/store.js';
import { processDelivery } from '../../src/worker/process.js';
import { claimDelivery } from '../../src/worker/claims.js';
import { createEndpointRateLimiter } from '../../src/worker/rate-limit.js';
import { createTestDatabase } from '../helpers/database.js';

describe('Shared endpoint token buckets and worker admission', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let inspector: ReturnType<typeof createClient>;
  let first: ReturnType<typeof createEndpointRateLimiter>;
  let second: ReturnType<typeof createEndpointRateLimiter>;
  let prefix: string;
  let keys: Set<string>;
  beforeEach(async () => {
    keys = new Set();
    database = await createTestDatabase();
    await runMigrations(database.client);
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    // Admission must release this only connection before calling Redis.
    pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 1000 });
    const { redisUrl } = loadQueueConfig();
    prefix = `relayforge:test:${randomUUID()}:rate:`;
    inspector = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
    inspector.on('error', () => {});
    await inspector.connect();
    first = createEndpointRateLimiter(redisUrl, () => {}, prefix);
    second = createEndpointRateLimiter(redisUrl, () => {}, prefix);
    await first.connect();
    await second.connect();
  });
  afterEach(async () => {
    await first?.close();
    await second?.close();
    if (inspector?.isOpen) {
      if (keys?.size) await inspector.del([...keys]);
      await inspector.close();
    }
    await pool?.end();
    await database?.close();
  });
  function key(id: string) { const value = prefix + id.toLowerCase(); keys.add(value); return value; }
  async function redisNow() {
    const time = await inspector.sendCommand(['TIME']) as string[];
    return Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
  }
  async function freeze(id: string, tokens: number) {
    // Test-only state seeding prevents wall-time refill during concurrency assertions.
    await inspector.hSet(key(id), { tokens: String(tokens), updated_at: String(await redisNow() + 10000) });
  }
  async function delivery() {
    const endpoint = await database.client.query<{ id: string }>(`INSERT INTO webhook_endpoints
      (name, url, rate_limit_per_second) VALUES ('limited', 'https://example.com/hooks', 1) RETURNING id`);
    const endpointId = endpoint.rows[0]!.id;
    key(endpointId);
    const event = await createEventStore(pool).ingestEvent({ type: 'rate.demo', payload: {} });
    const selected = await database.client.query<{ id: string }>(
      'SELECT id FROM deliveries WHERE event_id = $1 AND endpoint_id = $2', [event.event.id, endpointId]);
    return { id: selected.rows[0]!.id, endpointId };
  }
  async function state(id: string) {
    const result = await database.client.query(`SELECT status, attempt_count, active_attempt_id,
      next_attempt_at > clock_timestamp() AS delayed, last_enqueued_at, last_stream_id,
      (SELECT count(*)::integer FROM delivery_attempts WHERE delivery_id = d.id) AS attempts
      FROM deliveries d WHERE id = $1`, [id]);
    return result.rows[0];
  }

  it('atomically shares one burst budget between independent Redis clients', async () => {
    const id = randomUUID();
    await freeze(id, 1);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).acquire(id, 1)));
    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(results.filter(result => !result.allowed)).toHaveLength(19);
    for (const result of results) if (!result.allowed) expect(result.retryAfterMs).toBe(1000);
    expect(await inspector.pTTL(key(id))).toBeGreaterThan(0);
    expect(await inspector.pTTL(key(id))).toBeLessThanOrEqual(2000);
  });
  it('allows a new bucket burst and isolates different endpoint IDs', async () => {
    const a = randomUUID(), b = randomUUID();
    key(a); key(b);
    expect(await first.acquire(a, 2)).toEqual({ allowed: true });
    expect(await inspector.hGet(key(a), 'tokens')).toBe('1');
    await freeze(a, 1);
    expect(await second.acquire(a, 2)).toEqual({ allowed: true });
    expect((await first.acquire(a, 2)).allowed).toBe(false);
    expect(await second.acquire(b, 1)).toEqual({ allowed: true });
  });
  it('refills elapsed capacity and caps it at one burst without worker clock input', async () => {
    const id = randomUUID();
    await inspector.hSet(key(id), { tokens: '0', updated_at: String(await redisNow() - 60000) });
    expect(await first.acquire(id, 1)).toEqual({ allowed: true });
    expect(await inspector.hGet(key(id), 'tokens')).toBe('0');
    await freeze(id, 0);
    expect((await second.acquire(id, 1)).allowed).toBe(false);
  });
  it('clamps retained tokens when a lower rate is configured', async () => {
    const id = randomUUID();
    await freeze(id, 1000);
    expect(await first.acquire(id, 1)).toEqual({ allowed: true });
    expect(await second.acquire(id, 1)).toEqual({ allowed: false, retryAfterMs: 1000 });
  });
  it('returns the time needed for fractional token refill', async () => {
    const id = randomUUID();
    await freeze(id, 0.5);
    expect(await first.acquire(id, 2)).toEqual({ allowed: false, retryAfterMs: 250 });
  });
  it('schedules a denied delivery without an attempt or lease, then sends once capacity is available', async () => {
    const { id, endpointId } = await delivery();
    await freeze(endpointId, 0);
    await database.client.query("UPDATE deliveries SET last_enqueued_at = now(), last_stream_id = '123-0' WHERE id = $1", [id]);
    const send = vi.fn(async () => ({ status: 200 }));
    expect(await processDelivery(pool, id, send, { rateLimiter: first })).toBe('rate_limited');
    expect(send).not.toHaveBeenCalled();
    expect(await state(id)).toEqual({ status: 'pending', attempt_count: 0, active_attempt_id: null,
      delayed: true, last_enqueued_at: null, last_stream_id: null, attempts: 0 });
    await database.client.query('UPDATE deliveries SET next_attempt_at = clock_timestamp() WHERE id = $1', [id]);
    await inspector.hSet(key(endpointId), { tokens: '0', updated_at: String(await redisNow() - 1000) });
    expect(await processDelivery(pool, id, send, { rateLimiter: second })).toBe('succeeded');
    expect(send).toHaveBeenCalledOnce();
    expect((await state(id)).attempt_count).toBe(1);
  });
  it('releases the PostgreSQL connection during Redis admission and skips completed jobs before consulting Redis', async () => {
    const { id } = await delivery();
    const acquire = vi.fn(async () => {
      await pool.query('SELECT 1');
      return { allowed: true as const };
    });
    const send = vi.fn(async () => ({ status: 200 }));
    expect(await processDelivery(pool, id, send, { rateLimiter: { acquire } })).toBe('succeeded');
    expect(await processDelivery(pool, id, send, { rateLimiter: { acquire } })).toBe('skipped');
    expect(acquire).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });
  it.each(['disabled', 'not-due', 'leased'])('skips %s deliveries without consulting Redis', async condition => {
    const { id, endpointId } = await delivery();
    if (condition === 'disabled') await database.client.query('UPDATE webhook_endpoints SET enabled = false WHERE id = $1', [endpointId]);
    if (condition === 'not-due') await database.client.query("UPDATE deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = $1", [id]);
    if (condition === 'leased') expect(await claimDelivery(pool, id)).not.toBeNull();
    const acquire = vi.fn(async () => ({ allowed: true as const }));
    const send = vi.fn(async () => ({ status: 200 }));
    expect(await processDelivery(pool, id, send, { rateLimiter: { acquire } })).toBe('skipped');
    expect(acquire).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('does not bypass rate limits or consume budget if the Redis limiter is unavailable', async () => {
    const { id } = await delivery();
    await first.close();
    const send = vi.fn(async () => ({ status: 200 }));
    await expect(processDelivery(pool, id, send, { rateLimiter: first })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(await state(id)).toMatchObject({ status: 'pending', attempt_count: 0, attempts: 0, active_attempt_id: null });
  });
  it('does not overwrite retry backoff scheduled by another worker while Redis admission was pending', async () => {
    const { id } = await delivery();
    const outerSend = vi.fn(async () => ({ status: 200 }));
    const acquire = async () => {
      expect(await processDelivery(pool, id, async () => ({ status: 500 }), { random: () => 0.5 })).toBe('retry_scheduled');
      return { allowed: false as const, retryAfterMs: 1 };
    };
    expect(await processDelivery(pool, id, outerSend, { rateLimiter: { acquire } })).toBe('skipped');
    expect(outerSend).not.toHaveBeenCalled();
    const scheduled = await database.client.query(`SELECT next_attempt_at > clock_timestamp() + interval '2 seconds' AS kept
      FROM deliveries WHERE id = $1`, [id]);
    expect(scheduled.rows[0].kept).toBe(true);
    expect((await state(id)).attempt_count).toBe(1);
  });
  it('rechecks eligibility when another worker claims during admission', async () => {
    const { id } = await delivery();
    const send = vi.fn(async () => ({ status: 200 }));
    expect(await processDelivery(pool, id, send, { rateLimiter: { acquire: async () => {
      expect(await processDelivery(pool, id, async () => ({ status: 200 }))).toBe('succeeded');
      return { allowed: true };
    } } })).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
    expect((await state(id)).attempt_count).toBe(1);
  });
});
