import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

describe('PostgreSQL health integration', () => {
  it('executes SQL against the configured PostgreSQL database', async () => {
    const app = buildApp(loadConfig({ ...process.env, LOG_LEVEL: 'silent' }));
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'relayforge', database: 'up' });
  });

  it('reports authentication failure as unavailable', async () => {
    const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });
    const url = new URL(config.databaseUrl);
    url.password = 'deliberately-wrong-integration-password';
    const app = buildApp({ ...config, databaseUrl: url.toString() });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'unavailable', service: 'relayforge', database: 'down',
    });
  });
});
