import type { FastifyInstance } from 'fastify';
import type { EndpointStore } from './store.js';
import { observe } from '../observability/logging.js';

interface CreateEndpointBody {
  name: string;
  url: string;
  event_types?: string[];
  enabled?: boolean;
  rate_limit_per_second?: number;
}

const endpointSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'url', 'event_types', 'enabled', 'rate_limit_per_second', 'created_at', 'updated_at'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
    event_types: { type: 'array', items: { type: 'string' } },
    enabled: { type: 'boolean' },
    rate_limit_per_second: { type: 'integer' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
};

function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      return undefined;
    }
    const normalized = url.toString();
    return normalized.length <= 2048 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

const endpointProperties = {
  name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
  url: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https?://[^\\s\\\\]+$' },
  event_types: {
    type: 'array', minItems: 1, maxItems: 100, uniqueItems: true,
    items: { type: 'string', pattern: '^(\\*|[A-Za-z0-9][A-Za-z0-9._-]{0,99})$' },
  },
  enabled: { type: 'boolean' },
  rate_limit_per_second: { type: 'integer', minimum: 1, maximum: 1000 },
};

export function registerEndpointRoutes(app: FastifyInstance, store: EndpointStore) {
  app.patch<{ Params: { id: string }; Body: Partial<CreateEndpointBody> }>('/api/endpoints/:id', {
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: endpointProperties },
      response: { 200: endpointSchema },
    },
  }, async (request, reply) => {
    const input = { ...request.body };
    if (input.name !== undefined) input.name = input.name.trim();
    if (input.url !== undefined) {
      const url = normalizeUrl(input.url);
      if (!url) return reply.code(400).send({ error: 'Bad Request', message: 'Invalid HTTP(S) URL' });
      input.url = url;
    }
    if (input.event_types?.includes('*') && input.event_types.length > 1) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Use either ["*"] or specific event types' });
    }
    try {
      const endpoint = await store.updateEndpoint(request.params.id, input);
      if (!endpoint) return reply.code(404).send({ error: 'Not Found', message: 'Endpoint not found' });
      observe(event => request.log.info(event), { event: 'endpoint.updated', endpoint_id: endpoint.id });
      return reply.header('cache-control', 'no-store').send(endpoint);
    } catch (error) {
      request.log.error({ err: error }, 'Endpoint update failed');
      return reply.code(500).send({ error: 'Internal Server Error', message: 'Unable to update endpoint' });
    }
  });
  app.post<{ Body: CreateEndpointBody }>('/api/endpoints', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'url'],
        properties: endpointProperties,
      },
      response: { 201: { ...endpointSchema,
        required: [...endpointSchema.required, 'signing_secret'],
        properties: { ...endpointSchema.properties, signing_secret: { type: 'string' } },
      } },
    },
  }, async (request, reply) => {
    const body = request.body;
    const url = normalizeUrl(body.url);
    if (!url) {
      return reply.code(400).send({ error: 'Bad Request', message: 'url must be a valid HTTP(S) URL without credentials or a fragment' });
    }
    const eventTypes = body.event_types ?? ['*'];
    if (eventTypes.includes('*') && eventTypes.length > 1) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Use either ["*"] or specific event types' });
    }
    try {
      const endpoint = await store.createEndpoint({
        name: body.name.trim(), url, event_types: eventTypes, enabled: body.enabled ?? true,
        rate_limit_per_second: body.rate_limit_per_second ?? 10,
      });
      observe(event => request.log.info(event), { event: 'endpoint.registered', endpoint_id: endpoint.id,
        rate_limit_per_second: endpoint.rate_limit_per_second });
      return reply.header('cache-control', 'no-store').code(201).send(endpoint);
    } catch (error) {
      request.log.error({ err: error }, 'Endpoint registration failed');
      return reply.code(500).send({ error: 'Internal Server Error', message: 'Unable to create endpoint' });
    }
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/endpoints', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'string', pattern: '^([1-9][0-9]?|100)$' },
          offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,5})$' },
        },
      },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['endpoints', 'limit', 'offset'],
          properties: {
            endpoints: { type: 'array', items: endpointSchema },
            limit: { type: 'integer' }, offset: { type: 'integer' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const limit = Number(request.query.limit ?? '20');
    const offset = Number(request.query.offset ?? '0');
    try {
      return { endpoints: await store.listEndpoints({ limit, offset }), limit, offset };
    } catch (error) {
      request.log.error({ err: error }, 'Endpoint listing failed');
      return reply.code(500).send({ error: 'Internal Server Error', message: 'Unable to list endpoints' });
    }
  });
}
