import type { FastifyInstance } from 'fastify';
import type { EventStore, NewEvent } from './store.js';
import { IdempotencyConflictError } from './store.js';
import { observe } from '../observability/logging.js';

const acceptedEventSchema = {
  type: 'object', additionalProperties: false, required: ['event', 'delivery_count', 'replayed'],
  properties: {
    event: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'created_at'],
      properties: {
        id: { type: 'string' }, type: { type: 'string' }, created_at: { type: 'string' },
      },
    },
    delivery_count: { type: 'integer', minimum: 0 },
    replayed: { type: 'boolean' },
  },
};

export function registerEventRoutes(app: FastifyInstance, store: EventStore) {
  app.post<{ Body: NewEvent }>('/api/events', {
    bodyLimit: 64 * 1024,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['type', 'payload'],
        properties: {
          type: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' },
          payload: { type: 'object', additionalProperties: true },
          idempotency_key: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,200}$' },
        },
      },
      response: { 200: acceptedEventSchema, 201: acceptedEventSchema },
    },
  }, async (request, reply) => {
    try {
      const result = await store.ingestEvent(request.body);
      observe(event => request.log.info(event), { event: 'event.accepted', event_id: result.event.id,
        delivery_count: result.delivery_count, replayed: result.replayed });
      // Accepted here means committed to PostgreSQL, not sent over HTTP.
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send({ error: 'Conflict', message: error.message });
      }
      request.log.error({ err: error }, 'Event ingestion failed');
      return reply.code(500).send({ error: 'Internal Server Error', message: 'Unable to accept event' });
    }
  });
}
