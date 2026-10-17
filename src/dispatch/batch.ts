import type { Pool } from 'pg';
import type { DeliveryPublisher } from '../queue/redis.js';

export interface DispatchOptions {
  batchSize?: number;
  redeliveryAfterMs?: number;
}

export async function dispatchBatch(
  pool: Pick<Pool, 'connect'>,
  publisher: DeliveryPublisher,
  { batchSize = 10, redeliveryAfterMs = 60000 }: DispatchOptions = {},
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('batchSize must be between 1 and 100');
  }
  if (!Number.isSafeInteger(redeliveryAfterMs) || redeliveryAfterMs < 1000) {
    throw new Error('redeliveryAfterMs must be at least 1000');
  }
  const client = await pool.connect();
  let destroyConnection = false;
  try {
    await client.query('BEGIN');
    const deliveries = await client.query<{ id: string }>(`SELECT id FROM deliveries
      WHERE status = 'pending' AND next_attempt_at <= now()
        AND (last_enqueued_at IS NULL OR last_enqueued_at <= now() - $2 * interval '1 millisecond')
      ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batchSize, redeliveryAfterMs]);
    for (const delivery of deliveries.rows) {
      // Publish first. If marking/commit fails afterward, a retry may duplicate
      // this entry, but the database will not silently forget unqueued work.
      const streamId = await publisher.publish(delivery.id);
      await client.query(`UPDATE deliveries SET last_enqueued_at = clock_timestamp(), last_stream_id = $2
        WHERE id = $1`, [delivery.id, streamId]);
    }
    await client.query('COMMIT');
    return deliveries.rows.length;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { destroyConnection = true; }
    throw error;
  } finally {
    client.release(destroyConnection);
  }
}
