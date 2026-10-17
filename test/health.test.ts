import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';

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
    createEndpoint: vi.fn<Database['createEndpoint']>(),
    updateEndpoint: vi.fn<Database['updateEndpoint']>(),
    listEndpoints: vi.fn<Database['listEndpoints']>(),
    check: vi.fn<Database['check']>().mockResolvedValue(undefined),
    close: vi.fn<Database['close']>().mockResolvedValue(undefined),
  };
  const app = buildApp(loadConfig({
    LOG_LEVEL: 'silent', DATABASE_URL: 'postgresql://test:test@localhost/test',
  }), database);
  apps.push(app);
  return { app, database };
}

describe('HTTP API', () => {
  it('reports API and database health as JSON', async () => {
    const { app, database } = setup();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ status: 'ok', service: 'relayforge', database: 'up' });
    expect(database.check).toHaveBeenCalledOnce();
  });

  it('returns 503 without exposing database errors, then recovers', async () => {
    const { app, database } = setup();
    database.check.mockRejectedValueOnce(new Error('private connection details'));
    const failed = await app.inject({ method: 'GET', url: '/health' });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ status: 'unavailable', service: 'relayforge', database: 'down' });
    expect(failed.body).not.toContain('private connection details');
    const recovered = await app.inject({ method: 'GET', url: '/health' });
    expect(recovered.statusCode).toBe(200);
  });

  it('closes the database when the app shuts down', async () => {
    const { app, database } = setup();
    await app.ready();
    await app.close();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('returns 404 for an unregistered route', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });
});
