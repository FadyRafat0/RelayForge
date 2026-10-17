import pino, { type DestinationStream } from 'pino';
import type { Config } from '../config.js';

export function errorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
}

export function createLogger(service: string, level: Config['logLevel'], destination?: DestinationStream) {
  return pino({ level, base: { service, pid: process.pid },
    // Raw exception messages/stacks can contain SQL details, URLs, or user data.
    serializers: { err: (error: unknown) => ({ code: errorCode(error) }) },
    redact: { remove: true, paths: ['payload', 'body', 'secret', 'signing_secret', 'signingSecret',
      'password', 'authorization', 'cookie', 'headers', 'req', 'request', '*.payload', '*.secret',
      '*.signing_secret', '*.signingSecret', '*.password', 'res.body'] },
  }, destination);
}

// Telemetry must not turn a committed delivery into a failed job.
export function observe<T>(observer: ((event: T) => unknown) | undefined, event: T): void {
  try {
    const result = observer?.(event);
    if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch { /* Logging is best effort; delivery state is authoritative. */ }
}
