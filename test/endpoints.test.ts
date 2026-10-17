import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import type { RegisteredEndpoint } from '../src/endpoints/store.js';

const savedEndpoint: RegisteredEndpoint = {
  signing_secret: 'whsec_' + 'a'.repeat(64),
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Payment receiver', url: 'https://example.com/hooks',
  event_types: ['*'], enabled: true, rate_limit_per_second: 10,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
};
const { signing_secret: _secret, ...publicEndpoint } = savedEndpoint;
const validBody = { name: 'Payment receiver', url: 'https://example.com/hooks' };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

function setup() {
  const database = {
    readMetrics: vi.fn<Database['readMetrics']>(),
    listDeadDeliveries: vi.fn<Database['listDeadDeliveries']>(),
    getDelivery: vi.fn<Database['getDelivery']>(),
    listDeliveryAttempts: vi.fn<Database['listDeliveryAttempts']>(),
    replayDelivery: vi.fn<Database['replayDelivery']>(),
    ingestEvent: vi.fn<Database['ingestEvent']>(),
    check: vi.fn<Database['check']>().mockResolvedValue(undefined),
    close: vi.fn<Database['close']>().mockResolvedValue(undefined),
    createEndpoint: vi.fn<Database['createEndpoint']>().mockResolvedValue(savedEndpoint),
    updateEndpoint: vi.fn<Database['updateEndpoint']>(),
    listEndpoints: vi.fn<Database['listEndpoints']>().mockResolvedValue([]),
  };
  const app = buildApp(loadConfig({
    LOG_LEVEL: 'silent', DATABASE_URL: 'postgresql://test:test@localhost/test',
  }), database);
  apps.push(app);
  return { app, database };
}

describe('Endpoint API validation and responses', () => {
  it('updates only supplied fields, normalizes values, and never exposes the secret', async () => {
    const { app, database } = setup();
    database.updateEndpoint.mockResolvedValue({ ...savedEndpoint, name: 'Changed', enabled: false });
    const response = await app.inject({ method: 'PATCH', url: `/api/endpoints/${savedEndpoint.id}`,
      payload: { name: ' Changed ', enabled: false } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'Changed', enabled: false });
    expect(response.json()).not.toHaveProperty('signing_secret');
    expect(database.updateEndpoint).toHaveBeenCalledWith(savedEndpoint.id, { name: 'Changed', enabled: false });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([{}, { name: ' ' }, { enabled: null }, { enabled: 'false' },
    { rate_limit_per_second: 0 }, { rate_limit_per_second: 1001 },
    { signing_secret: 'replace' }, { unknown: true }, { event_types: [] },
    { event_types: ['*', 'payment.succeeded'] }, { url: 'https://user:password@example.com/hook' },
    { url: 'https://example.com/#fragment' }])('rejects invalid endpoint updates: %#', async payload => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'PATCH', url: `/api/endpoints/${savedEndpoint.id}`, payload });
    expect(response.statusCode).toBe(400);
    expect(database.updateEndpoint).not.toHaveBeenCalled();
  });

  it('validates update IDs and reports missing endpoints', async () => {
    const { app, database } = setup();
    const invalid = await app.inject({ method: 'PATCH', url: '/api/endpoints/not-a-uuid', payload: { enabled: false } });
    expect(invalid.statusCode).toBe(400);
    expect(database.updateEndpoint).not.toHaveBeenCalled();
    const missing = await app.inject({ method: 'PATCH', url: `/api/endpoints/${savedEndpoint.id}`, payload: { enabled: false } });
    expect(missing.statusCode).toBe(404);
  });

  it('hides update database errors', async () => {
    const { app, database } = setup();
    database.updateEndpoint.mockRejectedValue(new Error('private credentials'));
    const response = await app.inject({ method: 'PATCH', url: `/api/endpoints/${savedEndpoint.id}`, payload: { enabled: true } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private');
  });
  it('creates an endpoint with normalized name/URL and defaults', async () => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/endpoints',
      payload: { name: ' Payment receiver ', url: 'https://EXAMPLE.com/hooks' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(savedEndpoint);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(database.createEndpoint).toHaveBeenCalledWith({
      ...validBody, event_types: ['*'], enabled: true, rate_limit_per_second: 10,
    });
  });

  it('preserves explicit disabled status and subscriptions', async () => {
    const { app, database } = setup();
    const payload = { ...validBody, enabled: false, event_types: ['payment.succeeded'] };
    database.createEndpoint.mockResolvedValue({ ...savedEndpoint, ...payload });
    const response = await app.inject({ method: 'POST', url: '/api/endpoints', payload });
    expect(response.statusCode).toBe(201);
    expect(response.json().enabled).toBe(false);
    expect(database.createEndpoint).toHaveBeenCalledWith({ ...payload, rate_limit_per_second: 10 });
  });

  it('accepts an explicit per-endpoint rate limit', async () => {
    const { app, database } = setup();
    database.createEndpoint.mockResolvedValue({ ...savedEndpoint, rate_limit_per_second: 2 });
    const response = await app.inject({ method: 'POST', url: '/api/endpoints',
      payload: { ...validBody, rate_limit_per_second: 2 } });
    expect(response.statusCode).toBe(201);
    expect(response.json().rate_limit_per_second).toBe(2);
    expect(database.createEndpoint).toHaveBeenCalledWith({ ...validBody, event_types: ['*'],
      enabled: true, rate_limit_per_second: 2 });
  });

  it.each([
    {}, { name: 'receiver' }, { url: 'https://example.com' },
    { ...validBody, name: '   ' }, { ...validBody, name: 'x'.repeat(101) },
    { ...validBody, name: 123 }, { ...validBody, enabled: 'false' },
    { ...validBody, rate_limit_per_second: 0 }, { ...validBody, rate_limit_per_second: 1001 },
    { ...validBody, rate_limit_per_second: 1.5 }, { ...validBody, rate_limit_per_second: '10' },
    { ...validBody, rate_limit_per_second: null }, { ...validBody, unknown: 'field' }, { ...validBody, url: 'not-a-url' },
    { ...validBody, url: 'ftp://example.com' }, { ...validBody, url: 'https://' },
    { ...validBody, url: 'https://user:password@example.com/hook' },
    { ...validBody, url: 'https://example.com/#fragment' },
    { ...validBody, url: 'https://example.com/has space' },
    { ...validBody, url: 'https://example.com/\\backslash' },
    { ...validBody, event_types: [] }, { ...validBody, event_types: 'payment.succeeded' },
    { ...validBody, event_types: [null] }, { ...validBody, event_types: [''] },
    { ...validBody, event_types: ['payment.succeeded', 'payment.succeeded'] },
    { ...validBody, event_types: ['*', 'payment.succeeded'] },
    { ...validBody, event_types: ['has spaces'] },
    { ...validBody, event_types: Array.from({ length: 101 }, (_, i) => `event.${i}`) },
  ])('rejects invalid input before accessing the database: %#', async payload => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/endpoints', payload });
    expect(response.statusCode).toBe(400);
    expect(database.createEndpoint).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before accessing the database', async () => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/endpoints',
      headers: { 'content-type': 'application/json' }, payload: '{broken' });
    expect(response.statusCode).toBe(400);
    expect(database.createEndpoint).not.toHaveBeenCalled();
  });

  it('returns an empty page by default', async () => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'GET', url: '/api/endpoints' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ endpoints: [], limit: 20, offset: 0 });
    expect(database.listEndpoints).toHaveBeenCalledWith({ limit: 20, offset: 0 });
  });

  it('accepts bounded pagination parameters', async () => {
    const { app, database } = setup();
    database.listEndpoints.mockResolvedValue([savedEndpoint]);
    const response = await app.inject({ method: 'GET', url: '/api/endpoints?limit=1&offset=2' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ endpoints: [publicEndpoint], limit: 1, offset: 2 });
    expect(database.listEndpoints).toHaveBeenCalledWith({ limit: 1, offset: 2 });
  });

  it.each(['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=abc',
    'offset=-1', 'offset=1000000', 'offset=1.5', 'offset=abc', 'extra=value'])
  ('rejects invalid pagination %s', async query => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'GET', url: `/api/endpoints?${query}` });
    expect(response.statusCode).toBe(400);
    expect(database.listEndpoints).not.toHaveBeenCalled();
  });

  it.each(['create', 'list'])('hides database errors during %s', async operation => {
    const { app, database } = setup();
    const failure = new Error('private database credentials and SQL');
    database.createEndpoint.mockRejectedValue(failure);
    database.listEndpoints.mockRejectedValue(failure);
    const response = operation === 'create'
      ? await app.inject({ method: 'POST', url: '/api/endpoints', payload: validBody })
      : await app.inject({ method: 'GET', url: '/api/endpoints' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe('Internal Server Error');
    expect(response.body).not.toContain('private');
  });
});
