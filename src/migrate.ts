import { Client } from 'pg';
import { loadConfig } from './config.js';
import { runMigrations } from './migrations.js';

const config = loadConfig();
const client = new Client({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 2000,
  statement_timeout: 10000,
  lock_timeout: 5000,
  application_name: 'relayforge-migrations',
});

try {
  await client.connect();
  const applied = await runMigrations(client);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
} finally {
  await client.end();
}
