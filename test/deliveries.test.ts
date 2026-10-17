import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { ReplayConflictError, type Delivery } from '../src/deliveries/store.js';

const id = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-01-01T00:00:00.000Z';
const delivery: Delivery = { id, event_id: id, endpoint_id: id, status: 'dead', attempt_count: 1, max_attempts: 5,
  next_attempt_at: timestamp, completed_at: timestamp, created_at: timestamp, updated_at: timestamp };
const validBody = { expected_attempt_count: 1, reason: 'Fixed receiver configuration' };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function setup() {
  const database = {
    readMetrics: vi.fn<Database['readMetrics']>(),
    check: vi.fn<Database['check']>(), close: vi.fn<Database['close']>().mockResolvedValue(undefined),
    createEndpoint: vi.fn<Database['createEndpoint']>(), updateEndpoint: vi.fn<Database['updateEndpoint']>(),
    listEndpoints: vi.fn<Database['listEndpoints']>(),
    ingestEvent: vi.fn<Database['ingestEvent']>(),
    listDeadDeliveries: vi.fn<Database['listDeadDeliveries']>().mockResolvedValue([delivery]),
    getDelivery: vi.fn<Database['getDelivery']>().mockResolvedValue({ ...delivery,
      endpoint_enabled: true, event_type: 'demo.created', last_attempt: null, last_replay: null }),
    listDeliveryAttempts: vi.fn<Database['listDeliveryAttempts']>().mockResolvedValue([]),
    replayDelivery: vi.fn<Database['replayDelivery']>().mockResolvedValue(null),
  };
  const app = buildApp(loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: 'postgresql://test:test@localhost/test' }), database);
  apps.push(app);
  return { app, database };
}
describe('Delivery inspection and replay API', () => {
  it('lists a bounded dead-delivery page and marks it non-cacheable', async () => {
    const { app, database } = setup();
    const response = await app.inject('/api/deliveries/dead?limit=1&offset=2');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deliveries: [delivery], limit: 1, offset: 2 });
    expect(database.listDeadDeliveries).toHaveBeenCalledWith({ limit: 1, offset: 2 });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('inspects a delivery with nullable latest history and excludes unlisted fields', async () => {
    const { app, database } = setup();
    const detail = { ...delivery, endpoint_enabled: true, event_type: 'demo.created',
      last_attempt: null, last_replay: null, signing_secret: 'private' };
    database.getDelivery.mockResolvedValue(detail);
    const response = await app.inject(`/api/deliveries/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().delivery.last_attempt).toBeNull();
    expect(response.body).not.toContain('private');
    expect(database.getDelivery).toHaveBeenCalledWith(id);
  });
  it('returns empty paginated attempt history for an existing delivery', async () => {
    const { app, database } = setup();
    const response = await app.inject(`/api/deliveries/${id}/attempts`);
    expect(response.json()).toEqual({ attempts: [], limit: 20, offset: 0 });
    expect(database.listDeliveryAttempts).toHaveBeenCalledWith(id, { limit: 20, offset: 0 });
  });
  it('accepts replay with a trimmed reason and default five additional attempts', async () => {
    const { app, database } = setup();
    database.replayDelivery.mockResolvedValue({ delivery: { ...delivery, status: 'pending', completed_at: null, max_attempts: 6 },
      replay: { id, reason: validBody.reason, previous_attempt_count: 1,
        previous_max_attempts: 5, additional_attempts: 5, replayed_at: timestamp } });
    const response = await app.inject({ method: 'POST', url: `/api/deliveries/${id}/replay`,
      payload: { ...validBody, reason: '  Fixed receiver configuration  ' } });
    expect(response.statusCode).toBe(202);
    expect(response.json().delivery).toMatchObject({ id, status: 'pending', attempt_count: 1, max_attempts: 6 });
    expect(database.replayDelivery).toHaveBeenCalledWith(id, { ...validBody, additional_attempts: 5 });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each([{}, { reason: 'fix' }, { expected_attempt_count: 1 }, { ...validBody, expected_attempt_count: -1 },
    { ...validBody, expected_attempt_count: 1.5 }, { ...validBody, expected_attempt_count: '1' },
    { ...validBody, expected_attempt_count: 2147483648 }, { ...validBody, additional_attempts: 0 },
    { ...validBody, additional_attempts: 11 }, { ...validBody, additional_attempts: 1.5 },
    { ...validBody, additional_attempts: '2' }, { ...validBody, reason: '' }, { ...validBody, reason: '   ' },
    { ...validBody, reason: 'x'.repeat(201) }, { ...validBody, reason: 123 }, { ...validBody, unknown: true }])
  ('rejects invalid replay input before database work %#', async payload => {
    const { app, database } = setup();
    expect((await app.inject({ method: 'POST', url: `/api/deliveries/${id}/replay`, payload })).statusCode).toBe(400);
    expect(database.replayDelivery).not.toHaveBeenCalled();
  });
  it.each(['', '/attempts', '/replay'])('rejects invalid delivery UUIDs on %s', async suffix => {
    const { app, database } = setup();
    expect((await app.inject({ method: suffix === '/replay' ? 'POST' : 'GET',
      url: `/api/deliveries/not-a-uuid${suffix}`, ...(suffix === '/replay' ? { payload: validBody } : {}) })).statusCode).toBe(400);
    expect(database.getDelivery).not.toHaveBeenCalled();
    expect(database.replayDelivery).not.toHaveBeenCalled();
    expect(database.listDeliveryAttempts).not.toHaveBeenCalled();
  });
  it.each(['limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=1000000', 'extra=true'])
  ('rejects invalid pagination %s on both lists', async query => {
    const { app, database } = setup();
    for (const path of ['dead', `${id}/attempts`]) {
      expect((await app.inject(`/api/deliveries/${path}?${query}`)).statusCode).toBe(400);
    }
    expect(database.listDeadDeliveries).not.toHaveBeenCalled();
    expect(database.listDeliveryAttempts).not.toHaveBeenCalled();
  });
  it('returns 404 for unknown IDs on inspection, attempts, and replay', async () => {
    const { app, database } = setup();
    database.getDelivery.mockResolvedValue(null);
    database.listDeliveryAttempts.mockResolvedValue(null);
    for (const path of [id, `${id}/attempts`]) expect((await app.inject(`/api/deliveries/${path}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/deliveries/${id}/replay`, payload: validBody })).statusCode).toBe(404);
  });
  it('returns 409 for a replay conflict', async () => {
    const { app, database } = setup();
    database.replayDelivery.mockRejectedValue(new ReplayConflictError('Only dead deliveries can be replayed'));
    const response = await app.inject({ method: 'POST', url: `/api/deliveries/${id}/replay`, payload: validBody });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('Only dead deliveries can be replayed');
  });
  it('hides storage failure details on every route', async () => {
    const { app, database } = setup();
    const error = new Error('private SQL and credentials');
    database.listDeadDeliveries.mockRejectedValue(error);
    database.getDelivery.mockRejectedValue(error);
    database.listDeliveryAttempts.mockRejectedValue(error);
    database.replayDelivery.mockRejectedValue(error);
    const responses = await Promise.all([app.inject('/api/deliveries/dead'), app.inject(`/api/deliveries/${id}`),
      app.inject(`/api/deliveries/${id}/attempts`),
      app.inject({ method: 'POST', url: `/api/deliveries/${id}/replay`, payload: validBody })]);
    for (const response of responses) {
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('private');
    }
  });
});
