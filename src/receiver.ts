import { createChaosReceiver } from './receiver/app.js';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createReceiverInbox } from './receiver/inbox.js';

const pool = new Pool({ connectionString: loadConfig().databaseUrl, max: 5,
  connectionTimeoutMillis: 2000, statement_timeout: 2000, lock_timeout: 1500,
  idle_in_transaction_session_timeout: 5000, application_name: 'relayforge-receiver' });
pool.on('error', () => console.error('Receiver database connection error'));
try {
  let signingSecret = process.env.RECEIVER_SIGNING_SECRET;
  const demoEndpointId = process.env.DEMO_RECEIVER_ENDPOINT_ID;
  if (demoEndpointId !== undefined) {
    // Explicit local-demo convenience: receiver and sender share one database.
    // A real independent receiver must provision its secret out of band instead.
    if (signingSecret || demoEndpointId !== '00000000-0000-4000-8000-000000000001') {
      throw new Error('Invalid demo receiver configuration');
    }
    const result = await pool.query<{ signing_secret: string }>(
      'SELECT signing_secret FROM webhook_endpoints WHERE id = $1', [demoEndpointId]);
    signingSecret = result.rows[0]?.signing_secret;
  }
  if (!signingSecret) throw new Error('Receiver signing secret is required');
  const inbox = createReceiverInbox(pool, process.env.RECEIVER_ID ?? 'local-demo');
  // Fail startup if the receiver migration has not been applied.
  await pool.query('SELECT 1 FROM receiver_receipts LIMIT 0');
  await pool.query('SELECT 1 FROM receiver_effects LIMIT 0');
  const server = createChaosReceiver(record => console.log(JSON.stringify(record)), { signingSecret, inbox });
  function shutdown() { server.close(); server.closeAllConnections(); }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('close', resolve);
      server.listen(8080, '127.0.0.1', () => console.log('Receiver: http://127.0.0.1:8080/webhooks'));
    });
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
} catch {
  console.error('Receiver stopped: check configuration, PostgreSQL, migration 005, and port 8080');
  process.exitCode = 1;
} finally { await pool.end(); }
