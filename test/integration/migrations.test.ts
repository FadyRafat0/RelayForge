import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrations.js';
import { loadConfig } from '../../src/config.js';
import { createTestDatabase } from '../helpers/database.js';

const migrationNames = ['001_initial_schema.sql', '002_dispatch_tracking.sql', '003_worker_leases.sql',
  '004_endpoint_signing.sql', '005_receiver_inbox.sql', '006_delivery_replays.sql', '007_endpoint_rate_limits.sql'];

describe('SQL migration runner', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => { database = await createTestDatabase(); });
  afterEach(async () => { await database?.close(); });

  it('creates the schema and does not reapply completed migrations', async () => {
    expect(await runMigrations(database.client)).toEqual(migrationNames);
    expect(await runMigrations(database.client)).toEqual([]);
    const result = await database.client.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(result.rows).toEqual(migrationNames.map(name => ({ name })));
  });

  it('rolls back partial DDL and does not mark a failed migration as applied', async () => {
    await expect(runMigrations(database.client, new URL('../fixtures/broken-migration/', import.meta.url)))
      .rejects.toMatchObject({ code: '42P01' });
    const table = await database.client.query("SELECT to_regclass('should_be_rolled_back') AS name");
    expect(table.rows[0].name).toBeNull();
    const ledger = await database.client.query('SELECT name FROM schema_migrations');
    expect(ledger.rows).toEqual([]);
    // A later valid run still works after the failed transaction.
    expect(await runMigrations(database.client)).toEqual(migrationNames);
  });

  it('rejects a checksum mismatch instead of silently accepting changed history', async () => {
    await runMigrations(database.client);
    await database.client.query("UPDATE schema_migrations SET checksum = 'mismatch'");
    await expect(runMigrations(database.client)).rejects.toThrow('Applied migration was modified');
  });

  it('serializes two concurrent migration commands', async () => {
    const second = new Client({ connectionString: loadConfig().databaseUrl, connectionTimeoutMillis: 2000 });
    await second.connect();
    try {
      await second.query("SELECT set_config('search_path', $1, false)", [database.schema]);
      const results = await Promise.all([runMigrations(database.client), runMigrations(second)]);
      expect(results.flat()).toEqual(migrationNames);
    } finally {
      await second.end();
    }
  });

  it('upgrades interrupted legacy workers without losing attempt history or budget', async () => {
    for (const name of migrationNames.slice(0, 2)) {
      await database.client.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
    }
    await database.client.query(`WITH endpoint AS (
      INSERT INTO webhook_endpoints (name, url) VALUES ('legacy', 'https://example.com') RETURNING id
    ), event AS (
      INSERT INTO events (type, payload) VALUES ('legacy.event', '{}') RETURNING id
    ), delivery AS (
      INSERT INTO deliveries (event_id, endpoint_id, status, attempt_count)
      SELECT event.id, endpoint.id, 'processing', 1 FROM event, endpoint RETURNING id
    ) INSERT INTO delivery_attempts (delivery_id, attempt_number) SELECT id, 1 FROM delivery`);
    await database.client.query(await readFile(new URL('../../migrations/003_worker_leases.sql', import.meta.url), 'utf8'));
    const rows = await database.client.query(`SELECT d.status, d.attempt_count, d.active_attempt_id, a.outcome
      FROM deliveries d JOIN delivery_attempts a ON a.delivery_id = d.id`);
    expect(rows.rows).toEqual([{ status: 'pending', attempt_count: 1, active_attempt_id: null, outcome: 'abandoned' }]);
  });

  it('backfills a distinct signing secret per existing endpoint and enforces its format', async () => {
    for (const name of migrationNames.slice(0, 3)) {
      await database.client.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
    }
    await database.client.query(`INSERT INTO webhook_endpoints (name, url)
      VALUES ('first', 'https://example.com/1'), ('second', 'https://example.com/2')`);
    await database.client.query(await readFile(new URL('../../migrations/004_endpoint_signing.sql', import.meta.url), 'utf8'));
    await database.client.query(`INSERT INTO webhook_endpoints (name, url) VALUES ('third', 'https://example.com/3')`);
    const result = await database.client.query<{ signing_secret: string }>('SELECT signing_secret FROM webhook_endpoints');
    expect(new Set(result.rows.map(row => row.signing_secret)).size).toBe(3);
    for (const row of result.rows) expect(row.signing_secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    await expect(database.client.query("UPDATE webhook_endpoints SET signing_secret = 'invalid'"))
      .rejects.toMatchObject({ code: '23514' });
  });
  it('adds a default rate limit to existing endpoints without modifying their identity', async () => {
    for (const name of migrationNames.slice(0, 6)) {
      await database.client.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
    }
    const before = await database.client.query(`INSERT INTO webhook_endpoints (name, url)
      VALUES ('existing', 'https://example.com/hooks') RETURNING id, signing_secret`);
    await database.client.query(await readFile(new URL('../../migrations/007_endpoint_rate_limits.sql', import.meta.url), 'utf8'));
    const after = await database.client.query('SELECT id, signing_secret, rate_limit_per_second FROM webhook_endpoints');
    expect(after.rows).toEqual([{ ...before.rows[0], rate_limit_per_second: 10 }]);
  });
});
