import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { recoverExpiredLeases } from './worker/recovery.js';
import { createLogger } from './observability/logging.js';

const config = loadConfig();
const logger = createLogger('recovery', config.logLevel);
const pool = new Pool({ connectionString: config.databaseUrl, max: 1,
  connectionTimeoutMillis: 2000, statement_timeout: 3000, query_timeout: 3000 });
pool.on('error', error => logger.error({ event: 'recovery.database_error', err: error }));
try { logger.info({ event: 'recovery.completed', recovered: await recoverExpiredLeases(pool) }); }
catch (error) {
  logger.error({ event: 'recovery.failed', err: error });
  process.exitCode = 1;
} finally { await pool.end(); }
