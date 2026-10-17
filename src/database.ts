import { Pool } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { createEndpointStore, type EndpointStore } from './endpoints/store.js';
import { createEventStore, type EventStore } from './events/store.js';
import { createDeliveryStore, type DeliveryStore } from './deliveries/store.js';
import { createMetricsStore, type MetricsStore } from './observability/metrics.js';

export interface Database extends EndpointStore, EventStore, DeliveryStore, MetricsStore {
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(databaseUrl: string, logger: FastifyBaseLogger): Database {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    query_timeout: 2000,
    statement_timeout: 2000,
    application_name: 'relayforge-api',
  });

  // Handle idle connection errors so a database outage does not crash the API.
  pool.on('error', (error: Error) => {
    logger.error({ err: error }, 'Idle PostgreSQL connection failed');
  });

  return {
    ...createEndpointStore(pool),
    ...createEventStore(pool),
    ...createDeliveryStore(pool),
    ...createMetricsStore(pool),
    async check() {
      // No tables are needed: verify authentication and SQL execution.
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
