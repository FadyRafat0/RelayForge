import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import type { AcceptedEvent } from '../src/events/store.js';
import { IdempotencyConflictError } from '../src/events/store.js';

const accepted: AcceptedEvent = {
  event: { id: '11111111-1111-4111-8111-111111111111', type: 'payment.succeeded',
    created_at: '2026-01-01T00:00:00.000Z' },
  delivery_count: 2,
  replayed: false,
};
const validBody = { type: 'payment.succeeded', payload: { amount: 100, currency: 'EUR' } };
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
    check: vi.fn<Database['check']>().mockResolvedValue(undefined),
    close: vi.fn<Database['close']>().mockResolvedValue(undefined),
    createEndpoint: vi.fn<Database['createEndpoint']>(),
    updateEndpoint: vi.fn<Database['updateEndpoint']>(),
    listEndpoints: vi.fn<Database['listEndpoints']>(),
    ingestEvent: vi.fn<Database['ingestEvent']>().mockResolvedValue(accepted),
  };
  const app = buildApp(loadConfig({
    LOG_LEVEL: 'silent', DATABASE_URL: 'postgresql://test:test@localhost/test',
  }), database);
  apps.push(app);
  return { app, database };
}

describe('Event ingestion API', () => {
  it('returns committed event metadata and the number of created deliveries', async () => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/events', payload: validBody });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(accepted);
    expect(database.ingestEvent).toHaveBeenCalledWith(validBody);
  });

  it('preserves arbitrary nested JSON payload fields', async () => {
    const { app, database } = setup();
    const payload = { type: 'payment.succeeded', payload: {
      customer: { id: 'customer-1', tags: ['new', 'trial'] }, settled: false, optional: null,
    } };
    expect((await app.inject({ method: 'POST', url: '/api/events', payload })).statusCode).toBe(201);
    expect(database.ingestEvent).toHaveBeenCalledWith(payload);
  });

  it.each([
    {}, { type: 'payment.succeeded' }, { payload: {} },
    { ...validBody, type: '' }, { ...validBody, type: '*' },
    { ...validBody, type: ' payment.succeeded' }, { ...validBody, type: 'has spaces' },
    { ...validBody, type: 'x'.repeat(101) }, { ...validBody, type: 123 },
    { ...validBody, payload: null }, { ...validBody, payload: [] },
    { ...validBody, payload: 'text' }, { ...validBody, payload: 123 },
    { ...validBody, unknown: true },
    ...['', ' ', 'has spaces', 'x'.repeat(201), null, 123].map(idempotency_key => ({ ...validBody, idempotency_key })),
  ])('rejects invalid input before database work: %#', async payload => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/events', payload });
    expect(response.statusCode).toBe(400);
    expect(database.ingestEvent).not.toHaveBeenCalled();
  });

  it('rejects requests exceeding 64 KiB', async () => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/events',
      payload: { type: 'large.event', payload: { text: 'x'.repeat(64 * 1024) } } });
    expect(response.statusCode).toBe(413);
    expect(database.ingestEvent).not.toHaveBeenCalled();
  });

  it('passes an idempotency key unchanged to the store', async () => {
    const { app, database } = setup();
    const payload = { ...validBody, idempotency_key: 'payment:123.v1_retry-1' };
    const response = await app.inject({ method: 'POST', url: '/api/events', payload });
    expect(response.statusCode).toBe(201);
    expect(response.json().replayed).toBe(false);
    expect(database.ingestEvent).toHaveBeenCalledWith(payload);
  });

  it('returns 200 for an existing event replay', async () => {
    const { app, database } = setup();
    database.ingestEvent.mockResolvedValue({ ...accepted, replayed: true });
    const response = await app.inject({ method: 'POST', url: '/api/events',
      payload: { ...validBody, idempotency_key: 'payment-123' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...accepted, replayed: true });
  });

  it('returns 409 for a key reused with different data', async () => {
    const { app, database } = setup();
    database.ingestEvent.mockRejectedValue(new IdempotencyConflictError());
    const response = await app.inject({ method: 'POST', url: '/api/events',
      payload: { ...validBody, idempotency_key: 'payment-123' } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Conflict',
      message: 'Idempotency key was already used with different event data' });
  });

  it('rejects malformed JSON', async () => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/events',
      headers: { 'content-type': 'application/json' }, payload: '{broken' });
    expect(response.statusCode).toBe(400);
    expect(database.ingestEvent).not.toHaveBeenCalled();
  });

  it('does not report acceptance while the store is still working', async () => {
    const { app, database } = setup();
    let resolveStore!: (value: AcceptedEvent) => void;
    const pending = new Promise<AcceptedEvent>(resolve => { resolveStore = resolve; });
    database.ingestEvent.mockReturnValue(pending);
    let completed = false;
    const response = app.inject({ method: 'POST', url: '/api/events', payload: validBody })
      .then(result => { completed = true; return result; });
    await vi.waitFor(() => { expect(database.ingestEvent).toHaveBeenCalledOnce(); });
    expect(completed).toBe(false);
    resolveStore(accepted);
    expect((await response).statusCode).toBe(201);
  });

  it('returns a generic failure instead of successful acceptance on store errors', async () => {
    const { app, database } = setup();
    database.ingestEvent.mockRejectedValue(new Error('private SQL details'));
    const response = await app.inject({ method: 'POST', url: '/api/events', payload: validBody });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal Server Error', message: 'Unable to accept event' });
    expect(response.body).not.toContain('private');
  });
});
