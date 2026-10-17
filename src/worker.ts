import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { loadQueueConfig } from './queue/config.js';
import { createDeliveryConsumer } from './queue/redis.js';
import { loadWorkerConfig } from './worker/config.js';
import { runWorker } from './worker/run.js';
import { processDelivery } from './worker/process.js';
import { sendWebhook } from './worker/http.js';
import { createEndpointRateLimiter } from './worker/rate-limit.js';
import { createLogger, observe } from './observability/logging.js';

const config = loadConfig();
const logger = createLogger('worker', config.logLevel);
const { redisUrl } = loadQueueConfig();
const { concurrency, ...httpOptions } = loadWorkerConfig();
const consumer = `worker-${randomUUID()}`;
const stopping = new AbortController();
const shutdown = () => {
  observe(event => logger.info(event), { event: 'worker.stop_requested', consumer });
  stopping.abort();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
const pool = new Pool({ connectionString: config.databaseUrl, max: 2,
  connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 3000,
  idle_in_transaction_session_timeout: 15000, application_name: 'relayforge-worker' });
pool.on('error', error => logger.error({ event: 'worker.database_error', err: error }));
const queue = createDeliveryConsumer(redisUrl, error => logger.error({ event: 'worker.redis_error', err: error }));
const rateLimiter = createEndpointRateLimiter(redisUrl, error => logger.error({ event: 'worker.limiter_error', err: error }));
try {
  await rateLimiter.connect();
  await queue.connect();
  const once = process.argv.includes('--once');
  logger.info({ event: 'worker.started', consumer, concurrency, once });
  await runWorker(queue, consumer, id =>
    processDelivery(pool, id, request => sendWebhook(request, httpOptions), { workerId: consumer, rateLimiter,
      onEvent(event) {
        if (event.event === 'delivery.processing_failed') logger.error(event);
        else if (event.event === 'delivery.claimed') logger.debug(event);
        else logger.info(event);
      } }),
  { concurrency, once, signal: stopping.signal,
    onEvent(event) {
      if (event.event === 'worker.job_failed' || event.event === 'worker.loop_failed') logger.error(event);
      else if (event.event === 'worker.job_started') logger.debug(event);
      else logger.info(event);
    },
    onOutcome(outcome) { if (outcome === 'empty' && once) logger.info({ event: 'worker.idle', consumer }); },
  });
} catch (error) {
  logger.error({ event: 'worker.stopped', consumer, err: error });
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  await Promise.allSettled([queue.close(), rateLimiter.close(), pool.end()]);
  logger.info({ event: 'worker.drained', consumer });
}
