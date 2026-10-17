import type { FastifyInstance } from 'fastify';
import { ReplayConflictError, type DeliveryStore, type ReplayRequest } from './store.js';
import { attemptSchema, deliverySchema, detailSchema, pageResponse, replayResultSchema } from './schemas.js';
import { observe } from '../observability/logging.js';

const params = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } } };
type Query = { limit?: string; offset?: string };
const pageSchema = { type: 'object', additionalProperties: false, properties: {
  limit: { type: 'string', pattern: '^([1-9][0-9]?|100)$' },
  offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,5})$' },
} };
const page = (query: Query) => ({ limit: Number(query.limit ?? '20'), offset: Number(query.offset ?? '0') });
const missing = { error: 'Not Found', message: 'Delivery not found' };

export function registerDeliveryRoutes(app: FastifyInstance, store: DeliveryStore) {
  app.get<{ Querystring: Query }>('/api/deliveries/dead', { schema: { querystring: pageSchema,
    response: { 200: pageResponse('deliveries', deliverySchema) } } },
    async (request, reply) => {
      try {
        const pagination = page(request.query);
        return reply.header('cache-control', 'no-store').send({
          deliveries: await store.listDeadDeliveries(pagination), ...pagination });
      } catch (error) {
        request.log.error({ err: error }, 'Dead delivery listing failed');
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Unable to list dead deliveries' });
      }
    });
  app.get<{ Params: { id: string } }>('/api/deliveries/:id',
    { schema: { params, response: { 200: detailSchema } } }, async (request, reply) => {
    try {
      const delivery = await store.getDelivery(request.params.id);
      return delivery ? reply.header('cache-control', 'no-store').send({ delivery }) : reply.code(404).send(missing);
    } catch (error) {
      request.log.error({ err: error }, 'Delivery inspection failed');
      return reply.code(500).send({ error: 'Internal Server Error', message: 'Unable to inspect delivery' });
    }
  });
  app.get<{ Params: { id: string }; Querystring: Query }>('/api/deliveries/:id/attempts',
    { schema: { params, querystring: pageSchema, response: { 200: pageResponse('attempts', attemptSchema) } } }, async (request, reply) => {
      try {
        const pagination = page(request.query);
        const attempts = await store.listDeliveryAttempts(request.params.id, pagination);
        return attempts ? reply.header('cache-control', 'no-store').send({ attempts, ...pagination })
          : reply.code(404).send(missing);
      } catch (error) {
        request.log.error({ err: error }, 'Delivery attempt listing failed');
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Unable to list delivery attempts' });
      }
    });
  app.post<{ Params: { id: string }; Body: Omit<ReplayRequest, 'additional_attempts'> & { additional_attempts?: number } }>(
    '/api/deliveries/:id/replay', { schema: { params, body: {
      type: 'object', additionalProperties: false, required: ['expected_attempt_count', 'reason'], properties: {
        expected_attempt_count: { type: 'integer', minimum: 0, maximum: 2147483647 },
        additional_attempts: { type: 'integer', minimum: 1, maximum: 10 },
        reason: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
      },
    }, response: { 202: replayResultSchema } } }, async (request, reply) => {
      try {
        const result = await store.replayDelivery(request.params.id, {
          expected_attempt_count: request.body.expected_attempt_count,
          additional_attempts: request.body.additional_attempts ?? 5, reason: request.body.reason.trim(),
        });
        if (result) observe(event => request.log.info(event), { event: 'delivery.replay_accepted',
          delivery_id: result.delivery.id, replay_id: result.replay.id,
          attempt_count: result.delivery.attempt_count, max_attempts: result.delivery.max_attempts });
        // Persisted for dispatch, not delivered synchronously; Redis is not called here.
        return result ? reply.header('cache-control', 'no-store').code(202).send(result) : reply.code(404).send(missing);
      } catch (error) {
        if (error instanceof ReplayConflictError) return reply.code(409).send({ error: 'Conflict', message: error.message });
        request.log.error({ err: error }, 'Delivery replay failed');
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Unable to replay delivery' });
      }
    });
}
