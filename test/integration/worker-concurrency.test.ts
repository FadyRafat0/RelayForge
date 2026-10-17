import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { loadQueueConfig } from '../../src/queue/config.js';
import { runMigrations } from '../../src/migrations.js';
import { createEventStore } from '../../src/events/store.js';
import { dispatchBatch } from '../../src/dispatch/batch.js';
import { createDeliveryQueue, createDeliveryConsumer } from '../../src/queue/redis.js';
import { createEndpointRateLimiter } from '../../src/worker/rate-limit.js';
import { processDelivery } from '../../src/worker/process.js';
import { sendWebhook } from '../../src/worker/http.js';
import { runWorker, type WorkerOutcome } from '../../src/worker/run.js';
import { verifyWebhook } from '../../src/webhooks/signatures.js';
import { createTestDatabase } from '../helpers/database.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe('Bounded concurrent workers with PostgreSQL, Redis, and signed HTTP', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let publisher: ReturnType<typeof createDeliveryQueue>;
  let queue: ReturnType<typeof createDeliveryConsumer>;
  let limiter: ReturnType<typeof createEndpointRateLimiter>;
  let inspector: ReturnType<typeof createClient>;
  let server: Server | undefined;
  let stream: string, ratePrefix: string, endpointId: string;
  let stop: AbortController;
  let running: Promise<void> | undefined;
  let responses: ServerResponse[], arrivals: ReturnType<typeof deferred>[];
  let activeHttp: number, maxActiveHttp: number;
  const group = 'concurrency-workers';

  beforeEach(async () => {
    server = undefined; running = undefined; endpointId = '';
    responses = []; arrivals = Array.from({ length: 10 }, deferred);
    activeHttp = 0; maxActiveHttp = 0; stop = new AbortController();
    database = await createTestDatabase();
    await runMigrations(database.client);
    const dbUrl = new URL(loadConfig().databaseUrl);
    dbUrl.searchParams.set('options', `-c search_path=${database.schema}`);
    pool = new Pool({ connectionString: dbUrl.toString(), max: 2, connectionTimeoutMillis: 2000 });
    const { redisUrl } = loadQueueConfig();
    stream = `relayforge:test:${randomUUID()}`;
    ratePrefix = `${stream}:rate:`;
    publisher = createDeliveryQueue(redisUrl, () => {}, stream);
    queue = createDeliveryConsumer(redisUrl, () => {}, stream, group);
    limiter = createEndpointRateLimiter(redisUrl, () => {}, ratePrefix);
    inspector = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
    inspector.on('error', () => {});
    await publisher.connect(); await limiter.connect(); await inspector.connect();
  });
  afterEach(async () => {
    stop.abort();
    server?.closeAllConnections();
    await running?.catch(() => {});
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await queue?.close(); await publisher?.close(); await limiter?.close();
    if (inspector?.isOpen) {
      await inspector.del(stream);
      if (endpointId) await inspector.del(ratePrefix + endpointId);
      await inspector.close();
    }
    await pool?.end(); await database?.close();
  });

  async function prepare(count: number, rate = 1000) {
    let secret = '';
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const signature = request.headers['x-relayforge-signature'];
        const deliveryId = request.headers['x-relayforge-delivery-id'];
        if (typeof signature !== 'string' || typeof deliveryId !== 'string'
          || !verifyWebhook({ secret, body: Buffer.concat(chunks), signature, deliveryId,
            attemptNumber: Number(request.headers['x-relayforge-attempt']) })) {
          response.writeHead(401).end(); return;
        }
        activeHttp++; maxActiveHttp = Math.max(maxActiveHttp, activeHttp);
        let finished = false;
        function finish() { if (!finished) { finished = true; activeHttp--; } }
        response.once('finish', finish); response.once('close', finish);
        responses.push(response);
        arrivals[responses.length - 1]!.resolve();
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing receiver port');
    const inserted = await database.client.query(`INSERT INTO webhook_endpoints (name, url, rate_limit_per_second)
      VALUES ('concurrent receiver', $1, $2) RETURNING id, signing_secret`,
    [`http://127.0.0.1:${address.port}/webhooks`, rate]);
    endpointId = inserted.rows[0].id; secret = inserted.rows[0].signing_secret;
    for (let i = 0; i < count; i++) await createEventStore(pool).ingestEvent({ type: 'concurrent.demo', payload: { i } });
    expect(await dispatchBatch(pool, publisher)).toBe(count);
    await queue.connect();
  }
  function handle(id: string) {
    return processDelivery(pool, id, request => sendWebhook(request, { allowLoopback: true, timeoutMs: 3000 }),
      { workerId: 'concurrent-worker', rateLimiter: limiter });
  }
  function reply(index: number) { responses[index]!.writeHead(200).end(); }

  it('overlaps HTTP up to two slots, reuses freed slots, and drains active deliveries on shutdown', async () => {
    await prepare(4);
    const outcomes: WorkerOutcome[] = [];
    running = runWorker(queue, 'concurrent-worker', handle,
      { concurrency: 2, signal: stop.signal, onOutcome: outcome => outcomes.push(outcome) });
    await arrivals[1]!.promise;
    expect(activeHttp).toBe(2);
    expect((await database.client.query("SELECT count(*)::integer AS count FROM deliveries WHERE status = 'processing'"))
      .rows[0].count).toBe(2);
    expect((await inspector.xPending(stream, group)).pending).toBe(2);
    reply(0);
    await arrivals[2]!.promise;
    expect(maxActiveHttp).toBe(2);
    reply(1);
    await arrivals[3]!.promise;
    stop.abort();
    reply(2); reply(3);
    await running;
    expect(maxActiveHttp).toBe(2);
    expect(outcomes).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    const rows = await database.client.query('SELECT status, attempt_count FROM deliveries');
    expect(rows.rows).toEqual(Array.from({ length: 4 }, () => ({ status: 'succeeded', attempt_count: 1 })));
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
  });

  it('stops on a failed job while its active peer completes, leaving failed and unread work recoverable', async () => {
    await prepare(3);
    const jobs = (await inspector.xRange(stream, '-', '+')) ?? [];
    const failedId = jobs[1]!.message.delivery_id;
    running = runWorker(queue, 'concurrent-worker', async id => {
      if (id === failedId) throw new Error('Injected database outage');
      return handle(id);
    }, { concurrency: 2, signal: stop.signal });
    const failed = expect(running).rejects.toThrow('Injected database outage');
    await arrivals[0]!.promise;
    expect((await inspector.xPending(stream, group)).pending).toBe(2);
    reply(0);
    await failed;
    expect(responses).toHaveLength(1);
    expect((await inspector.xPending(stream, group)).pending).toBe(1);
    const unread = await queue.read('replacement-worker');
    expect(unread?.deliveryId).toBe(jobs[2]!.message.delivery_id);
    const rows = await database.client.query('SELECT status, attempt_count FROM deliveries ORDER BY attempt_count DESC');
    expect(rows.rows).toEqual([{ status: 'succeeded', attempt_count: 1 },
      { status: 'pending', attempt_count: 0 }, { status: 'pending', attempt_count: 0 }]);
  });

  it('keeps the shared endpoint quota when several jobs run concurrently', async () => {
    await prepare(4, 1);
    const time = await inspector.sendCommand(['TIME']) as string[];
    // Freeze this owned bucket's refill while checking concurrent admission, without sleeping.
    await inspector.hSet(ratePrefix + endpointId, { tokens: '1',
      updated_at: String(Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000) + 10000) });
    let denied = 0;
    const allDenied = deferred();
    running = runWorker(queue, 'concurrent-worker', handle,
      { concurrency: 4, signal: stop.signal, onOutcome(outcome) {
        if (outcome === 'rate_limited' && ++denied === 3) { stop.abort(); allDenied.resolve(); }
      } });
    await Promise.all([arrivals[0]!.promise, allDenied.promise]);
    expect(responses).toHaveLength(1);
    reply(0);
    await running;
    const rows = await database.client.query('SELECT status, attempt_count FROM deliveries ORDER BY attempt_count DESC');
    expect(rows.rows).toEqual([{ status: 'succeeded', attempt_count: 1 },
      ...Array.from({ length: 3 }, () => ({ status: 'pending', attempt_count: 0 }))]);
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
  });

  it('does not send duplicate logical deliveries when many duplicate stream jobs overlap', async () => {
    await prepare(1);
    const id = (await database.client.query('SELECT id FROM deliveries')).rows[0].id;
    for (let i = 0; i < 9; i++) await publisher.publish(id);
    let skipped = 0;
    const allSkipped = deferred();
    running = runWorker(queue, 'concurrent-worker', handle,
      { concurrency: 4, signal: stop.signal, onOutcome(outcome) {
        if (outcome === 'skipped' && ++skipped === 9) { stop.abort(); allSkipped.resolve(); }
      } });
    await Promise.all([arrivals[0]!.promise, allSkipped.promise]);
    expect(responses).toHaveLength(1);
    reply(0);
    await running;
    expect((await database.client.query('SELECT count(*)::integer AS count FROM delivery_attempts')).rows[0].count).toBe(1);
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
  });
});
