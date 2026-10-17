import type { Pool } from 'pg';

export interface NewEvent {
  type: string;
  payload: Record<string, unknown>;
  idempotency_key?: string;
}

export interface AcceptedEvent {
  event: { id: string; type: string; created_at: string };
  delivery_count: number;
  replayed: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with different event data');
    this.name = 'IdempotencyConflictError';
  }
}

export interface EventStore {
  ingestEvent(input: NewEvent): Promise<AcceptedEvent>;
}

interface EventRow {
  id: string;
  type: string;
  created_at: Date;
}

export function createEventStore(pool: Pick<Pool, 'connect'>): EventStore {
  return {
    async ingestEvent(input) {
      // Every statement must use this same connection, not pool.query().
      const client = await pool.connect();
      let destroyConnection = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const payload = JSON.stringify(input.payload);
        // The unique constraint arbitrates competing requests, even across API processes.
        // NULL keys do not conflict: unkeyed requests still create distinct events.
        const inserted = await client.query<EventRow>(`INSERT INTO events (type, payload, idempotency_key)
          VALUES ($1, $2::jsonb, $3) ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id, type, created_at`, [input.type, payload, input.idempotency_key ?? null]);
        const event = inserted.rows[0];
        if (!event) {
          // This separate statement gets a fresh Read Committed snapshot after
          // ON CONFLICT has waited for the original transaction to finish.
          const existing = await client.query<EventRow & { matches: boolean; delivery_count: number }>(`SELECT
            e.id, e.type, e.created_at, (e.type = $2 AND e.payload = $3::jsonb) AS matches,
            (SELECT count(*)::integer FROM deliveries d WHERE d.event_id = e.id) AS delivery_count
            FROM events e WHERE e.idempotency_key = $1`, [input.idempotency_key, input.type, payload]);
          const original = existing.rows[0];
          if (!original) throw new Error('Conflicting event was not found');
          if (!original.matches) throw new IdempotencyConflictError();
          const result: AcceptedEvent = {
            event: { id: original.id, type: original.type, created_at: original.created_at.toISOString() },
            delivery_count: original.delivery_count,
            replayed: true,
          };
          await client.query('COMMIT');
          return result;
        }

        // One row per matching endpoint, even if it subscribes more than once.
        // Matching is exact and case-sensitive; '*' means all event types.
        const deliveries = await client.query(`INSERT INTO deliveries (event_id, endpoint_id)
          SELECT $1::uuid, id FROM webhook_endpoints
          WHERE enabled = true AND ($2::text = ANY(event_types) OR '*' = ANY(event_types))`,
        [event.id, input.type]);

        const result: AcceptedEvent = {
          event: { id: event.id, type: event.type, created_at: event.created_at.toISOString() },
          delivery_count: deliveries.rowCount ?? 0,
          replayed: false,
        };
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Never return a connection in an unknown transaction state to the pool.
          destroyConnection = true;
        }
        throw error;
      } finally {
        client.release(destroyConnection);
      }
    },
  };
}
