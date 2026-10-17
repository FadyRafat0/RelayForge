import type { Pool } from 'pg';
import { inTransaction } from '../db/transaction.js';
import { decideRetry, type RetryOptions } from './retry.js';

interface ExpiredClaim { id: string; active_attempt_id: string; attempt_count: number; max_attempts: number }

export async function recoverExpiredLeases(pool: Pick<Pool, 'connect'>,
  { batchSize = 10, ...retryOptions }: RetryOptions & { batchSize?: number } = {}): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('batchSize must be between 1 and 100');
  return inTransaction(pool, async client => {
    const expired = await client.query<ExpiredClaim>(`SELECT id, active_attempt_id, attempt_count, max_attempts
      FROM deliveries WHERE status = 'processing' AND lease_expires_at <= clock_timestamp()
      ORDER BY lease_expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batchSize]);
    for (const row of expired.rows) {
      const decision = decideRetry({ attemptNumber: row.attempt_count, maxAttempts: row.max_attempts,
        status: null, error: new Error('Worker lease expired') }, retryOptions);
      const terminal = decision.kind !== 'retry';
      const attempt = await client.query(`UPDATE delivery_attempts SET outcome = 'abandoned',
        error_message = $2, finished_at = clock_timestamp()
        WHERE id = $1 AND outcome = 'in_progress' RETURNING id`,
      [row.active_attempt_id, `Worker lease expired; HTTP outcome unknown [${terminal ? 'attempt_limit_reached' : 'lease_expired'}]`]);
      if (attempt.rowCount !== 1) throw new Error('Expired claim has no in-progress attempt');
      await client.query(`UPDATE deliveries SET status = $2,
        completed_at = CASE WHEN $3::boolean THEN clock_timestamp() ELSE NULL END,
        next_attempt_at = CASE WHEN $3::boolean THEN next_attempt_at ELSE clock_timestamp() + $4 * interval '1 millisecond' END,
        active_attempt_id = NULL, lease_expires_at = NULL, lease_owner = NULL,
        last_enqueued_at = NULL, last_stream_id = NULL WHERE id = $1`,
      [row.id, terminal ? 'dead' : 'pending', terminal, decision.kind === 'retry' ? decision.delayMs : 0]);
    }
    return expired.rows.length;
  });
}
