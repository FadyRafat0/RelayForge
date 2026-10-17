import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/migrations.js';
import { createTestDatabase } from '../helpers/database.js';

describe('Endpoint API with PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const apps: ReturnType<typeof buildApp>[] = [];
  beforeEach(async () => {
    database = await createTestDatabase();
    await runMigrations(database.client);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
    await database?.close();
  });

  function makeApp() {
    // The real application pool uses only this test's isolated schema.
    const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });
    const url = new URL(config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    const app = buildApp({ ...config, databaseUrl: url.toString() });
    apps.push(app);
    return app;
  }

  it('patches fields without resetting omitted values or changing the signing secret', async () => {
    const app = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/endpoints',
      payload: { name: 'Original', url: 'https://example.com/original', rate_limit_per_second: 3 } });
    const endpoint = created.json();
    const changed = await app.inject({ method: 'PATCH', url: `/api/endpoints/${endpoint.id}`,
      payload: { enabled: false, url: 'https://EXAMPLE.com/fixed', event_types: ['fixed.event'] } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ name: 'Original', url: 'https://example.com/fixed',
      event_types: ['fixed.event'], enabled: false, rate_limit_per_second: 3 });
    expect(changed.json()).not.toHaveProperty('signing_secret');
    const row = await database.client.query('SELECT signing_secret FROM webhook_endpoints WHERE id = $1', [endpoint.id]);
    expect(row.rows[0].signing_secret).toBe(endpoint.signing_secret);
    const event = await app.inject({ method: 'POST', url: '/api/events', payload: { type: 'fixed.event', payload: {} } });
    expect(event.json().delivery_count).toBe(0);
    const resumed = await app.inject({ method: 'PATCH', url: `/api/endpoints/${endpoint.id}`,
      payload: { enabled: true, rate_limit_per_second: 7 } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().rate_limit_per_second).toBe(7);
    const next = await app.inject({ method: 'POST', url: '/api/events', payload: { type: 'fixed.event', payload: {} } });
    expect(next.json().delivery_count).toBe(1);
  });

  it('does not turn a missing endpoint update into a registration', async () => {
    const response = await makeApp().inject({ method: 'PATCH',
      url: '/api/endpoints/00000000-0000-4000-8000-000000000001', payload: { enabled: false } });
    expect(response.statusCode).toBe(404);
    const rows = await database.client.query('SELECT count(*)::integer AS count FROM webhook_endpoints');
    expect(rows.rows[0].count).toBe(0);
  });

  it('persists registration and can list it from a newly created app', async () => {
    const app = makeApp();
    const response = await app.inject({ method: 'POST', url: '/api/endpoints',
      payload: { name: 'Payment receiver', url: 'https://example.com/hooks' } });
    expect(response.statusCode).toBe(201);
    const endpoint = response.json();
    expect(endpoint.signing_secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(response.headers['cache-control']).toBe('no-store');
    const { signing_secret, ...publicEndpoint } = endpoint;
    const key = await database.client.query('SELECT signing_secret FROM webhook_endpoints WHERE id = $1', [endpoint.id]);
    expect(key.rows[0].signing_secret).toBe(signing_secret);
    expect(endpoint).toMatchObject({ name: 'Payment receiver', url: 'https://example.com/hooks',
      event_types: ['*'], enabled: true, rate_limit_per_second: 10 });
    expect(endpoint.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(endpoint.created_at))).toBe(false);
    const saved = await database.client.query('SELECT name, url FROM webhook_endpoints WHERE id = $1', [endpoint.id]);
    expect(saved.rows).toEqual([{ name: endpoint.name, url: endpoint.url }]);
    await app.close();
    const secondApp = makeApp();
    const listed = await secondApp.inject({ method: 'GET', url: '/api/endpoints' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ endpoints: [publicEndpoint], limit: 20, offset: 0 });
  });

  it('stores explicit subscriptions and a disabled endpoint', async () => {
    const payload = { name: 'Paused receiver', url: 'http://localhost:8080/hooks',
      event_types: ['payment.succeeded', 'payment.failed'], enabled: false };
    const response = await makeApp().inject({ method: 'POST', url: '/api/endpoints', payload });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject(payload);
    const saved = await database.client.query('SELECT enabled, event_types FROM webhook_endpoints');
    expect(saved.rows).toEqual([{ enabled: false, event_types: payload.event_types }]);
  });

  it('persists a custom rate limit and rejects invalid SQL writes', async () => {
    const response = await makeApp().inject({ method: 'POST', url: '/api/endpoints',
      payload: { name: 'Limited receiver', url: 'https://example.com/hooks', rate_limit_per_second: 2 } });
    expect(response.statusCode).toBe(201);
    const saved = await database.client.query('SELECT rate_limit_per_second FROM webhook_endpoints');
    expect(saved.rows).toEqual([{ rate_limit_per_second: 2 }]);
    for (const invalid of [0, 1001]) {
      await expect(database.client.query('UPDATE webhook_endpoints SET rate_limit_per_second = $1', [invalid]))
        .rejects.toMatchObject({ code: '23514' });
    }
  });

  it('stores SQL-like input as data without executing it', async () => {
    const name = "Receiver'); DROP TABLE events; --";
    const response = await makeApp().inject({ method: 'POST', url: '/api/endpoints',
      payload: { name, url: 'https://example.com/hooks' } });
    expect(response.statusCode).toBe(201);
    const saved = await database.client.query('SELECT name FROM webhook_endpoints');
    expect(saved.rows).toEqual([{ name }]);
    const events = await database.client.query('SELECT count(*)::integer AS count FROM events');
    expect(events.rows[0].count).toBe(0);
  });

  it('paginates newest-first with a stable UUID tie-breaker', async () => {
    const ids = ['00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
    for (const id of ids) {
      await database.client.query(`INSERT INTO webhook_endpoints (id, name, url, created_at)
        VALUES ($1, 'receiver', 'https://example.com', '2026-01-01T00:00:00Z')`, [id]);
    }
    const app = makeApp();
    const first = await app.inject({ method: 'GET', url: '/api/endpoints?limit=2' });
    expect(first.statusCode).toBe(200);
    expect(first.json().endpoints.map((endpoint: { id: string }) => endpoint.id)).toEqual([ids[2], ids[1]]);
    const next = await app.inject({ method: 'GET', url: '/api/endpoints?limit=2&offset=2' });
    expect(next.json().endpoints.map((endpoint: { id: string }) => endpoint.id)).toEqual([ids[0]]);
    const beyond = await app.inject({ method: 'GET', url: '/api/endpoints?offset=3' });
    expect(beyond.json().endpoints).toEqual([]);
  });

  it('does not write invalid registrations', async () => {
    const response = await makeApp().inject({ method: 'POST', url: '/api/endpoints',
      payload: { name: 'receiver', url: 'ftp://example.com' } });
    expect(response.statusCode).toBe(400);
    const rows = await database.client.query('SELECT count(*)::integer AS count FROM webhook_endpoints');
    expect(rows.rows[0].count).toBe(0);
  });
});
