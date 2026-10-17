import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from '../src/webhooks/signatures.js';

const now = 1800000000;
const message = { secret: 'whsec_' + 'a'.repeat(64), body: Buffer.from('{ "hello": "مرحبا" }'),
  deliveryId: '11111111-1111-4111-8111-111111111111', attemptNumber: 1 };
const signature = signWebhook(message, now);

describe('Webhook HMAC protocol', () => {
  it('matches an independent construction of the documented wire format', () => {
    const expected = createHmac('sha256', message.secret)
      .update(Buffer.concat([Buffer.from(`${now}.${message.deliveryId}.1.`), message.body])).digest('hex');
    expect(signature).toBe(`t=${now},v1=${expected}`);
    expect(verifyWebhook({ ...message, signature }, now)).toBe(true);
  });
  it.each([
    { body: Buffer.from('{"hello":"مرحبا"}') },
    { secret: 'whsec_' + 'b'.repeat(64) },
    { deliveryId: '22222222-2222-4222-8222-222222222222' },
    { attemptNumber: 2 }, { attemptNumber: 0 }, { attemptNumber: NaN },
    { deliveryId: 'not-a-uuid' }, { secret: '' },
  ])('rejects tampered contents, metadata, or invalid inputs %#', changed => {
    expect(verifyWebhook({ ...message, ...changed, signature }, now)).toBe(false);
  });
  it.each(['', 'garbage', signature + ',v1=' + '0'.repeat(64), signature + ',t=1800000000',
    signature.replace('v1=', 'v2='), signature.slice(0, -1),
    signature.replace(/v1=.*/, 'v1=' + 'g'.repeat(64)), signature.replace('t=1800000000', 't=1800000001')])
  ('rejects malformed, duplicate, or changed signature headers %#', value => {
    expect(verifyWebhook({ ...message, signature: value }, now)).toBe(false);
  });
  it.each([-301, 301])('rejects a correctly signed request outside the freshness window: %s', offset => {
    expect(verifyWebhook({ ...message, signature: signWebhook(message, now + offset) }, now)).toBe(false);
  });
  it.each([-300, 0, 300])('accepts the freshness boundary: %s', offset => {
    expect(verifyWebhook({ ...message, signature: signWebhook(message, now + offset) }, now)).toBe(true);
  });
});
