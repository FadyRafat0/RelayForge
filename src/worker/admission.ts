import type { Pool } from 'pg';
import { inTransaction } from '../db/transaction.js';
import type { EndpointRateLimiter } from './rate-limit.js';

export async function admitDelivery(pool: Pick<Pool, 'connect'>, deliveryId: string,
  limiter: EndpointRateLimiter): Promise<'allowed' | 'rate_limited' | 'skipped'> {
  const candidate = await inTransaction(pool, async client => {
    const result = await client.query<{ endpoint_id: string; rate_limit_per_second: number; attempt_count: number }>(
      `SELECT d.endpoint_id, e.rate_limit_per_second, d.attempt_count
       FROM deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE d.id = $1 AND d.status = 'pending' AND d.next_attempt_at <= clock_timestamp()
         AND d.attempt_count < d.max_attempts AND e.enabled = true`, [deliveryId]);
    return result.rows[0];
  });
  if (!candidate) return 'skipped';
  // No database connection or row lock spans the Redis request.
  const decision = await limiter.acquire(candidate.endpoint_id, candidate.rate_limit_per_second);
  if (decision.allowed) return 'allowed';
  if (!Number.isInteger(decision.retryAfterMs) || decision.retryAfterMs < 1 || decision.retryAfterMs > 1000) {
    throw new Error('Invalid rate-limit delay');
  }
  return inTransaction(pool, async client => {
    // A competing worker may already own it or have scheduled real retry backoff.
    // Never shorten that schedule, mutate a live lease, or consume an attempt.
    const result = await client.query(`UPDATE deliveries SET
      next_attempt_at = clock_timestamp() + $2 * interval '1 millisecond',
      last_enqueued_at = NULL, last_stream_id = NULL
      WHERE id = $1 AND status = 'pending' AND attempt_count = $3
        AND next_attempt_at <= clock_timestamp() RETURNING id`,
    [deliveryId, decision.retryAfterMs, candidate.attempt_count]);
    return result.rowCount === 1 ? 'rate_limited' : 'skipped';
  });
}
