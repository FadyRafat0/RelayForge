import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const SIGNING_SECRET_PATTERN = /^whsec_[0-9a-f]{64}$/;

interface SignedMessage {
  secret: string;
  body: Buffer;
  deliveryId: string;
  attemptNumber: number;
}

function digest(message: SignedMessage, timestamp: number): Buffer {
  return createHmac('sha256', message.secret)
    .update(`${timestamp}.${message.deliveryId}.${message.attemptNumber}.`)
    .update(message.body).digest();
}

export function signWebhook(message: SignedMessage, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${digest(message, timestamp).toString('hex')}`;
}

export function verifyWebhook(message: SignedMessage & { signature: string },
  now = Math.floor(Date.now() / 1000)): boolean {
  const match = /^t=([1-9][0-9]{0,10}),v1=([0-9a-f]{64})$/.exec(message.signature);
  if (!match || !SIGNING_SECRET_PATTERN.test(message.secret)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.deliveryId)
    || !Number.isSafeInteger(message.attemptNumber) || message.attemptNumber < 1) return false;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(now) || Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  return timingSafeEqual(Buffer.from(match[2]!, 'hex'), digest(message, timestamp));
}
