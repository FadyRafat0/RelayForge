// Local demo provisioning only. Normal clients register endpoints through the API.
import { Client } from 'pg';
import { loadConfig } from './config.js';
import { runMigrations } from './migrations.js';

const client = new Client({ connectionString: loadConfig().databaseUrl,
  connectionTimeoutMillis: 5000, statement_timeout: 10000, lock_timeout: 5000 });
try {
  await client.connect();
  await runMigrations(client);
  // Repeated starts preserve the secret and any endpoint edits made during exercises.
  await client.query(`INSERT INTO webhook_endpoints (id, name, url, event_types, rate_limit_per_second)
    VALUES ('00000000-0000-4000-8000-000000000001', 'Docker demo receiver',
      'http://127.0.0.1:8080/webhooks', ARRAY['demo.event', 'benchmark.event'], 1000)
    ON CONFLICT (id) DO NOTHING`);
  console.log('Demo database ready; endpoint 00000000-0000-4000-8000-000000000001');
} catch {
  console.error('Demo provisioning failed; check PostgreSQL and migration history');
  process.exitCode = 1;
} finally { await client.end(); }
