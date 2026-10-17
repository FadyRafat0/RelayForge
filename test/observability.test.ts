import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { createLogger, errorCode } from '../src/observability/logging.js';
import { formatMetrics, type MetricsSnapshot } from '../src/observability/metrics.js';
import { runWorker } from '../src/worker/run.js';
import type { WorkerLogEvent } from '../src/observability/events.js';

const snapshot: MetricsSnapshot = {
  deliveries: { pending: 2, processing: 1, succeeded: 4, dead: 1 },
  attempts: { in_progress: 1, succeeded: 4, failed: 3, abandoned: 1 },
  due: 1, oldest_due_lag_seconds: 2.5, expired_leases: 0, replays: 1,
};
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function setup(level: 'silent' | 'info' = 'silent') {
  const lines: string[] = [];
  const logger = createLogger('api', level, { write: (line: string) => { lines.push(line); } });
  const database = {
    check: vi.fn<Database['check']>().mockResolvedValue(undefined), close: vi.fn<Database['close']>().mockResolvedValue(undefined),
    createEndpoint: vi.fn<Database['createEndpoint']>(), updateEndpoint: vi.fn<Database['updateEndpoint']>(),
    listEndpoints: vi.fn<Database['listEndpoints']>().mockResolvedValue([]),
    ingestEvent: vi.fn<Database['ingestEvent']>(), listDeadDeliveries: vi.fn<Database['listDeadDeliveries']>(),
    getDelivery: vi.fn<Database['getDelivery']>(), listDeliveryAttempts: vi.fn<Database['listDeliveryAttempts']>(),
    replayDelivery: vi.fn<Database['replayDelivery']>(), readMetrics: vi.fn<Database['readMetrics']>().mockResolvedValue(snapshot),
  };
  const app = buildApp(loadConfig({ LOG_LEVEL: level, DATABASE_URL: 'postgresql://test:test@localhost/test' }), database, logger);
  apps.push(app);
  return { app, database, lines };
}

describe('Prometheus metrics route', () => {
  it('exports fixed gauge labels, metadata, finite values, and a final newline', async () => {
    const { app, database } = setup();
    const response = await app.inject('/metrics');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('# TYPE relayforge_deliveries gauge\n');
    expect(response.body).toContain('relayforge_deliveries{status="pending"} 2\n');
    expect(response.body).toContain('relayforge_attempts{outcome="abandoned"} 1\n');
    expect(response.body).toContain('relayforge_oldest_due_delivery_lag_seconds 2.5\n');
    expect(response.body.endsWith('\n')).toBe(true);
    expect(response.body.split('\n').filter(line => line && !line.startsWith('#'))).toHaveLength(12);
    expect(response.body).not.toContain('delivery_id');
    expect(response.body).not.toContain('_total');
    expect(database.readMetrics).toHaveBeenCalledOnce();
  });
  it('returns 503 on collection failure, hides error details, and recovers on a later scrape', async () => {
    const { app, database } = setup();
    database.readMetrics.mockRejectedValueOnce(new Error('private database credentials'));
    const failed = await app.inject('/metrics');
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['cache-control']).toBe('no-store');
    expect(failed.body).not.toContain('private');
    expect(failed.body).not.toContain('relayforge_deliveries');
    expect((await app.inject('/metrics')).statusCode).toBe(200);
  });
  it('rejects metric filters rather than introducing arbitrary label sets', async () => {
    const { app, database } = setup();
    expect((await app.inject('/metrics?endpoint_id=private')).statusCode).toBe(400);
    expect(database.readMetrics).not.toHaveBeenCalled();
  });
  it('returns JSON 503 if an invalid snapshot fails formatting before response headers are set', async () => {
    const { app, database } = setup();
    database.readMetrics.mockResolvedValue({ ...snapshot, due: NaN });
    const response = await app.inject('/metrics');
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'Service Unavailable', message: 'Unable to collect metrics' });
  });
  it.each([NaN, Infinity, -1])('refuses an invalid numeric sample %s', value => {
    expect(() => formatMetrics({ ...snapshot, due: value })).toThrow('Invalid metrics snapshot');
  });
});

describe('Structured log contents', () => {
  it('links API acceptance to the saved event ID without recording its payload or idempotency key', async () => {
    const { app, database, lines } = setup('info');
    const id = '11111111-1111-4111-8111-111111111111';
    database.ingestEvent.mockResolvedValue({ event: { id, type: 'demo.created', created_at: new Date().toISOString() },
      delivery_count: 1, replayed: false });
    expect((await app.inject({ method: 'POST', url: '/api/events', payload: { type: 'demo.created',
      payload: { private: 'private-payload-sentinel' }, idempotency_key: 'private-idempotency-sentinel' } })).statusCode).toBe(201);
    const records = lines.map(line => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({ event: 'event.accepted', event_id: id,
      delivery_count: 1, replayed: false, reqId: expect.any(String) }));
    expect(lines.join('')).not.toContain('private-payload-sentinel');
    expect(lines.join('')).not.toContain('private-idempotency-sentinel');
  });
  it('records route patterns and duration without query, path parameters, headers, bodies, or raw exceptions', async () => {
    const { app, database, lines } = setup('info');
    const sentinel = 'private-observability-sentinel';
    await app.inject({ method: 'GET', url: '/api/endpoints?limit=1',
      headers: { authorization: sentinel, cookie: sentinel } });
    await app.inject(`/unknown/${sentinel}?token=${sentinel}`);
    await app.inject({ method: 'POST', url: '/api/endpoints', payload: { name: sentinel } });
    database.check.mockRejectedValueOnce(Object.assign(new Error(sentinel), { code: 'ECONNREFUSED', detail: sentinel }));
    await app.inject('/health');
    const output = lines.join('');
    expect(output).not.toContain(sentinel);
    const records = lines.map(line => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({ service: 'api', event: 'api.request_completed',
      route: '/api/endpoints', method: 'GET', status_code: 200, duration_ms: expect.any(Number), reqId: expect.any(String) }));
    expect(records).toContainEqual(expect.objectContaining({ err: { code: 'ECONNREFUSED' } }));
  });
  it('redacts known secret/payload fields and honors log levels', () => {
    const lines: string[] = [];
    const logger = createLogger('worker', 'info', { write: (line: string) => { lines.push(line); } });
    logger.debug({ event: 'hidden' });
    logger.info({ event: 'delivery.processed', delivery_id: 'safe-id', signingSecret: 'secret-value',
      payload: { customer: 'private-value' }, request: { headers: { authorization: 'secret-value' } } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('secret-value');
    expect(lines[0]).not.toContain('private-value');
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: 'worker', event: 'delivery.processed', delivery_id: 'safe-id' });
    expect(errorCode(new Error('private'))).toBe('UNKNOWN');
  });
  it('reports an acknowledgement failure with stream and delivery IDs while retaining the failed message', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const events: WorkerLogEvent[] = [];
    const queue = { read: vi.fn().mockResolvedValue({ id: '1-0', deliveryId: id }),
      ack: vi.fn().mockRejectedValue(Object.assign(new Error('private'), { code: 'ECONNRESET' })) };
    await expect(runWorker(queue, 'worker', async () => 'succeeded',
      { once: true, onEvent: event => events.push(event) })).rejects.toThrow('private');
    expect(events).toContainEqual(expect.objectContaining({ event: 'worker.job_failed', stream_id: '1-0',
      delivery_id: id, error_code: 'ECONNRESET' }));
    expect(events.some(event => event.event === 'worker.job_acknowledged')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('private');
  });
  it('never logs malformed delivery ID contents, and ignores telemetry callback errors', async () => {
    const events: WorkerLogEvent[] = [];
    const queue = { read: vi.fn().mockResolvedValue({ id: '1-0', deliveryId: 'private-payload-in-poison-job' }),
      ack: vi.fn().mockResolvedValue(undefined) };
    await runWorker(queue, 'worker', async () => 'succeeded', { once: true, onEvent: event => {
      events.push(event); throw new Error('Log sink failed');
    } });
    expect(queue.ack).toHaveBeenCalledOnce();
    expect(events.some(event => event.event === 'worker.job_acknowledged')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private-payload');
  });
  it('isolates asynchronous telemetry rejection without delaying job acknowledgement', async () => {
    const queue = { read: vi.fn().mockResolvedValue({ id: '1-0', deliveryId: '11111111-1111-4111-8111-111111111111' }),
      ack: vi.fn().mockResolvedValue(undefined) };
    await runWorker(queue, 'worker', async () => 'succeeded', { once: true,
      onEvent: async () => { throw new Error('Telemetry transport rejected'); } });
    expect(queue.ack).toHaveBeenCalledOnce();
  });
});
