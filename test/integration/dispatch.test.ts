import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { loadQueueConfig } from '../../src/queue/config.js';
import { createDeliveryQueue } from '../../src/queue/redis.js';
import { dispatchBatch } from '../../src/dispatch/batch.js';
import { createEventStore } from '../../src/events/store.js';
import { runMigrations } from '../../src/migrations.js';
import { createTestDatabase } from '../helpers/database.js';
import { claimDelivery } from '../../src/worker/claims.js';

describe('PostgreSQL to Redis Streams dispatch', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let queue: ReturnType<typeof createDeliveryQueue>;
  let inspector: ReturnType<typeof createClient>;
  let stream: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    await runMigrations(database.client);
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    pool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 2000 });
    stream = `relayforge:test:${randomUUID()}`;
    const { redisUrl } = loadQueueConfig();
    queue = createDeliveryQueue(redisUrl, () => {}, stream);
    await queue.connect();
    inspector = createClient({ url: redisUrl, socket: { connectTimeout: 2000, reconnectStrategy: false } });
    inspector.on('error', () => {});
    await inspector.connect();
  });
  afterEach(async () => {
    await queue?.close();
    if (inspector?.isOpen) {
      // Delete only this test's random stream, never shared application keys.
      await inspector.del(stream);
      await inspector.close();
    }
    await pool?.end();
    await database?.close();
  });

  async function seed(count: number): Promise<string[]> {
    await database.client.query(`INSERT INTO webhook_endpoints (name, url)
      VALUES ('receiver', 'https://example.com/hooks')`);
    for (let i = 0; i < count; i++) {
      await createEventStore(pool).ingestEvent({ type: 'test.event', payload: { index: i } });
    }
    const result = await database.client.query<{ id: string }>('SELECT id FROM deliveries ORDER BY created_at, id');
    return result.rows.map(row => row.id);
  }

  it('publishes delivery IDs and records markers without creating attempts', async () => {
    const ids = await seed(2);
    expect(await dispatchBatch(pool, queue)).toBe(2);
    const entries = (await inspector.xRange(stream, '-', '+')) ?? [];
    expect(entries.map(entry => entry.message.delivery_id).sort()).toEqual([...ids].sort());
    expect(entries.every(entry => Object.keys(entry.message).length === 1)).toBe(true);
    const rows = await database.client.query('SELECT status, last_enqueued_at, last_stream_id FROM deliveries');
    expect(rows.rows.every(row => row.status === 'pending' && row.last_enqueued_at !== null &&
      entries.some(entry => entry.id === row.last_stream_id))).toBe(true);
    expect(await dispatchBatch(pool, queue)).toBe(0);
    const attempts = await database.client.query('SELECT count(*)::integer AS count FROM delivery_attempts');
    expect(attempts.rows[0].count).toBe(0);
  });

  it('selects only due pending work that was not recently enqueued', async () => {
    const ids = await seed(6);
    await database.client.query("UPDATE deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = $1", [ids[0]]);
    await claimDelivery(pool, ids[1]!);
    await database.client.query("UPDATE deliveries SET status = 'succeeded', completed_at = now() WHERE id = $1", [ids[2]]);
    await database.client.query("UPDATE deliveries SET last_enqueued_at = now(), last_stream_id = '1-0' WHERE id = $1", [ids[3]]);
    await database.client.query("UPDATE deliveries SET status = 'dead', completed_at = now() WHERE id = $1", [ids[4]]);
    expect(await dispatchBatch(pool, queue)).toBe(1);
    const entries = (await inspector.xRange(stream, '-', '+')) ?? [];
    expect(entries.map(entry => entry.message.delivery_id)).toEqual([ids[5]]);
  });

  it('lets concurrent dispatchers claim disjoint bounded batches', async () => {
    await seed(4);
    const counts = await Promise.all([
      dispatchBatch(pool, queue, { batchSize: 2 }),
      dispatchBatch(pool, queue, { batchSize: 2 }),
    ]);
    expect(counts).toEqual([2, 2]);
    const entries = (await inspector.xRange(stream, '-', '+')) ?? [];
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map(entry => entry.message.delivery_id)).size).toBe(4);
  });

  it('leaves work retryable when Redis rejects publication', async () => {
    await seed(1);
    await inspector.set(stream, 'deliberate-wrong-type');
    await expect(dispatchBatch(pool, queue)).rejects.toThrow('WRONGTYPE');
    const rows = await database.client.query('SELECT last_enqueued_at, last_stream_id FROM deliveries');
    expect(rows.rows).toEqual([{ last_enqueued_at: null, last_stream_id: null }]);
    await inspector.del(stream);
    expect(await dispatchBatch(pool, queue)).toBe(1);
  });

  it('retries after a lost Redis acknowledgement with a duplicate job and stable delivery ID', async () => {
    const ids = await seed(1);
    const lostAck = {
      async publish(id: string): Promise<string> {
        await queue.publish(id);
        throw new Error('simulated lost acknowledgement');
      },
    };
    await expect(dispatchBatch(pool, lostAck)).rejects.toThrow('lost acknowledgement');
    expect(await dispatchBatch(pool, queue)).toBe(1);
    const entries = (await inspector.xRange(stream, '-', '+')) ?? [];
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.message.delivery_id)).toEqual([ids[0], ids[0]]);
    expect(entries[0]!.id).not.toBe(entries[1]!.id);
  });

  it('recovers when PostgreSQL marking fails after Redis accepts a job', async () => {
    await seed(1);
    await database.client.query(`ALTER TABLE deliveries ADD CONSTRAINT test_block_marker
      CHECK (last_enqueued_at IS NULL)`);
    await expect(dispatchBatch(pool, queue)).rejects.toMatchObject({ code: '23514' });
    expect(await inspector.xLen(stream)).toBe(1);
    const rows = await database.client.query('SELECT last_enqueued_at FROM deliveries');
    expect(rows.rows).toEqual([{ last_enqueued_at: null }]);
    await database.client.query('ALTER TABLE deliveries DROP CONSTRAINT test_block_marker');
    expect(await dispatchBatch(pool, queue)).toBe(1);
    expect(await inspector.xLen(stream)).toBe(2);
  });

  it('rebuilds a lost stream from stale pending database records', async () => {
    const ids = await seed(1);
    expect(await dispatchBatch(pool, queue)).toBe(1);
    await inspector.del(stream);
    expect(await dispatchBatch(pool, queue)).toBe(0);
    // Advance eligibility without making the test sleep for a minute.
    await database.client.query("UPDATE deliveries SET last_enqueued_at = now() - interval '61 seconds'");
    expect(await dispatchBatch(pool, queue)).toBe(1);
    const entries = (await inspector.xRange(stream, '-', '+')) ?? [];
    expect(entries.map(entry => entry.message.delivery_id)).toEqual(ids);
  });

  it('skips locked work instead of blocking behind another dispatcher', async () => {
    await seed(1);
    await database.client.query('BEGIN');
    await database.client.query('SELECT id FROM deliveries FOR UPDATE');
    try {
      expect(await dispatchBatch(pool, queue)).toBe(0);
    } finally {
      await database.client.query('ROLLBACK');
    }
    expect(await dispatchBatch(pool, queue)).toBe(1);
  });
});
