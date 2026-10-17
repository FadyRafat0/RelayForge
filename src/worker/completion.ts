import type { Pool } from 'pg';
import { inTransaction } from '../db/transaction.js';
import type { DeliveryClaim } from './claims.js';
import type { RetryDecision } from './retry.js';

export type DeliveryOutcome = 'succeeded' | 'retry_scheduled' | 'dead' | 'skipped' | 'lost_lease';
export interface AttemptResult { decision: RetryDecision; httpStatus: number | null; errorMessage: string | null }

export async function completeDelivery(pool: Pick<Pool, 'connect'>, claim: DeliveryClaim,
  result: AttemptResult): Promise<DeliveryOutcome> {
  return inTransaction(pool, async client => {
    const owned = await client.query(`SELECT id FROM deliveries
      WHERE id = $1 AND status = 'processing' AND active_attempt_id = $2 FOR UPDATE`,
    [claim.deliveryId, claim.attemptId]);
    if (!owned.rowCount) return 'lost_lease';
    const succeeded = result.decision.kind === 'succeeded';
    const terminal = result.decision.kind !== 'retry';
    const status = succeeded ? 'succeeded' : terminal ? 'dead' : 'pending';
    // Check expiry in a fresh statement after acquiring the lock. A stale
    // worker can never clear or replace a newer attempt's ownership token.
    const updated = await client.query(`UPDATE deliveries SET status = $3,
      completed_at = CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END,
      next_attempt_at = CASE WHEN $4::boolean THEN next_attempt_at ELSE clock_timestamp() + $5 * interval '1 millisecond' END,
      active_attempt_id = NULL, lease_expires_at = NULL, lease_owner = NULL,
      last_enqueued_at = NULL, last_stream_id = NULL
      WHERE id = $1 AND active_attempt_id = $2 AND lease_expires_at > clock_timestamp() RETURNING id`,
    [claim.deliveryId, claim.attemptId, status, terminal, result.decision.kind === 'retry' ? result.decision.delayMs : 0]);
    if (!updated.rowCount) return 'lost_lease';
    const attempt = await client.query(`UPDATE delivery_attempts SET outcome = $2, http_status = $3,
      error_message = $4, finished_at = clock_timestamp() WHERE id = $1 AND outcome = 'in_progress' RETURNING id`,
    [claim.attemptId, succeeded ? 'succeeded' : 'failed', result.httpStatus, result.errorMessage]);
    if (attempt.rowCount !== 1) throw new Error('Active attempt is not in progress');
    return succeeded ? 'succeeded' : terminal ? 'dead' : 'retry_scheduled';
  });
}
