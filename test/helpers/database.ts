import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { loadConfig } from '../../src/config.js';

// Every test suite gets its own schema; never truncate application tables.
export async function createTestDatabase() {
  const schema = `relayforge_test_${randomUUID().replaceAll('-', '')}`;
  const config = loadConfig(process.env);
  const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 2000 });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query("SELECT set_config('search_path', $1, false)", [schema]);
  } catch (error) {
    await client.end();
    throw error;
  }
  return {
    client,
    schema,
    async close() {
      try {
        await client.query('ROLLBACK');
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await client.end();
      }
    },
  };
}
