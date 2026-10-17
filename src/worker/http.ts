import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import ipaddr from 'ipaddr.js';
import { signWebhook } from '../webhooks/signatures.js';

export interface WebhookRequest {
  url: string;
  signingSecret: string;
  deliveryId: string;
  attemptNumber: number;
  event: { id: string; type: string; payload: Record<string, unknown>; created_at: string };
}

export interface HttpOptions {
  allowLoopback?: boolean;
  timeoutMs?: number;
  resolveHost?: (host: string) => Promise<{ address: string; family: number }[]>;
}

export interface WebhookResponse { status: number; retryAfter?: string }

export class WebhookSendError extends Error {
  constructor(message: string, public readonly retryable = false) {
    super(message);
    this.name = 'WebhookSendError';
  }
}

export function isAllowedAddress(address: string, allowLoopback = false): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.range() === 'loopback') return allowLoopback;
    if (parsed.kind() === 'ipv6' && !parsed.match(ipaddr.parse('2000::') as ipaddr.IPv6, 3)) return false;
    const range = parsed.range();
    return range === 'unicast' || (allowLoopback && range === 'loopback');
  } catch { return false; }
}

export async function sendWebhook(input: WebhookRequest, options: HttpOptions = {}): Promise<WebhookResponse> {
  const controller = new AbortController();
  let expire!: (reason: Error) => void;
  const deadline = new Promise<never>((_, reject) => { expire = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    expire(new Error('Webhook request timed out'));
  }, options.timeoutMs ?? 5000);

  async function perform() {
    let url: URL;
    try { url = new URL(input.url); }
    catch { throw new WebhookSendError('Unsupported webhook URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new WebhookSendError('Unsupported webhook URL');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
      : await (options.resolveHost ?? (name => lookup(name, { all: true })))(host);
    controller.signal.throwIfAborted();
    if (!addresses.length || addresses.some(row => !isAllowedAddress(row.address, options.allowLoopback))) {
      throw new WebhookSendError('Webhook destination address is not allowed');
    }
    const address = addresses[0]!;
    const body = Buffer.from(JSON.stringify(input.event));
    const signature = signWebhook({ secret: input.signingSecret, body,
      deliveryId: input.deliveryId, attemptNumber: input.attemptNumber });
    return new Promise<WebhookResponse>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
        // Connect directly to the validated address: no second DNS lookup.
        hostname: address.address, family: address.family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'POST', agent: false,
        servername: isIP(host) ? '' : host,
        checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate),
        signal: controller.signal,
        headers: {
          host: url.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
          'user-agent': 'RelayForge/0.1', 'x-relayforge-delivery-id': input.deliveryId,
          'x-relayforge-event-id': input.event.id, 'x-relayforge-attempt': String(input.attemptNumber),
          'x-relayforge-signature': signature,
        },
      }, response => {
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) response.destroy(new WebhookSendError('Webhook response exceeded 64 KiB'));
        });
        response.once('error', reject);
        response.once('end', () => {
          const retryAfter = response.headers['retry-after'];
          resolve({ status: response.statusCode ?? 0, ...(retryAfter === undefined ? {} : { retryAfter }) });
        });
      });
      request.once('error', reject);
      request.once('upgrade', (_response, socket) => {
        socket.destroy();
        reject(new WebhookSendError('Webhook protocol upgrades are not supported'));
      });
      request.end(body);
    });
  }
  try { return await Promise.race([perform(), deadline]); }
  finally { clearTimeout(timer); }
}
