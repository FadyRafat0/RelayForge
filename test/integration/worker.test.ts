import { randomUUID } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { loadQueueConfig } from '../../src/queue/config.js';
import { createDeliveryQueue, createDeliveryConsumer } from '../../src/queue/redis.js';
import { dispatchBatch } from '../../src/dispatch/batch.js';
import { createEventStore } from '../../src/events/store.js';
import { processDelivery } from '../../src/worker/process.js';
import { sendWebhook } from '../../src/worker/http.js';
import { consumeOne } from '../../src/worker/consume.js';
import { runMigrations } from '../../src/migrations.js';
import { createTestDatabase } from '../helpers/database.js';
import { createChaosReceiver } from '../../src/receiver/app.js';
import { recoverExpiredLeases } from '../../src/worker/recovery.js';
import { buildApp } from '../../src/app.js';
import { createReceiverInbox } from '../../src/receiver/inbox.js';

describe('HTTP worker with PostgreSQL and Redis', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let publisher: ReturnType<typeof createDeliveryQueue>;
  let queue: ReturnType<typeof createDeliveryConsumer>;
  let inspector: ReturnType<typeof createClient>;
  let server: Server | undefined;
  let stream: string;
  const group = 'integration-workers';

  beforeEach(async () => {
    server = undefined;
    database = await createTestDatabase();
    await runMigrations(database.client);
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    pool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 2000 });
    const { redisUrl } = loadQueueConfig();
    stream = `relayforge:test:${randomUUID()}`;
    publisher = createDeliveryQueue(redisUrl, () => {}, stream);
    queue = createDeliveryConsumer(redisUrl, () => {}, stream, group);
    await publisher.connect();
    inspector = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
    inspector.on('error', () => {});
    await inspector.connect();
  });
  afterEach(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
    await queue?.close();
    await publisher?.close();
    if (inspector?.isOpen) { await inspector.del(stream); await inspector.close(); }
    await pool?.end();
    await database?.close();
  });

  async function prepare(handler: RequestListener | Server, path = '/webhooks', endpointId?: string) {
    server = typeof handler === 'function' ? createServer(handler) : handler;
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Receiver has no port');
    const receiverUrl = `http://127.0.0.1:${address.port}${path}`;
    if (endpointId) {
      await database.client.query('UPDATE webhook_endpoints SET url = $1 WHERE id = $2', [receiverUrl, endpointId]);
    } else {
      await database.client.query(`INSERT INTO webhook_endpoints (name, url)
        VALUES ('receiver', $1)`, [receiverUrl]);
    }
    const accepted = await createEventStore(pool).ingestEvent({ type: 'payment.succeeded', payload: { amount: 100 } });
    const rows = await database.client.query<{ id: string }>('SELECT id FROM deliveries WHERE event_id = $1', [accepted.event.id]);
    await dispatchBatch(pool, publisher);
    // Connect after publication to verify that group creation includes backlog.
    await queue.connect();
    return { deliveryId: rows.rows[0]!.id, eventId: accepted.event.id };
  }
  function run(consumer = 'worker-1') {
    return consumeOne(queue, consumer, id => processDelivery(pool, id,
      request => sendWebhook(request, { allowLoopback: true, timeoutMs: 2000 }), { random: () => 0.5 }));
  }

  it('waits for a publisher row lock instead of acknowledging an unclaimed delivery', async () => {
    let calls = 0;
    const { deliveryId } = await prepare((_request, response) => { calls++; response.end(); });
    const pid = (await database.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await database.client.query('BEGIN');
    // Reproduce the lock held between Redis publication and dispatcher commit.
    await database.client.query('SELECT id FROM deliveries WHERE id = $1 FOR UPDATE', [deliveryId]);
    const processing = run();
    try {
      await vi.waitFor(async () => {
        const waiting = await database.client.query(`SELECT count(*)::integer AS count
          FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
        expect(waiting.rows[0].count).toBe(1);
      }, { timeout: 2000, interval: 10 });
      expect(calls).toBe(0);
      expect((await inspector.xPending(stream, group)).pending).toBe(1);
    } finally {
      await database.client.query('COMMIT');
      await processing;
    }
    expect(await processing).toBe('succeeded');
    expect(calls).toBe(1);
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
  });

  it('acknowledges a rate-limited job only after persisting its delay without sending HTTP', async () => {
    let calls = 0;
    await prepare((_request, response) => { calls++; response.end(); });
    const result = await consumeOne(queue, 'limited-worker', id => processDelivery(pool, id,
      request => sendWebhook(request, { allowLoopback: true }),
      { rateLimiter: { acquire: async () => ({ allowed: false, retryAfterMs: 1000 }) } }));
    expect(result).toBe('rate_limited');
    expect(calls).toBe(0);
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
    const row = (await database.client.query(`SELECT status, attempt_count, active_attempt_id,
      next_attempt_at > clock_timestamp() AS delayed, last_enqueued_at FROM deliveries`)).rows[0];
    expect(row).toEqual({ status: 'pending', attempt_count: 0, active_attempt_id: null, delayed: true, last_enqueued_at: null });
    expect(await dispatchBatch(pool, publisher)).toBe(0);
  });

  it('leaves jobs unacknowledged if limiter access or delay persistence fails', async () => {
    let calls = 0;
    await prepare((_request, response) => { calls++; response.end(); });
    const send = (request: Parameters<typeof sendWebhook>[0]) => sendWebhook(request, { allowLoopback: true });
    await expect(consumeOne(queue, 'limiter-unavailable', id => processDelivery(pool, id, send,
      { rateLimiter: { acquire: async () => { throw new Error('Limiter unavailable'); } } }))).rejects.toThrow('Limiter unavailable');
    expect((await inspector.xPending(stream, group)).pending).toBe(1);
    // Make the owned stream job reclaimable without sleeping for 60 seconds.
    const jobs = (await inspector.xRange(stream, '-', '+')) ?? [];
    await inspector.sendCommand(['XCLAIM', stream, group, 'stopped-worker', '0', jobs[0]!.id, 'IDLE', '61000']);
    await database.client.query(`ALTER TABLE deliveries ADD CONSTRAINT test_reject_delay CHECK (next_attempt_at <= updated_at)`);
    await expect(consumeOne(queue, 'schedule-fails', id => processDelivery(pool, id, send,
      { rateLimiter: { acquire: async () => ({ allowed: false, retryAfterMs: 1000 }) } }))).rejects.toMatchObject({ code: '23514' });
    expect((await inspector.xPending(stream, group)).pending).toBe(1);
    expect(calls).toBe(0);
    const row = (await database.client.query('SELECT status, attempt_count FROM deliveries')).rows[0];
    expect(row).toEqual({ status: 'pending', attempt_count: 0 });
  });

  it('uses the API-issued endpoint secret through PostgreSQL, Redis, and signed HTTP retries', async () => {
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    const app = buildApp({ ...loadConfig(), logLevel: 'silent', databaseUrl: url.toString() });
    try {
      const registered = await app.inject({ method: 'POST', url: '/api/endpoints',
        payload: { name: 'Signed receiver', url: 'http://127.0.0.1:8080/webhooks' } });
      expect(registered.statusCode).toBe(201);
      const endpoint = registered.json();
      const records: number[] = [];
      await prepare(createChaosReceiver(record => records.push(record.call),
        { signingSecret: endpoint.signing_secret }), '/webhooks?mode=flaky&failures=1', endpoint.id);
      expect(await run()).toBe('retry_scheduled');
      await database.client.query('UPDATE deliveries SET next_attempt_at = now()');
      expect(await dispatchBatch(pool, publisher)).toBe(1);
      expect(await run()).toBe('succeeded');
      expect(records).toEqual([1, 2]);
      const attempts = await database.client.query('SELECT http_status FROM delivery_attempts ORDER BY attempt_number');
      expect(attempts.rows).toEqual([{ http_status: 500 }, { http_status: 200 }]);
      const messages = await inspector.xRange(stream, '-', '+');
      expect(JSON.stringify(messages)).not.toContain(endpoint.signing_secret);
      const listing = await app.inject({ method: 'GET', url: '/api/endpoints' });
      expect(listing.body).not.toContain('signing_secret');
    } finally { await app.close(); }
  });

  it('retries after lost sender completion without repeating the receiver business effect', async () => {
    const signingSecret = 'whsec_' + 'd'.repeat(64);
    const duplicateFlags: boolean[] = [];
    await prepare(createChaosReceiver(record => duplicateFlags.push(record.duplicate ?? false),
      { signingSecret, inbox: createReceiverInbox(pool, 'recovery-demo') }));
    await database.client.query('UPDATE webhook_endpoints SET signing_secret = $1', [signingSecret]);
    // Receiver commits successfully, but the sender cannot commit its completion.
    await database.client.query("ALTER TABLE deliveries ADD CONSTRAINT test_block_success CHECK (status <> 'succeeded')");
    await expect(run()).rejects.toMatchObject({ code: '23514' });
    await database.client.query('ALTER TABLE deliveries DROP CONSTRAINT test_block_success');
    await database.client.query("UPDATE deliveries SET lease_expires_at = now() - interval '1 second'");
    expect(await recoverExpiredLeases(pool)).toBe(1);
    await database.client.query('UPDATE deliveries SET next_attempt_at = now()');
    expect(await dispatchBatch(pool, publisher)).toBe(1);
    expect(await run('replacement-worker')).toBe('succeeded');
    expect(duplicateFlags).toEqual([false, true]);
    const effects = await database.client.query('SELECT count(*)::integer AS count FROM receiver_effects');
    expect(effects.rows[0].count).toBe(1);
    const attempts = await database.client.query('SELECT outcome FROM delivery_attempts ORDER BY attempt_number');
    expect(attempts.rows).toEqual([{ outcome: 'abandoned' }, { outcome: 'succeeded' }]);
  });

  it('replays a dead delivery through Redis after the receiver is repaired, retaining its identity and history', async () => {
    let healthy = false;
    const receivedIds: string[] = [];
    const { deliveryId } = await prepare((request, response) => {
      request.resume();
      receivedIds.push(String(request.headers['x-relayforge-delivery-id']));
      response.writeHead(healthy ? 200 : 400).end();
    });
    expect(await run()).toBe('dead');
    healthy = true;
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    const app = buildApp({ ...loadConfig(), logLevel: 'silent', databaseUrl: url.toString() });
    try {
      const inspected = await app.inject(`/api/deliveries/${deliveryId}`);
      expect(inspected.json().delivery.last_attempt.http_status).toBe(400);
      const replayed = await app.inject({ method: 'POST', url: `/api/deliveries/${deliveryId}/replay`,
        payload: { expected_attempt_count: 1, additional_attempts: 2, reason: 'Receiver repaired' } });
      expect(replayed.statusCode).toBe(202);
      expect(await dispatchBatch(pool, publisher)).toBe(1);
      expect(await run()).toBe('succeeded');
      expect(receivedIds).toEqual([deliveryId, deliveryId]);
      const attempts = await database.client.query('SELECT attempt_number, http_status FROM delivery_attempts ORDER BY attempt_number');
      expect(attempts.rows).toEqual([{ attempt_number: 1, http_status: 400 }, { attempt_number: 2, http_status: 200 }]);
      expect((await inspector.xPending(stream, group)).pending).toBe(0);
    } finally { await app.close(); }
  });

  it('manually replays an exhausted abandoned delivery without duplicating its committed receiver effect', async () => {
    const signingSecret = 'whsec_' + 'e'.repeat(64);
    const duplicateFlags: boolean[] = [];
    const { deliveryId } = await prepare(createChaosReceiver(record => duplicateFlags.push(record.duplicate ?? false),
      { signingSecret, inbox: createReceiverInbox(pool, 'manual-replay-demo') }));
    await database.client.query('UPDATE webhook_endpoints SET signing_secret = $1', [signingSecret]);
    await database.client.query('UPDATE deliveries SET max_attempts = 1');
    await database.client.query("ALTER TABLE deliveries ADD CONSTRAINT test_block_success CHECK (status <> 'succeeded')");
    await expect(run()).rejects.toMatchObject({ code: '23514' });
    await database.client.query('ALTER TABLE deliveries DROP CONSTRAINT test_block_success');
    await database.client.query("UPDATE deliveries SET lease_expires_at = now() - interval '1 second'");
    expect(await recoverExpiredLeases(pool)).toBe(1);
    expect((await database.client.query('SELECT status FROM deliveries')).rows[0].status).toBe('dead');
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    const app = buildApp({ ...loadConfig(), logLevel: 'silent', databaseUrl: url.toString() });
    try {
      expect((await app.inject({ method: 'POST', url: `/api/deliveries/${deliveryId}/replay`,
        payload: { expected_attempt_count: 1, additional_attempts: 1, reason: 'Resolve unknown receiver outcome' } })).statusCode).toBe(202);
      expect(await dispatchBatch(pool, publisher)).toBe(1);
      expect(await run('replacement-worker')).toBe('succeeded');
      expect(duplicateFlags).toEqual([false, true]);
      expect((await database.client.query('SELECT count(*)::integer AS count FROM receiver_effects')).rows[0].count).toBe(1);
      const attempts = await database.client.query('SELECT attempt_number, outcome FROM delivery_attempts ORDER BY attempt_number');
      expect(attempts.rows).toEqual([{ attempt_number: 1, outcome: 'abandoned' }, { attempt_number: 2, outcome: 'succeeded' }]);
      // The original unacknowledged publication is harmless once reclaimed.
      const jobs = (await inspector.xRange(stream, '-', '+')) ?? [];
      await inspector.sendCommand(['XCLAIM', stream, group, 'stopped-worker', '0', jobs[0]!.id, 'IDLE', '61000']);
      expect(await run()).toBe('skipped');
      expect((await inspector.xPending(stream, group)).pending).toBe(0);
      expect(duplicateFlags).toHaveLength(2);
    } finally { await app.close(); }
  });

  it('consumes backlog, posts JSON, commits success, and acknowledges without repeating completed jobs', async () => {
    const received: { headers: Record<string, unknown>; body: unknown }[] = [];
    const ids = await prepare((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        received.push({ headers: request.headers, body: JSON.parse(body) });
        response.writeHead(200).end('ok');
      });
    });
    expect(await run()).toBe('succeeded');
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({ id: ids.eventId, type: 'payment.succeeded', payload: { amount: 100 } });
    expect(received[0]!.headers['x-relayforge-delivery-id']).toBe(ids.deliveryId);
    const delivery = await database.client.query('SELECT status, attempt_count, completed_at FROM deliveries');
    expect(delivery.rows[0]).toMatchObject({ status: 'succeeded', attempt_count: 1 });
    expect(delivery.rows[0].completed_at).not.toBeNull();
    const attempts = await database.client.query('SELECT outcome, http_status, error_message FROM delivery_attempts');
    expect(attempts.rows).toEqual([{ outcome: 'succeeded', http_status: 200, error_message: null }]);
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
    await publisher.publish(ids.deliveryId);
    expect(await run()).toBe('skipped');
    expect(received).toHaveLength(1);
  });

  it('records an HTTP failure, schedules a retry, then preserves both attempt records after success', async () => {
    let calls = 0;
    await prepare((_request, response) => { calls++; response.writeHead(calls === 1 ? 500 : 204).end(); });
    expect(await run()).toBe('retry_scheduled');
    const waiting = await database.client.query(`SELECT status, attempt_count,
      next_attempt_at > updated_at AS delayed, last_enqueued_at FROM deliveries`);
    expect(waiting.rows).toEqual([{ status: 'pending', attempt_count: 1, delayed: true, last_enqueued_at: null }]);
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
    await database.client.query('UPDATE deliveries SET next_attempt_at = now()');
    expect(await dispatchBatch(pool, publisher)).toBe(1);
    expect(await run()).toBe('succeeded');
    const attempts = await database.client.query('SELECT attempt_number, outcome, http_status FROM delivery_attempts ORDER BY attempt_number');
    expect(attempts.rows).toEqual([{ attempt_number: 1, outcome: 'failed', http_status: 500 },
      { attempt_number: 2, outcome: 'succeeded', http_status: 204 }]);
  });

  it('marks delivery dead after its configured attempt budget is exhausted', async () => {
    await prepare((_request, response) => { response.writeHead(500).end(); });
    await database.client.query('UPDATE deliveries SET max_attempts = 1');
    expect(await run()).toBe('dead');
    const result = await database.client.query('SELECT status, attempt_count, completed_at FROM deliveries');
    expect(result.rows[0]).toMatchObject({ status: 'dead', attempt_count: 1 });
    expect(result.rows[0].completed_at).not.toBeNull();
    expect(await dispatchBatch(pool, publisher)).toBe(0);
  });

  it('records a timeout without an HTTP status', async () => {
    await prepare(() => {});
    const outcome = await consumeOne(queue, 'worker-1', id => processDelivery(pool, id,
      request => sendWebhook(request, { allowLoopback: true, timeoutMs: 50 })));
    expect(outcome).toBe('retry_scheduled');
    const result = await database.client.query('SELECT outcome, http_status, error_message FROM delivery_attempts');
    expect(result.rows[0]).toMatchObject({ outcome: 'failed', http_status: null });
    expect(result.rows[0].error_message).toMatch(/timed out|aborted/i);
  });

  it('does not send for a disabled endpoint or consume its attempt budget', async () => {
    let calls = 0;
    await prepare((_request, response) => { calls++; response.end(); });
    await database.client.query('UPDATE webhook_endpoints SET enabled = false');
    expect(await run()).toBe('skipped');
    expect(calls).toBe(0);
    const delivery = await database.client.query('SELECT status, attempt_count FROM deliveries');
    expect(delivery.rows).toEqual([{ status: 'pending', attempt_count: 0 }]);
  });

  it('skips a duplicate while the first worker owns a committed lease', async () => {
    let received!: () => void;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    let respond: (() => void) | undefined;
    const { deliveryId } = await prepare((_request, response) => {
      respond = () => response.writeHead(200).end();
      received();
    });
    await publisher.publish(deliveryId);
    const first = run('worker-1');
    try {
      await arrived;
      const visible = await database.client.query('SELECT status, attempt_count, active_attempt_id FROM deliveries');
      expect(visible.rows[0]).toMatchObject({ status: 'processing', attempt_count: 1 });
      expect(visible.rows[0].active_attempt_id).not.toBeNull();
      // The row is not locked during HTTP; NOWAIT must succeed immediately.
      await database.client.query('BEGIN');
      await database.client.query('SELECT id FROM deliveries FOR UPDATE NOWAIT');
      await database.client.query('ROLLBACK');
      expect(await run('worker-2')).toBe('skipped');
    } finally { respond?.(); }
    expect(await first).toBe('succeeded');
    const result = await database.client.query('SELECT count(*)::integer AS count FROM delivery_attempts');
    expect(result.rows[0].count).toBe(1);
  });

  it('leaves failed database work unacknowledged and reclaims it for a later attempt', async () => {
    let calls = 0;
    await prepare((_request, response) => { calls++; response.end(); });
    await database.client.query(`ALTER TABLE deliveries ADD CONSTRAINT test_block_success CHECK (status <> 'succeeded')`);
    await expect(run()).rejects.toMatchObject({ code: '23514' });
    expect(calls).toBe(1);
    const rolledBack = await database.client.query('SELECT status, attempt_count FROM deliveries');
    expect(rolledBack.rows).toEqual([{ status: 'processing', attempt_count: 1 }]);
    expect((await inspector.xPending(stream, group)).pending).toBe(1);
    await database.client.query('ALTER TABLE deliveries DROP CONSTRAINT test_block_success');
    await database.client.query("UPDATE deliveries SET lease_expires_at = now() - interval '1 second'");
    expect(await recoverExpiredLeases(pool)).toBe(1);
    await database.client.query('UPDATE deliveries SET next_attempt_at = now()');
    const jobs = (await inspector.xRange(stream, '-', '+')) ?? [];
    // Simulate idle time of a stopped consumer without sleeping for a minute.
    await inspector.sendCommand(['XCLAIM', stream, group, 'stopped-worker', '0', jobs[0]!.id, 'IDLE', '61000']);
    expect(await run('replacement-worker')).toBe('succeeded');
    expect(calls).toBe(2); // External HTTP cannot be rolled back with PostgreSQL.
    const history = await database.client.query('SELECT attempt_number, outcome FROM delivery_attempts ORDER BY attempt_number');
    expect(history.rows).toEqual([{ attempt_number: 1, outcome: 'abandoned' }, { attempt_number: 2, outcome: 'succeeded' }]);
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
  });

  it('rejects loopback destinations by default without contacting the receiver', async () => {
    let calls = 0;
    await prepare((_request, response) => { calls++; response.end(); });
    expect(await consumeOne(queue, 'worker-1', id => processDelivery(pool, id, sendWebhook))).toBe('dead');
    expect(calls).toBe(0);
    const attempts = await database.client.query('SELECT error_message FROM delivery_attempts');
    expect(attempts.rows[0].error_message).toContain('not allowed');
  });

  it('acknowledges malformed messages so they cannot become permanent poison jobs', async () => {
    await inspector.xAdd(stream, '*', { delivery_id: 'not-a-uuid' });
    await queue.connect();
    expect(await run()).toBe('malformed');
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
  });

  it('recovers from two chaos failures with growing persisted retry delays', async () => {
    await prepare(createChaosReceiver(undefined, { allowUnsigned: true }), '/webhooks?mode=flaky&failures=2');
    for (const minimumSeconds of [3.5, 7]) {
      expect(await run()).toBe('retry_scheduled');
      const result = await database.client.query(`SELECT
        extract(epoch FROM (next_attempt_at - updated_at))::double precision AS delay FROM deliveries`);
      expect(result.rows[0].delay).toBeGreaterThan(minimumSeconds);
      expect(result.rows[0].delay).toBeLessThan(minimumSeconds * 1.5);
      // Move only this test delivery forward to avoid sleeping through real backoff.
      await database.client.query('UPDATE deliveries SET next_attempt_at = now()');
      expect(await dispatchBatch(pool, publisher)).toBe(1);
    }
    expect(await run()).toBe('succeeded');
    const history = await database.client.query('SELECT outcome, http_status FROM delivery_attempts ORDER BY attempt_number');
    expect(history.rows).toEqual([{ outcome: 'failed', http_status: 500 },
      { outcome: 'failed', http_status: 500 }, { outcome: 'succeeded', http_status: 200 }]);
  });

  it('honors a 429 Retry-After minimum instead of the shorter jittered delay', async () => {
    await prepare(createChaosReceiver(undefined, { allowUnsigned: true }), '/webhooks?mode=rate-limit&retry_after=60');
    expect(await run()).toBe('retry_scheduled');
    const result = await database.client.query(`SELECT d.status,
      d.next_attempt_at >= a.started_at + interval '60 seconds' AS respected
      FROM deliveries d JOIN delivery_attempts a ON a.delivery_id = d.id`);
    expect(result.rows).toEqual([{ status: 'pending', respected: true }]);
    expect(await dispatchBatch(pool, publisher)).toBe(0);
  });

  it('honors a 503 Retry-After HTTP date', async () => {
    const minimum = new Date(Date.now() + 120000).toUTCString();
    await prepare((_request, response) => { response.writeHead(503, { 'retry-after': minimum }).end(); });
    expect(await run()).toBe('retry_scheduled');
    const result = await database.client.query('SELECT next_attempt_at FROM deliveries');
    expect(result.rows[0].next_attempt_at.getTime()).toBeGreaterThanOrEqual(Date.parse(minimum) - 1000);
  });

  it('stops a permanent chaos response after the first attempt', async () => {
    await prepare(createChaosReceiver(undefined, { allowUnsigned: true }), '/webhooks?mode=status&status=404');
    expect(await run()).toBe('dead');
    const result = await database.client.query(`SELECT d.status, d.attempt_count, a.http_status, a.error_message
      FROM deliveries d JOIN delivery_attempts a ON a.delivery_id = d.id`);
    expect(result.rows[0]).toMatchObject({ status: 'dead', attempt_count: 1, http_status: 404 });
    expect(result.rows[0].error_message).toContain('permanent_http_response');
    expect(await dispatchBatch(pool, publisher)).toBe(0);
    expect((await inspector.xPending(stream, group)).pending).toBe(0);
  });

  it('falls back to backoff for an invalid Retry-After value', async () => {
    await prepare((_request, response) => { response.writeHead(429, { 'retry-after': 'tomorrow' }).end(); });
    expect(await run()).toBe('retry_scheduled');
    const result = await database.client.query(`SELECT
      extract(epoch FROM (next_attempt_at - updated_at))::double precision AS delay FROM deliveries`);
    expect(result.rows[0].delay).toBeGreaterThan(3.5);
    expect(result.rows[0].delay).toBeLessThan(5);
  });

  it('stops rather than ignoring an excessive server minimum', async () => {
    await prepare(createChaosReceiver(undefined, { allowUnsigned: true }), '/webhooks?mode=status&status=503&retry_after=999999');
    expect(await run()).toBe('dead');
    const result = await database.client.query('SELECT error_message FROM delivery_attempts');
    expect(result.rows[0].error_message).toContain('retry_after_exceeds_24h');
  });

  it('records a chaos timeout as a transient failure', async () => {
    await prepare(createChaosReceiver(undefined, { allowUnsigned: true }), '/webhooks?mode=timeout');
    expect(await consumeOne(queue, 'worker-1', id => processDelivery(pool, id,
      request => sendWebhook(request, { allowLoopback: true, timeoutMs: 50 })))).toBe('retry_scheduled');
    const result = await database.client.query('SELECT http_status, error_message FROM delivery_attempts');
    expect(result.rows[0].http_status).toBeNull();
    expect(result.rows[0].error_message).toContain('transient_failure');
  });
});
