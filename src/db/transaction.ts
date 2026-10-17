import type { Pool, PoolClient } from 'pg';

// Use one checked-out connection for each short database transaction.
export async function inTransaction<T>(pool: Pick<Pool, 'connect'>,
  action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroyConnection = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { destroyConnection = true; }
    throw error;
  } finally { client.release(destroyConnection); }
}
