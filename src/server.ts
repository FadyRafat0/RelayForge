import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp(config);

async function shutdown(signal: string) {
  app.log.info({ signal }, 'Shutting down');
  try {
    await app.close();
  } catch (error) {
    app.log.error(error, 'Shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, 'Server startup failed');
  process.exitCode = 1;
  await app.close();
}
