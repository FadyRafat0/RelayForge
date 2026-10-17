import type { Pool } from 'pg';
import { inTransaction } from '../db/transaction.js';
import type { WebhookRequest } from './http.js';

export const WORKER_LEASE_MS = 30000;
export interface ClaimOptions { workerId?: string; leaseDurationMs?: number }
export interface DeliveryClaim {
  deliveryId: string;
  endpointId: string;
  attemptId: string;
  attemptNumber: number;
  maxAttempts: number;
  request: WebhookRequest;
}
interface DeliveryRow {
  id: string; endpoint_id: string; url: string; signing_secret: string; attempt_count: number; max_attempts: number;
  event_id: string; type: string; payload: Record<string, unknown>; event_created_at: Date;
}

export async function claimDelivery(pool: Pick<Pool, 'connect'>, deliveryId: string,
  { workerId = 'worker', leaseDurationMs = WORKER_LEASE_MS }: ClaimOptions = {}): Promise<DeliveryClaim | null> {
  if (!workerId.trim() || workerId.length > 100) throw new Error('workerId must contain 1–100 characters');
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 10000 || leaseDurationMs > 300000) {
    throw new Error('leaseDurationMs must be between 10000 and 300000');
  }
  return inTransaction(pool, async client => {
    const selected = await client.query<DeliveryRow>(`SELECT d.id, d.endpoint_id, d.attempt_count, d.max_attempts,
      e.url, e.signing_secret, ev.id AS event_id, ev.type, ev.payload, ev.created_at AS event_created_at
      FROM deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
      JOIN events ev ON ev.id = d.event_id
      WHERE d.id = $1 AND d.status = 'pending' AND d.next_attempt_at <= clock_timestamp()
        AND d.attempt_count < d.max_attempts AND e.enabled = true
      -- This is a specific queued ID, not a scan for any available job.
      -- Wait for the publishing dispatcher's short transaction instead of
      -- skipping its lock and acknowledging work that is still pending.
      FOR UPDATE OF d`, [deliveryId]);
    const delivery = selected.rows[0];
    if (!delivery) return null;
    const attemptNumber = delivery.attempt_count + 1;
    const inserted = await client.query<{ id: string }>(`INSERT INTO delivery_attempts (delivery_id, attempt_number)
      VALUES ($1, $2) RETURNING id`, [deliveryId, attemptNumber]);
    const attemptId = inserted.rows[0]!.id;
    // A unique attempt UUID doubles as this claim's ownership/fencing token.
    await client.query(`UPDATE deliveries SET status = 'processing', attempt_count = $2,
      active_attempt_id = $3, lease_owner = $4,
      lease_expires_at = clock_timestamp() + $5 * interval '1 millisecond'
      WHERE id = $1`, [deliveryId, attemptNumber, attemptId, workerId, leaseDurationMs]);
    return { deliveryId, endpointId: delivery.endpoint_id, attemptId, attemptNumber, maxAttempts: delivery.max_attempts,
      request: { url: delivery.url, signingSecret: delivery.signing_secret, deliveryId, attemptNumber,
        event: { id: delivery.event_id, type: delivery.type, payload: delivery.payload,
          created_at: delivery.event_created_at.toISOString() } } };
  });
}
