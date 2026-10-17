import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Client } from 'pg';

export const migrationsDirectory = new URL('../migrations/', import.meta.url);

// Use one dedicated connection: transactions and session locks belong to it.
export async function runMigrations(client: Client, directory: URL = migrationsDirectory): Promise<string[]> {
  const names = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (names.length === 0) throw new Error('No SQL migration files found');
  const files = await Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));

  // Serialize migration commands so two processes cannot apply the same file.
  await client.query('SELECT pg_advisory_lock(724631, 1)');
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    const applied = new Map(result.rows.map(row => [row.name, row.checksum]));
    for (const row of result.rows) {
      if (!names.includes(row.name)) throw new Error(`Applied migration is missing: ${row.name}`);
    }
    // Validate history before applying anything new. Published SQL is immutable.
    for (const file of files) {
      const checksum = applied.get(file.name);
      if (checksum !== undefined && checksum !== file.checksum) {
        throw new Error(`Applied migration was modified: ${file.name}. Add a new migration instead.`);
      }
      if (checksum === undefined && result.rows.some(row => row.name > file.name)) {
        throw new Error(`Migration is out of order: ${file.name}`);
      }
    }

    const executed: string[] = [];
    for (const file of files) {
      if (applied.has(file.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file.name, file.checksum]);
        await client.query('COMMIT');
        executed.push(file.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return executed;
  } finally {
    await client.query('SELECT pg_advisory_unlock(724631, 1)');
  }
}
