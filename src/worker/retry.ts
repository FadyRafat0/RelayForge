import { WebhookSendError } from './http.js';

export const BASE_RETRY_MS = 5000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface RetryInput {
  attemptNumber: number;
  maxAttempts: number;
  status: number | null;
  error?: unknown;
  retryAfter?: string | undefined;
}
export interface RetryOptions { random?: () => number; nowMs?: number }
export type RetryDecision = { kind: 'succeeded' }
  | { kind: 'dead'; reason: string }
  | { kind: 'retry'; delayMs: number; reason: string };

export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // Recognize HTTP-date forms, not arbitrary strings accepted by Date.parse.
  const httpDate = /^(?:[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;
  if (!httpDate.test(text)) return null;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

function permanentError(error: unknown) {
  if (error instanceof WebhookSendError) return !error.retryable;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && [
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ].includes(code);
}

export function decideRetry(input: RetryInput, options: RetryOptions = {}): RetryDecision {
  const { attemptNumber, maxAttempts, status, error } = input;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Attempt numbers and budgets must be positive integers');
  }
  if (error === undefined && status !== null && status >= 200 && status < 300) return { kind: 'succeeded' };
  if (error !== undefined && permanentError(error)) return { kind: 'dead', reason: 'permanent_request_error' };
  const retryableStatus = status === null || [408, 425, 429].includes(status)
    || (status >= 500 && status <= 599 && ![501, 505].includes(status));
  if (!retryableStatus) return { kind: 'dead', reason: 'permanent_http_response' };
  if (attemptNumber >= maxAttempts) return { kind: 'dead', reason: 'attempt_limit_reached' };

  const retryAfter = status === 429 || status === 503
    ? parseRetryAfter(input.retryAfter, options.nowMs ?? Date.now()) : null;
  // Never shorten a server minimum to fit our cap: stop instead if it is too long.
  if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
    return { kind: 'dead', reason: 'retry_after_exceeds_24h' };
  }
  const sample = (options.random ?? Math.random)();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('Random sample must be in [0, 1)');
  const window = Math.min(MAX_BACKOFF_MS, BASE_RETRY_MS * 2 ** Math.min(attemptNumber - 1, 20));
  // Equal jitter keeps a positive minimum while spreading requests across a window.
  const backoff = Math.floor(window / 2 + sample * window / 2);
  return { kind: 'retry', delayMs: Math.max(backoff, retryAfter ?? 0), reason: 'transient_failure' };
}
