import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/migrations.js';
import { createTestDatabase } from '../helpers/database.js';

describe('Transactional event ingestion with PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const apps: ReturnType<typeof buildApp>[] = [];
  const body = { type: 'payment.succeeded', payload: {
    amount: 100, currency: 'EUR', customer: { id: 'customer-1' }, tags: ['new'], optional: null,
  } };

  beforeEach(async () => {
    database = await createTestDatabase();
    await runMigrations(database.client);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
    await database?.close();
  });

  function makeApp() {
    const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });
    const url = new URL(config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    const app = buildApp({ ...config, databaseUrl: url.toString() });
    apps.push(app);
    return app;
  }

  async function addEndpoint(name: string, eventTypes: string[], enabled = true) {
    const result = await database.client.query(`INSERT INTO webhook_endpoints (name, url, event_types, enabled)
      VALUES ($1, 'https://example.com/hooks', $2, $3) RETURNING id`, [name, eventTypes, enabled]);
    return result.rows[0].id as string;
  }

  it('saves the payload and creates only enabled exact/wildcard delivery obligations', async () => {
    const exact = await addEndpoint('exact', ['payment.succeeded', 'payment.failed']);
    const wildcard = await addEndpoint('all events', ['*']);
    // Even a legacy row matching both predicates must receive only one delivery.
    const both = await addEndpoint('both', ['*', 'payment.succeeded']);
    await addEndpoint('disabled', ['payment.succeeded'], false);
    await addEndpoint('unrelated', ['invoice.created']);
    await addEndpoint('wrong case', ['Payment.Succeeded']);

    const response = await makeApp().inject({ method: 'POST', url: '/api/events', payload: body });
    expect(response.statusCode).toBe(201);
    const accepted = response.json();
    expect(accepted.delivery_count).toBe(3);
    expect(accepted.event.type).toBe(body.type);
    expect(accepted.event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(accepted.event.created_at))).toBe(false);
    const events = await database.client.query('SELECT type, payload FROM events WHERE id = $1', [accepted.event.id]);
    expect(events.rows).toEqual([{ type: body.type, payload: body.payload }]);
    const deliveries = await database.client.query(`SELECT endpoint_id, status, attempt_count
      FROM deliveries WHERE event_id = $1`, [accepted.event.id]);
    expect(deliveries.rows.map(row => row.endpoint_id).sort()).toEqual([exact, wildcard, both].sort());
    expect(deliveries.rows.every(row => row.status === 'pending' && row.attempt_count === 0)).toBe(true);
    const attempts = await database.client.query('SELECT count(*)::integer AS count FROM delivery_attempts');
    expect(attempts.rows[0].count).toBe(0);
  });

  it('accepts events with no subscribers and does not retroactively deliver them', async () => {
    const app = makeApp();
    const response = await app.inject({ method: 'POST', url: '/api/events', payload: body });
    expect(response.statusCode).toBe(201);
    expect(response.json().delivery_count).toBe(0);
    await addEndpoint('registered later', ['*']);
    const events = await database.client.query('SELECT count(*)::integer AS count FROM events');
    const deliveries = await database.client.query('SELECT count(*)::integer AS count FROM deliveries');
    expect(events.rows[0].count).toBe(1);
    expect(deliveries.rows[0].count).toBe(0);
  });

  it('rolls back the event if delivery insertion fails, then accepts a later request', async () => {
    await addEndpoint('receiver', ['*']);
    // Force failure after the event INSERT, using only this test's schema.
    await database.client.query('ALTER TABLE deliveries ADD CONSTRAINT test_block_delivery CHECK (false)');
    const app = makeApp();
    const failed = await app.inject({ method: 'POST', url: '/api/events', payload: body });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('test_block_delivery');
    const events = await database.client.query('SELECT count(*)::integer AS count FROM events');
    const deliveries = await database.client.query('SELECT count(*)::integer AS count FROM deliveries');
    expect(events.rows[0].count).toBe(0);
    expect(deliveries.rows[0].count).toBe(0);

    await database.client.query('ALTER TABLE deliveries DROP CONSTRAINT test_block_delivery');
    const recovered = await app.inject({ method: 'POST', url: '/api/events', payload: body });
    expect(recovered.statusCode).toBe(201);
    expect(recovered.json().delivery_count).toBe(1);
  });

  it('keeps concurrent submissions separate and releases connections back to the pool', async () => {
    await addEndpoint('receiver', ['payment.succeeded']);
    const app = makeApp();
    // More requests than the pool's five connections exercises reuse.
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      app.inject({ method: 'POST', url: '/api/events', payload: { ...body, payload: { index } } })));
    expect(responses.every(response => response.statusCode === 201)).toBe(true);
    expect(new Set(responses.map(response => response.json().event.id)).size).toBe(12);
    const events = await database.client.query('SELECT count(*)::integer AS count FROM events');
    const deliveries = await database.client.query('SELECT count(*)::integer AS count FROM deliveries');
    expect(events.rows[0].count).toBe(12);
    expect(deliveries.rows[0].count).toBe(12);
  });

  it('rejects invalid events without storing anything', async () => {
    const response = await makeApp().inject({ method: 'POST', url: '/api/events',
      payload: { type: 'payment.succeeded', payload: [] } });
    expect(response.statusCode).toBe(400);
    const result = await database.client.query('SELECT count(*)::integer AS count FROM events');
    expect(result.rows[0].count).toBe(0);
  });

  it('stores SQL-like payload content as JSON data', async () => {
    const payload = { note: "'); DROP TABLE webhook_endpoints; --", enabled: false };
    const response = await makeApp().inject({ method: 'POST', url: '/api/events',
      payload: { type: 'test.event', payload } });
    expect(response.statusCode).toBe(201);
    const result = await database.client.query('SELECT payload FROM events WHERE id = $1', [response.json().event.id]);
    expect(result.rows[0].payload).toEqual(payload);
    await expect(database.client.query('SELECT id FROM webhook_endpoints')).resolves.toBeDefined();
  });

  it('replays the original event across app instances without rematching endpoints', async () => {
    await addEndpoint('original receiver', ['*']);
    const app = makeApp();
    const payload = { ...body, idempotency_key: 'payment-123' };
    const first = await app.inject({ method: 'POST', url: '/api/events', payload });
    expect(first.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    await app.close();
    await addEndpoint('registered after acceptance', ['*']);
    const replay = await makeApp().inject({ method: 'POST', url: '/api/events', payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...first.json(), replayed: true });
    expect(replay.json().delivery_count).toBe(1);
    const events = await database.client.query('SELECT idempotency_key FROM events');
    expect(events.rows).toEqual([{ idempotency_key: 'payment-123' }]);
    const deliveries = await database.client.query('SELECT count(*)::integer AS count FROM deliveries');
    expect(deliveries.rows[0].count).toBe(1);
  });

  it.each(['type', 'payload'])('rejects a key reused with a different %s without changing original data', async field => {
    await addEndpoint('receiver', ['*']);
    const app = makeApp();
    const payload = { ...body, idempotency_key: 'payment-123' };
    expect((await app.inject({ method: 'POST', url: '/api/events', payload })).statusCode).toBe(201);
    const changed = field === 'type'
      ? { ...payload, type: 'payment.failed' }
      : { ...payload, payload: { ...body.payload, amount: 999 } };
    const conflict = await app.inject({ method: 'POST', url: '/api/events', payload: changed });
    expect(conflict.statusCode).toBe(409);
    const events = await database.client.query('SELECT type, payload FROM events');
    expect(events.rows).toEqual([{ type: body.type, payload: body.payload }]);
    const deliveries = await database.client.query('SELECT count(*)::integer AS count FROM deliveries');
    expect(deliveries.rows[0].count).toBe(1);
  });

  it('ignores object key order for equality but preserves array order', async () => {
    const app = makeApp();
    const payload = { type: body.type, idempotency_key: 'ordered-payload',
      payload: { nested: { a: 1, b: 2 }, tags: ['first', 'second'] } };
    const first = await app.inject({ method: 'POST', url: '/api/events', payload });
    const replay = await app.inject({ method: 'POST', url: '/api/events', payload: {
      ...payload, payload: { tags: ['first', 'second'], nested: { b: 2, a: 1 } },
    } });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().event.id).toBe(first.json().event.id);
    const conflict = await app.inject({ method: 'POST', url: '/api/events', payload: {
      ...payload, payload: { ...payload.payload, tags: ['second', 'first'] },
    } });
    expect(conflict.statusCode).toBe(409);
  });

  it('creates exactly one event and delivery under concurrent same-key retries across two pools', async () => {
    await addEndpoint('receiver', ['*']);
    const firstApp = makeApp();
    const secondApp = makeApp();
    const payload = { ...body, idempotency_key: 'concurrent-payment-123' };
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? firstApp : secondApp).inject({ method: 'POST', url: '/api/events', payload })));
    expect(responses.filter(response => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter(response => response.statusCode === 200)).toHaveLength(11);
    expect(new Set(responses.map(response => response.json().event.id)).size).toBe(1);
    expect(responses.every(response => response.json().delivery_count === 1)).toBe(true);
    const counts = await database.client.query(`SELECT
      (SELECT count(*)::integer FROM events) AS events,
      (SELECT count(*)::integer FROM deliveries) AS deliveries`);
    expect(counts.rows).toEqual([{ events: 1, deliveries: 1 }]);
  });

  it('allows one winner and rejects competing different data for the same key', async () => {
    await addEndpoint('receiver', ['*']);
    const payloads = [
      { ...body, idempotency_key: 'competing-key', payload: { amount: 100 } },
      { ...body, idempotency_key: 'competing-key', payload: { amount: 999 } },
    ];
    const firstApp = makeApp();
    const secondApp = makeApp();
    const responses = await Promise.all([
      firstApp.inject({ method: 'POST', url: '/api/events', payload: payloads[0]! }),
      secondApp.inject({ method: 'POST', url: '/api/events', payload: payloads[1]! }),
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const winner = responses.findIndex(response => response.statusCode === 201);
    const events = await database.client.query('SELECT payload FROM events');
    expect(events.rows).toEqual([{ payload: payloads[winner]!.payload }]);
    const deliveries = await database.client.query('SELECT count(*)::integer AS count FROM deliveries');
    expect(deliveries.rows[0].count).toBe(1);
  });

  it('does not consume the key when the initial transaction rolls back', async () => {
    await addEndpoint('receiver', ['*']);
    await database.client.query('ALTER TABLE deliveries ADD CONSTRAINT test_block_delivery CHECK (false)');
    const app = makeApp();
    const payload = { ...body, idempotency_key: 'retry-after-rollback' };
    const failed = await app.inject({ method: 'POST', url: '/api/events', payload });
    expect(failed.statusCode).toBe(500);
    const count = await database.client.query('SELECT count(*)::integer AS count FROM events');
    expect(count.rows[0].count).toBe(0);
    await database.client.query('ALTER TABLE deliveries DROP CONSTRAINT test_block_delivery');
    const retry = await app.inject({ method: 'POST', url: '/api/events', payload });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().replayed).toBe(false);
    const replay = await app.inject({ method: 'POST', url: '/api/events', payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().event.id).toBe(retry.json().event.id);
  });

  it('keeps a zero-delivery replay at zero even after a new endpoint subscribes', async () => {
    const app = makeApp();
    const payload = { ...body, idempotency_key: 'no-subscribers' };
    const first = await app.inject({ method: 'POST', url: '/api/events', payload });
    expect(first.statusCode).toBe(201);
    await addEndpoint('new receiver', ['*']);
    const replay = await app.inject({ method: 'POST', url: '/api/events', payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...first.json(), replayed: true });
    expect(replay.json().delivery_count).toBe(0);
  });

  it('treats distinct keys as separate events even with identical content', async () => {
    const app = makeApp();
    const first = await app.inject({ method: 'POST', url: '/api/events',
      payload: { ...body, idempotency_key: 'payment-A' } });
    const second = await app.inject({ method: 'POST', url: '/api/events',
      payload: { ...body, idempotency_key: 'payment-B' } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().event.id).not.toBe(second.json().event.id);
  });
});
