import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedAddress, sendWebhook, type WebhookRequest } from '../src/worker/http.js';
import { loadWorkerConfig } from '../src/worker/config.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }));
});

async function receiver(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Receiver has no port');
  return { port: address.port, url: `http://127.0.0.1:${address.port}/webhooks` };
}

function webhook(url: string): WebhookRequest {
  return { url, signingSecret: 'whsec_' + 'a'.repeat(64), deliveryId: '11111111-1111-4111-8111-111111111111', attemptNumber: 1,
    event: { id: '22222222-2222-4222-8222-222222222222', type: 'payment.succeeded',
      payload: { amount: 100 }, created_at: '2026-01-01T00:00:00.000Z' } };
}

describe('Webhook destination policy', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '2001:db8::1', 'not-an-ip'])
  ('blocks non-public destination %s', address => { expect(isAllowedAddress(address)).toBe(false); });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public address %s', address => {
    expect(isAllowedAddress(address)).toBe(true);
  });
  it('allows only loopback with the explicit development option', () => {
    expect(isAllowedAddress('127.0.0.1', true)).toBe(true);
    expect(isAllowedAddress('::1', true)).toBe(true);
    expect(isAllowedAddress('::ffff:127.0.0.1', true)).toBe(true);
    expect(isAllowedAddress('169.254.169.254', true)).toBe(false);
    expect(isAllowedAddress('192.168.1.1', true)).toBe(false);
  });
  it('defaults to denying loopback and validates explicit configuration', () => {
    expect(loadWorkerConfig({})).toEqual({ allowLoopback: false, concurrency: 4 });
    expect(loadWorkerConfig({ ALLOW_LOOPBACK_ENDPOINTS: 'true' })).toEqual({ allowLoopback: true, concurrency: 4 });
    expect(() => loadWorkerConfig({ ALLOW_LOOPBACK_ENDPOINTS: 'yes' })).toThrow('ALLOW_LOOPBACK_ENDPOINTS');
  });
});

describe('Bounded HTTP delivery', () => {
  it('sends the event envelope, stable IDs, attempt number, and original Host to a pinned address', async () => {
    let received: { body: unknown; headers: Record<string, unknown>; path: string | undefined } | undefined;
    const target = await receiver((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        received = { body: JSON.parse(body), headers: request.headers, path: request.url };
        response.writeHead(204).end();
      });
    });
    const input = webhook(`http://receiver.invalid:${target.port}/webhooks?source=test`);
    expect(await sendWebhook(input, { allowLoopback: true,
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }] })).toEqual({ status: 204 });
    expect(received?.body).toEqual(input.event);
    expect(received?.path).toBe('/webhooks?source=test');
    expect(received?.headers).toMatchObject({ host: `receiver.invalid:${target.port}`,
      'x-relayforge-delivery-id': input.deliveryId, 'x-relayforge-event-id': input.event.id,
      'x-relayforge-attempt': '1', 'content-type': 'application/json' });
  });
  it('does not follow redirects', async () => {
    let calls = 0;
    const target = await receiver((_request, response) => {
      calls++;
      response.writeHead(302, { location: '/redirect-target' }).end();
    });
    expect(await sendWebhook(webhook(target.url), { allowLoopback: true })).toEqual({ status: 302 });
    expect(calls).toBe(1);
  });
  it('times out a stalled receiver', async () => {
    const target = await receiver(() => {});
    await expect(sendWebhook(webhook(target.url), { allowLoopback: true, timeoutMs: 50 }))
      .rejects.toThrow(/timed out|aborted/i);
  });
  it('bounds DNS waiting and does not connect after the deadline', async () => {
    await expect(sendWebhook(webhook('https://unresolved.invalid/hooks'), {
      timeoutMs: 50, resolveHost: () => new Promise(() => {}),
    })).rejects.toThrow(/timed out/i);
  });
  it('rejects a DNS result containing any blocked address', async () => {
    await expect(sendWebhook(webhook('http://mixed.invalid/hooks'), {
      resolveHost: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    })).rejects.toThrow('not allowed');
  });
  it('bounds the response body without storing it', async () => {
    const target = await receiver((_request, response) => { response.end(Buffer.alloc(65537)); });
    await expect(sendWebhook(webhook(target.url), { allowLoopback: true })).rejects.toThrow('exceeded');
  });
});
