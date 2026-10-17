import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { loadQueueConfig } from './queue/config.js';
import { createDeliveryQueue } from './queue/redis.js';
import { dispatchBatch } from './dispatch/batch.js';
import { recoverExpiredLeases } from './worker/recovery.js';
import { createLogger } from './observability/logging.js';

const config = loadConfig();
const logger = createLogger('dispatcher', config.logLevel);
const queueConfig = loadQueueConfig();
const stopping = new AbortController();
process.once('SIGINT', () => stopping.abort());
process.once('SIGTERM', () => stopping.abort());
const pool = new Pool({
  connectionString: config.databaseUrl, max: 2,
  connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 3000,
  idle_in_transaction_session_timeout: 5000,
  application_name: 'relayforge-dispatcher',
});
pool.on('error', error => logger.error({ event: 'dispatcher.database_error', err: error }));
const queue = createDeliveryQueue(queueConfig.redisUrl, error => logger.error({ event: 'dispatcher.redis_error', err: error }));

try {
  await queue.connect();
  logger.info({ event: 'dispatcher.started' });
  do {
    const started = performance.now();
    const recovered = await recoverExpiredLeases(pool);
    const published = await dispatchBatch(pool, queue);
    if (published || recovered || process.argv.includes('--once')) {
      logger.info({ event: 'dispatcher.batch_completed', recovered, published, duration_ms: performance.now() - started });
    }
    if (process.argv.includes('--once') || stopping.signal.aborted) break;
    await setTimeout(1000, undefined, { signal: stopping.signal });
  } while (!stopping.signal.aborted);
} catch (error) {
  if (!stopping.signal.aborted) {
      logger.error({ event: 'dispatcher.stopped', err: error });
    process.exitCode = 1;
  }
} finally {
  await Promise.allSettled([queue.close(), pool.end()]);
    logger.info({ event: 'dispatcher.drained' });
}
