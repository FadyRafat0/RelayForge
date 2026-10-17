import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChaosReceiver } from '../src/receiver/app.js';
import { signWebhook } from '../src/webhooks/signatures.js';
import { sendWebhook } from '../src/worker/http.js';

const secret = 'whsec_' + 'a'.repeat(64);
const deliveryId = '11111111-1111-4111-8111-111111111111';
const servers: ReturnType<typeof createChaosReceiver>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  }));
});
async function setup() {
  const accepted = vi.fn();
  const server = createChaosReceiver(accepted, { signingSecret: secret });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing receiver port');
  return { accepted, url: `http://127.0.0.1:${address.port}/webhooks` };
}
describe('Receiver signature enforcement over HTTP', () => {
  it('requires a valid secret by default', () => {
    expect(() => createChaosReceiver()).toThrow('required');
    expect(() => createChaosReceiver(undefined, { signingSecret: 'bad' })).toThrow('Invalid');
    expect(() => createChaosReceiver(undefined, { allowUnsigned: true, inbox: { receive: vi.fn() } }))
      .toThrow('requires signature verification');
  });
  it('verifies the exact bytes sent by the real worker HTTP sender, including retries', async () => {
    const { accepted, url } = await setup();
    const request = { url: url + '?mode=flaky&failures=1', signingSecret: secret, deliveryId, attemptNumber: 1,
      event: { id: '22222222-2222-4222-8222-222222222222', type: 'example',
        payload: { greeting: 'مرحبا' }, created_at: new Date().toISOString() } };
    expect(await sendWebhook(request, { allowLoopback: true })).toEqual({ status: 500 });
    expect(await sendWebhook({ ...request, attemptNumber: 2 }, { allowLoopback: true })).toEqual({ status: 200 });
    expect(accepted).toHaveBeenCalledTimes(2);
  });
  it.each(['missing', 'wrong-secret', 'changed-body', 'changed-attempt', 'stale', 'duplicate'])
  ('rejects %s before changing receiver state', async scenario => {
    const { accepted, url } = await setup();
    const body = Buffer.from('{}');
    let signature = signWebhook({ secret: scenario === 'wrong-secret' ? 'whsec_' + 'b'.repeat(64) : secret,
      body, deliveryId, attemptNumber: 1 }, Math.floor(Date.now() / 1000) - (scenario === 'stale' ? 301 : 0));
    if (scenario === 'duplicate') signature += ',' + signature;
    const headers = { 'x-relayforge-delivery-id': deliveryId,
      'x-relayforge-attempt': scenario === 'changed-attempt' ? '2' : '1',
      ...(scenario === 'missing' ? {} : { 'x-relayforge-signature': signature }) };
    const result = await fetch(url + '?mode=flaky&failures=1', { method: 'POST', headers,
      body: scenario === 'changed-body' ? '{ }' : body });
    expect(result.status).toBe(401);
    expect(accepted).not.toHaveBeenCalled();
    const valid = await fetch(url + '?mode=flaky&failures=1', { method: 'POST', body,
      headers: { 'x-relayforge-delivery-id': deliveryId, 'x-relayforge-attempt': '1',
        'x-relayforge-signature': signWebhook({ secret, body, deliveryId, attemptNumber: 1 }) } });
    expect(valid.status).toBe(500);
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ call: 1 }));
  });
});
