import { describe, expect, it } from 'vitest';
import { decideRetry, parseRetryAfter, MAX_BACKOFF_MS, MAX_RETRY_AFTER_MS } from '../src/worker/retry.js';
import { WebhookSendError } from '../src/worker/http.js';

const nowMs = Date.parse('2026-01-01T00:00:00Z');
const defaults = { attemptNumber: 1, maxAttempts: 5, status: 500 };
const deterministic = { random: () => 0.5, nowMs };

describe('Bounded exponential retry policy', () => {
  it.each([200, 201, 204, 299])('accepts HTTP %i without retrying', status => {
    expect(decideRetry({ ...defaults, status }, deterministic)).toEqual({ kind: 'succeeded' });
  });
  it.each([301, 302, 400, 401, 403, 404, 410, 422, 501, 505])('stops early for HTTP %i', status => {
    expect(decideRetry({ ...defaults, status }, deterministic)).toEqual({ kind: 'dead', reason: 'permanent_http_response' });
  });
  it.each([408, 425, 429, 500, 502, 503, 504])('retries HTTP %i', status => {
    expect(decideRetry({ ...defaults, status }, deterministic)).toEqual({ kind: 'retry', delayMs: 3750, reason: 'transient_failure' });
  });
  it('doubles the window and caps it even for very large attempt numbers', () => {
    expect(decideRetry({ ...defaults, attemptNumber: 2 }, deterministic)).toMatchObject({ delayMs: 7500 });
    expect(decideRetry({ ...defaults, attemptNumber: 3 }, deterministic)).toMatchObject({ delayMs: 15000 });
    expect(decideRetry({ ...defaults, attemptNumber: 1000, maxAttempts: 1001 }, deterministic))
      .toMatchObject({ delayMs: MAX_BACKOFF_MS * 0.75 });
  });
  it('spreads equal jitter across the upper half of the window', () => {
    expect(decideRetry(defaults, { random: () => 0 })).toMatchObject({ delayMs: 2500 });
    expect(decideRetry(defaults, { random: () => 0.9999 })).toMatchObject({ delayMs: 4999 });
    expect(() => decideRetry(defaults, { random: () => 1 })).toThrow('Random sample');
  });
  it('stops when the attempt budget is exhausted', () => {
    expect(decideRetry({ ...defaults, attemptNumber: 5 })).toEqual({ kind: 'dead', reason: 'attempt_limit_reached' });
  });
  it('retries network errors but stops blocked destinations and invalid certificates', () => {
    expect(decideRetry({ ...defaults, status: null, error: new Error('ECONNRESET') }, deterministic)).toMatchObject({ kind: 'retry' });
    expect(decideRetry({ ...defaults, status: null, error: new WebhookSendError('blocked') })).toMatchObject({ kind: 'dead' });
    expect(decideRetry({ ...defaults, status: null, error: { code: 'CERT_HAS_EXPIRED' } })).toMatchObject({ kind: 'dead' });
  });
});

describe('Retry-After', () => {
  it('accepts seconds, future HTTP dates, and past dates', () => {
    expect(parseRetryAfter('60', nowMs)).toBe(60000);
    expect(parseRetryAfter('0', nowMs)).toBe(0);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', nowMs)).toBe(60000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', nowMs)).toBe(0);
  });
  it.each([undefined, '', '-1', '1.5', 'tomorrow', '2026-01-01', 'NaN', 'Infinity'])('ignores malformed value %j', value => {
    expect(parseRetryAfter(value, nowMs)).toBeNull();
  });
  it.each([429, 503])('honors the server minimum for HTTP %i', status => {
    expect(decideRetry({ ...defaults, status, retryAfter: '60' }, deterministic)).toMatchObject({ kind: 'retry', delayMs: 60000 });
    expect(decideRetry({ ...defaults, status, retryAfter: 'Thu, 01 Jan 2026 00:01:00 GMT' }, deterministic))
      .toMatchObject({ delayMs: 60000 });
  });
  it('does not let a short header shorten exponential backoff', () => {
    expect(decideRetry({ ...defaults, status: 429, retryAfter: '1' }, deterministic)).toMatchObject({ delayMs: 3750 });
  });
  it('stops rather than retrying earlier than a server minimum beyond our 24-hour limit', () => {
    expect(decideRetry({ ...defaults, status: 503, retryAfter: '86400' }, deterministic)).toMatchObject({ delayMs: MAX_RETRY_AFTER_MS });
    expect(decideRetry({ ...defaults, status: 503, retryAfter: '86401' }, deterministic))
      .toEqual({ kind: 'dead', reason: 'retry_after_exceeds_24h' });
    expect(decideRetry({ ...defaults, status: 429, retryAfter: '9'.repeat(1000) }, deterministic).kind).toBe('dead');
  });
});
