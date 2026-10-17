import type { Pool } from 'pg';

export const deliveryStates = ['pending', 'processing', 'succeeded', 'dead'] as const;
export const attemptOutcomes = ['in_progress', 'succeeded', 'failed', 'abandoned'] as const;
export interface MetricsSnapshot {
  deliveries: Record<typeof deliveryStates[number], number>;
  attempts: Record<typeof attemptOutcomes[number], number>;
  due: number;
  oldest_due_lag_seconds: number;
  expired_leases: number;
  replays: number;
}
export interface MetricsStore { readMetrics(): Promise<MetricsSnapshot> }
type MetricsRow = Record<`deliveries_${typeof deliveryStates[number]}` | `attempts_${typeof attemptOutcomes[number]}`
  | 'due' | 'oldest_due_lag_seconds' | 'expired_leases' | 'replays', number>;

export function createMetricsStore(pool: Pick<Pool, 'query'>): MetricsStore {
  // This expression contains no input values. A due obligation must actually be sendable.
  const eligible = `d.status = 'pending' AND e.enabled AND d.attempt_count < d.max_attempts
    AND d.next_attempt_at <= statement_timestamp()`;
  return {
    async readMetrics() {
      // One SQL statement gives all gauges one MVCC snapshot and one clock reference.
      const result = await pool.query<MetricsRow>(`WITH delivery_stats AS (SELECT
        count(*) FILTER (WHERE d.status = 'pending')::double precision AS deliveries_pending,
        count(*) FILTER (WHERE d.status = 'processing')::double precision AS deliveries_processing,
        count(*) FILTER (WHERE d.status = 'succeeded')::double precision AS deliveries_succeeded,
        count(*) FILTER (WHERE d.status = 'dead')::double precision AS deliveries_dead,
        count(*) FILTER (WHERE ${eligible})::double precision AS due,
        COALESCE(max(extract(epoch FROM (statement_timestamp() - d.next_attempt_at)))
          FILTER (WHERE ${eligible}), 0)::double precision AS oldest_due_lag_seconds,
        count(*) FILTER (WHERE d.status = 'processing' AND d.lease_expires_at <= statement_timestamp())
          ::double precision AS expired_leases
        FROM deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id),
      attempt_stats AS (SELECT
        count(*) FILTER (WHERE outcome = 'in_progress')::double precision AS attempts_in_progress,
        count(*) FILTER (WHERE outcome = 'succeeded')::double precision AS attempts_succeeded,
        count(*) FILTER (WHERE outcome = 'failed')::double precision AS attempts_failed,
        count(*) FILTER (WHERE outcome = 'abandoned')::double precision AS attempts_abandoned
        FROM delivery_attempts)
      SELECT delivery_stats.*, attempt_stats.*,
        (SELECT count(*)::double precision FROM delivery_replays) AS replays
        FROM delivery_stats CROSS JOIN attempt_stats`);
      const row = result.rows[0];
      if (!row) throw new Error('Metrics query returned no snapshot');
      return {
        deliveries: { pending: row.deliveries_pending, processing: row.deliveries_processing,
          succeeded: row.deliveries_succeeded, dead: row.deliveries_dead },
        attempts: { in_progress: row.attempts_in_progress, succeeded: row.attempts_succeeded,
          failed: row.attempts_failed, abandoned: row.attempts_abandoned },
        due: row.due, oldest_due_lag_seconds: row.oldest_due_lag_seconds,
        expired_leases: row.expired_leases, replays: row.replays,
      };
    },
  };
}

export function formatMetrics(snapshot: MetricsSnapshot): string {
  function value(number: number) {
    if (!Number.isFinite(number) || number < 0) throw new Error('Invalid metrics snapshot');
    return String(number);
  }
  function gauge(name: string, help: string, samples: string[]) {
    return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples];
  }
  // Only fixed labels are emitted: no delivery IDs, URLs, payloads, or endpoint IDs.
  return [
    ...gauge('relayforge_deliveries', 'Current persisted deliveries by state.', deliveryStates.map(status =>
      `relayforge_deliveries{status="${status}"} ${value(snapshot.deliveries[status])}`)),
    ...gauge('relayforge_attempts', 'Persisted attempt records by current outcome.', attemptOutcomes.map(outcome =>
      `relayforge_attempts{outcome="${outcome}"} ${value(snapshot.attempts[outcome])}`)),
    ...gauge('relayforge_deliveries_due', 'Enabled pending deliveries due with attempt budget remaining.',
      [`relayforge_deliveries_due ${value(snapshot.due)}`]),
    ...gauge('relayforge_oldest_due_delivery_lag_seconds', 'Seconds overdue for the oldest eligible due delivery; zero if none.',
      [`relayforge_oldest_due_delivery_lag_seconds ${value(snapshot.oldest_due_lag_seconds)}`]),
    ...gauge('relayforge_expired_leases', 'Processing deliveries with expired worker leases.',
      [`relayforge_expired_leases ${value(snapshot.expired_leases)}`]),
    ...gauge('relayforge_delivery_replays', 'Persisted manual replay audit records.',
      [`relayforge_delivery_replays ${value(snapshot.replays)}`]),
    '',
  ].join('\n');
}
