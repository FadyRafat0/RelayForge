import type { FastifyInstance } from 'fastify';
import { formatMetrics, type MetricsStore } from './metrics.js';

export function registerMetricsRoute(app: FastifyInstance, store: MetricsStore) {
  app.get('/metrics', { schema: { querystring: { type: 'object', additionalProperties: false } } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      try {
        const snapshot = await store.readMetrics();
        const body = formatMetrics(snapshot);
        return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body);
      } catch (error) {
        request.log.error({ err: error, event: 'metrics.collection_failed' }, 'Metrics collection failed');
        return reply.code(503).send({ error: 'Service Unavailable', message: 'Unable to collect metrics' });
      }
    });
}
