import type { Pool } from 'pg';
import { inTransaction } from '../db/transaction.js';

export interface Page { limit: number; offset: number }
export interface Delivery {
  id: string; event_id: string; endpoint_id: string;
  status: 'pending' | 'processing' | 'succeeded' | 'dead';
  attempt_count: number; max_attempts: number;
  next_attempt_at: string; completed_at: string | null; created_at: string; updated_at: string;
}
export interface Attempt {
  id: string; attempt_number: number; outcome: 'in_progress' | 'succeeded' | 'failed' | 'abandoned';
  http_status: number | null; error_message: string | null; started_at: string; finished_at: string | null;
}
export interface Replay {
  id: string; reason: string; previous_attempt_count: number; previous_max_attempts: number;
  additional_attempts: number; replayed_at: string;
}
export interface DeliveryDetail extends Delivery {
  endpoint_enabled: boolean; event_type: string; last_attempt: Attempt | null; last_replay: Replay | null;
}
export interface ReplayRequest { expected_attempt_count: number; additional_attempts: number; reason: string }
export interface ReplayResult { delivery: Delivery; replay: Replay }
export class ReplayConflictError extends Error {}
export interface DeliveryStore {
  listDeadDeliveries(page: Page): Promise<Delivery[]>;
  getDelivery(id: string): Promise<DeliveryDetail | null>;
  listDeliveryAttempts(id: string, page: Page): Promise<Attempt[] | null>;
  replayDelivery(id: string, input: ReplayRequest): Promise<ReplayResult | null>;
}
interface DeliveryRow extends Omit<Delivery, 'next_attempt_at' | 'completed_at' | 'created_at' | 'updated_at'> {
  next_attempt_at: Date; completed_at: Date | null; created_at: Date; updated_at: Date;
}
const columns = `d.id, d.event_id, d.endpoint_id, d.status, d.attempt_count, d.max_attempts,
  d.next_attempt_at, d.completed_at, d.created_at, d.updated_at`;
function toDelivery(row: DeliveryRow): Delivery {
  return { id: row.id, event_id: row.event_id, endpoint_id: row.endpoint_id, status: row.status,
    attempt_count: row.attempt_count, max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at.toISOString(), completed_at: row.completed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}

export function createDeliveryStore(pool: Pick<Pool, 'query' | 'connect'>): DeliveryStore {
  return {
    async listDeadDeliveries({ limit, offset }) {
      const result = await pool.query<DeliveryRow>(`SELECT ${columns} FROM deliveries d
        WHERE d.status = 'dead' ORDER BY d.completed_at DESC, d.id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
      return result.rows.map(toDelivery);
    },
    async getDelivery(id) {
      // One statement gives a consistent view of the delivery and its latest history.
      const result = await pool.query<DeliveryRow & Pick<DeliveryDetail,
        'endpoint_enabled' | 'event_type' | 'last_attempt' | 'last_replay'>>(`SELECT ${columns},
        e.enabled AS endpoint_enabled, ev.type AS event_type,
        row_to_json(a) AS last_attempt, row_to_json(r) AS last_replay
        FROM deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        JOIN events ev ON ev.id = d.event_id
        LEFT JOIN LATERAL (SELECT id, attempt_number, outcome, http_status, error_message, started_at, finished_at
          FROM delivery_attempts WHERE delivery_id = d.id ORDER BY attempt_number DESC LIMIT 1) a ON true
        LEFT JOIN LATERAL (SELECT id, reason, previous_attempt_count, previous_max_attempts,
          additional_attempts, replayed_at FROM delivery_replays WHERE delivery_id = d.id
          ORDER BY previous_attempt_count DESC LIMIT 1) r ON true
        WHERE d.id = $1`, [id]);
      const row = result.rows[0];
      return row ? { ...toDelivery(row), endpoint_enabled: row.endpoint_enabled, event_type: row.event_type,
        last_attempt: row.last_attempt, last_replay: row.last_replay } : null;
    },
    async listDeliveryAttempts(id, { limit, offset }) {
      const exists = await pool.query('SELECT id FROM deliveries WHERE id = $1', [id]);
      if (!exists.rowCount) return null;
      const result = await pool.query<Omit<Attempt, 'started_at' | 'finished_at'> & {
        started_at: Date; finished_at: Date | null }>(`SELECT id, attempt_number, outcome, http_status,
        error_message, started_at, finished_at FROM delivery_attempts WHERE delivery_id = $1
        ORDER BY attempt_number DESC LIMIT $2 OFFSET $3`, [id, limit, offset]);
      return result.rows.map(row => ({ ...row, started_at: row.started_at.toISOString(),
        finished_at: row.finished_at?.toISOString() ?? null }));
    },
    async replayDelivery(id, input) {
      return inTransaction(pool, async client => {
        const result = await client.query<DeliveryRow & { endpoint_enabled: boolean }>(`SELECT ${columns},
          e.enabled AS endpoint_enabled FROM deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.id = $1 FOR UPDATE OF d FOR SHARE OF e`, [id]);
        const row = result.rows[0];
        if (!row) return null;
        if (row.status !== 'dead') throw new ReplayConflictError('Only dead deliveries can be replayed');
        if (row.attempt_count !== input.expected_attempt_count) {
          throw new ReplayConflictError('Delivery changed; inspect it again before replaying');
        }
        if (!row.endpoint_enabled) throw new ReplayConflictError('Enable the endpoint before replaying');
        if (row.attempt_count > 2147483647 - input.additional_attempts) {
          throw new ReplayConflictError('Delivery attempt counter limit reached');
        }
        const audit = await client.query<Omit<Replay, 'replayed_at'> & { replayed_at: Date }>(`INSERT INTO delivery_replays
          (delivery_id, reason, previous_attempt_count, previous_max_attempts, additional_attempts)
          VALUES ($1, $2, $3, $4, $5) RETURNING id, reason, previous_attempt_count, previous_max_attempts,
          additional_attempts, replayed_at`,
        [id, input.reason, row.attempt_count, row.max_attempts, input.additional_attempts]);
        const updated = await client.query<DeliveryRow>(`UPDATE deliveries d SET status = 'pending',
          max_attempts = attempt_count + $2, completed_at = NULL, next_attempt_at = clock_timestamp(),
          last_enqueued_at = NULL, last_stream_id = NULL WHERE id = $1 RETURNING ${columns}`,
        [id, input.additional_attempts]);
        const replay = audit.rows[0]!;
        return { delivery: toDelivery(updated.rows[0]!),
          replay: { ...replay, replayed_at: replay.replayed_at.toISOString() } };
      });
    },
  };
}
