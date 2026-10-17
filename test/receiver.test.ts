import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChaosReceiver } from '../src/receiver/app.js';

describe('Local chaos receiver', () => {
  let server: ReturnType<typeof createChaosReceiver>;
  let address: string;
  beforeEach(async () => {
    server = createChaosReceiver(undefined, { allowUnsigned: true });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const location = server.address();
    if (!location || typeof location === 'string') throw new Error('Receiver has no port');
    address = `http://127.0.0.1:${location.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  function post(query = '', deliveryId = 'test-delivery') {
    return fetch(`${address}/webhooks${query}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relayforge-delivery-id': deliveryId }, body: '{}' });
  }
  it('defaults to success', async () => { expect((await post()).status).toBe(200); });
  it('fails the configured number of times independently per delivery ID', async () => {
    expect((await post('?mode=flaky&failures=2')).status).toBe(500);
    expect((await post('?mode=flaky&failures=2')).status).toBe(500);
    expect((await post('?mode=flaky&failures=2')).status).toBe(200);
    expect((await post('?mode=flaky&failures=2', 'another-delivery')).status).toBe(500);
  });
  it('returns rate-limit status and header', async () => {
    const response = await post('?mode=rate-limit&retry_after=7');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
  });
  it('supports slow success and chosen failure statuses', async () => {
    expect((await post('?mode=slow&delay_ms=10')).status).toBe(200);
    expect((await post('?mode=status&status=404')).status).toBe(404);
  });
  it.each(['?mode=unknown', '?mode=slow&delay_ms=10001', '?mode=flaky&failures=-1',
    '?mode=status&status=200', '?mode=rate-limit&retry_after=abc'])('rejects invalid options %s', async query => {
    expect((await post(query)).status).toBe(400);
  });
});
