import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { inTransaction } from '../db/transaction.js';

export type InboxResult = 'processed' | 'duplicate' | 'conflict' | 'ignored';
export interface ReceiverInbox {
  // Chaos failures may check existing receipts, but must not apply a new effect.
  receive(deliveryId: string, body: Buffer, applyEffect: boolean): Promise<InboxResult>;
}
export class ReceiverPayloadError extends Error {}

export function createReceiverInbox(pool: Pick<Pool, 'connect'>, receiverId: string): ReceiverInbox {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(receiverId)) {
    throw new Error('RECEIVER_ID must contain 1–100 letters, digits, dots, underscores, or hyphens');
  }
  return {
    async receive(deliveryId, body, applyEffect) {
      let event: unknown;
      try { event = JSON.parse(body.toString('utf8')); }
      catch { throw new ReceiverPayloadError('Expected a JSON object'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new ReceiverPayloadError('Expected a JSON object');
      }
      const hash = createHash('sha256').update(body).digest('hex');
      return inTransaction(pool, async client => {
        if (applyEffect) {
          // The unique key makes concurrent requests wait for the winner's outcome.
          const inserted = await client.query(`INSERT INTO receiver_receipts (receiver_id, delivery_id, body_sha256)
            VALUES ($1, $2, $3) ON CONFLICT (receiver_id, delivery_id) DO NOTHING RETURNING delivery_id`,
          [receiverId, deliveryId, hash]);
          if (inserted.rowCount === 1) {
            // This INSERT is the example business effect. Keep real SQL effects in this same transaction.
            await client.query(`INSERT INTO receiver_effects (receiver_id, delivery_id, event)
              VALUES ($1, $2, $3::jsonb)`, [receiverId, deliveryId, JSON.stringify(event)]);
            return 'processed';
          }
        }
        // A separate READ COMMITTED statement sees a competing insert after it commits.
        const existing = await client.query<{ body_sha256: string }>(`SELECT body_sha256
          FROM receiver_receipts WHERE receiver_id = $1 AND delivery_id = $2`, [receiverId, deliveryId]);
        const receipt = existing.rows[0];
        if (!receipt) {
          if (applyEffect) throw new Error('Conflicting receiver receipt disappeared');
          return 'ignored';
        }
        return receipt.body_sha256 === hash ? 'duplicate' : 'conflict';
      });
    },
  };
}
