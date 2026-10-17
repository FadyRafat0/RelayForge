import { createServer } from 'node:http';
import { SIGNING_SECRET_PATTERN, verifyWebhook } from '../webhooks/signatures.js';
import { ReceiverPayloadError, type ReceiverInbox } from './inbox.js';

export interface ReceiverRecord {
  deliveryId: string; mode: string; call: number; status: number | null; duplicate?: boolean;
}

export interface ReceiverOptions { signingSecret?: string; allowUnsigned?: boolean; inbox?: ReceiverInbox }

export function createChaosReceiver(onRequest: (record: ReceiverRecord) => void = () => {},
  options: ReceiverOptions = {}) {
  if (options.signingSecret !== undefined && !SIGNING_SECRET_PATTERN.test(options.signingSecret)) {
    throw new Error('Invalid receiver signing secret');
  }
  if (!options.signingSecret && !options.allowUnsigned) throw new Error('Receiver signing secret is required');
  if (options.inbox && !options.signingSecret) throw new Error('Durable receiver requires signature verification');
  const calls = new Map<string, number>();
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'POST' || url.pathname !== '/webhooks') {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const mode = url.searchParams.get('mode') ?? 'success';
    function integer(name: string, fallback: number, min: number, max: number) {
      const value = url.searchParams.get(name) ?? String(fallback);
      if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}`);
      return Number(value);
    }
    let failures: number, delay: number, status: number, retryAfter: number;
    try {
      if (!['success', 'flaky', 'status', 'rate-limit', 'slow', 'timeout'].includes(mode)) throw new Error('Invalid mode');
      failures = integer('failures', 2, 0, 100);
      delay = integer('delay_ms', 6000, 0, 10000);
      status = integer('status', 500, 400, 599);
      retryAfter = integer('retry_after', 3, 0, 999999);
    } catch (error) {
      request.resume();
      response.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid options' }));
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) request.destroy();
      else chunks.push(Buffer.from(chunk));
    });
    request.on('error', () => {});
    request.on('end', () => { void handleBody().catch(() => {
      if (!response.destroyed && !response.headersSent) {
        response.writeHead(503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'Receiver storage unavailable' }));
      }
    }); });
    async function handleBody() {
      const body = Buffer.concat(chunks);
      const signature = request.headers['x-relayforge-signature'];
      const attempt = request.headers['x-relayforge-attempt'];
      const header = request.headers['x-relayforge-delivery-id'];
      if (options.signingSecret && (typeof signature !== 'string' || typeof header !== 'string'
        || typeof attempt !== 'string' || !/^[1-9][0-9]{0,9}$/.test(attempt)
        || !verifyWebhook({ secret: options.signingSecret, body,
          deliveryId: header, attemptNumber: Number(attempt), signature }))) {
        response.writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'Invalid webhook signature' }));
        return;
      }
      const deliveryId = typeof header === 'string' ? header : 'anonymous';
      if (!calls.has(deliveryId) && calls.size >= 10000) calls.delete(calls.keys().next().value!);
      const call = (calls.get(deliveryId) ?? 0) + 1;
      calls.set(deliveryId, call);
      const code = mode === 'status' ? status : mode === 'rate-limit' ? 429
        : mode === 'flaky' && call <= failures ? 500 : 200;
      if (options.inbox) {
        let result;
        try { result = await options.inbox.receive(deliveryId, body, code === 200 && mode !== 'timeout'); }
        catch (error) {
          if (!(error instanceof ReceiverPayloadError)) throw error;
          response.writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'Expected a JSON object' }));
          return;
        }
        if (result === 'conflict') {
          response.writeHead(409, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'Delivery ID already used with a different body' }));
          return;
        }
        if (result === 'duplicate') {
          onRequest({ deliveryId, mode, call, status: 200, duplicate: true });
          response.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ received: true, duplicate: true, call, mode }));
          return;
        }
      }
      onRequest({ deliveryId, mode, call, status: mode === 'timeout' ? null : code });
      function reply() {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (mode === 'rate-limit' || (mode === 'status' && url.searchParams.has('retry_after'))) {
          headers['retry-after'] = String(retryAfter);
        }
        response.writeHead(code, headers).end(JSON.stringify({ received: code === 200, call, mode }));
      }
      if (mode === 'timeout') return;
      if (mode === 'slow') {
        const timer = setTimeout(reply, delay);
        response.once('close', () => clearTimeout(timer));
      } else reply();
    }
  });
}
