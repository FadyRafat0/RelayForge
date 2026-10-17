import Fastify, { LogController } from 'fastify';
import type { Config } from './config.js';
import { createDatabase, type Database } from './database.js';
import { registerEndpointRoutes } from './endpoints/routes.js';
import { registerEventRoutes } from './events/routes.js';
import { registerDeliveryRoutes } from './deliveries/routes.js';
import { registerMetricsRoute } from './observability/routes.js';
import { createLogger, observe } from './observability/logging.js';
import type { FastifyBaseLogger } from 'fastify';

// Constructing an app does not open a port. Tests use this same app.
export function buildApp(config: Config, database?: Database, logger?: FastifyBaseLogger) {
  const app = Fastify({
    loggerInstance: logger ?? createLogger('api', config.logLevel),
    logController: new LogController({ disableRequestLogging: true }),
    // Reject unknown fields and wrong types instead of silently changing input.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const db = database ?? createDatabase(config.databaseUrl, app.log);
  app.addHook('onResponse', async (request, reply) => {
    observe(event => request.log.info(event), { event: 'api.request_completed',
      method: request.method, route: request.routeOptions.url ?? 'unmatched',
      status_code: reply.statusCode, duration_ms: reply.elapsedTime });
  });

  // The app owns the database dependency and closes it on shutdown.
  app.addHook('onClose', async () => {
    await db.close();
  });

  app.get('/health', async (request, reply) => {
    try {
      await db.check();
      return { status: 'ok', service: 'relayforge', database: 'up' };
    } catch (error) {
      request.log.error({ err: error }, 'PostgreSQL health check failed');
      return reply.code(503).send({
        status: 'unavailable', service: 'relayforge', database: 'down',
      });
    }
  });

  registerEndpointRoutes(app, db);
  registerEventRoutes(app, db);
  registerDeliveryRoutes(app, db);
  registerMetricsRoute(app, db);
  return app;
}
