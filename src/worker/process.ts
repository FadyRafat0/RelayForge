import type { Pool } from 'pg';
import type { WebhookRequest, WebhookResponse } from './http.js';
import { decideRetry, type RetryOptions } from './retry.js';
import { claimDelivery, type ClaimOptions } from './claims.js';
import { completeDelivery } from './completion.js';
import { admitDelivery } from './admission.js';
import type { EndpointRateLimiter } from './rate-limit.js';
import type { DeliveryLogEvent } from '../observability/events.js';
import { errorCode, observe } from '../observability/logging.js';

export type DeliveryOutcome = import('./completion.js').DeliveryOutcome | 'rate_limited';
export type ProcessOptions = RetryOptions & ClaimOptions & {
  rateLimiter?: EndpointRateLimiter;
  onEvent?: (event: DeliveryLogEvent) => void;
};

export async function processDelivery(pool: Pick<Pool, 'connect'>, deliveryId: string,
  send: (request: WebhookRequest) => Promise<WebhookResponse>, options: ProcessOptions = {}): Promise<DeliveryOutcome> {
  const started = performance.now();
  const context: Pick<DeliveryLogEvent, 'delivery_id' | 'worker_id' | 'endpoint_id' | 'event_id' | 'attempt_id' | 'attempt_number'> = {
    delivery_id: deliveryId, worker_id: options.workerId ?? 'worker',
  };
  function report(outcome: DeliveryOutcome, fields: Partial<Pick<DeliveryLogEvent,
    'http_status' | 'reason' | 'retry_delay_ms' | 'http_duration_ms'>> = {}) {
    observe(options.onEvent, { ...context, ...fields, event: 'delivery.processed', outcome,
      duration_ms: performance.now() - started });
    return outcome;
  }
  try {
    if (options.rateLimiter) {
      const admission = await admitDelivery(pool, deliveryId, options.rateLimiter);
      if (admission !== 'allowed') return report(admission);
    }
    const claim = await claimDelivery(pool, deliveryId, options);
    if (!claim) return report('skipped');
    Object.assign(context, { endpoint_id: claim.endpointId, event_id: claim.request.event.id,
      attempt_id: claim.attemptId, attempt_number: claim.attemptNumber });
    observe(options.onEvent, { ...context, event: 'delivery.claimed' });
    // No transaction or checked-out database connection spans this HTTP request.
    let httpStatus: number | null = null;
    let errorMessage: string | null = null;
    let sendError: unknown;
    let retryAfter: string | undefined;
    const httpStarted = performance.now();
    try {
      const response = await send(claim.request);
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error('Invalid HTTP response status');
      httpStatus = response.status;
      retryAfter = response.retryAfter;
      if (httpStatus < 200 || httpStatus >= 300) errorMessage = `HTTP status ${httpStatus}`;
    } catch (error) {
      sendError = error;
      errorMessage = (error instanceof Error ? error.message : 'Webhook request failed').slice(0, 1000);
    }
    const httpDuration = performance.now() - httpStarted;
    const decision = decideRetry({ attemptNumber: claim.attemptNumber, maxAttempts: claim.maxAttempts,
      status: httpStatus, error: sendError, retryAfter }, options);
    if (decision.kind !== 'succeeded') errorMessage = `${errorMessage ?? 'Webhook request failed'} [${decision.reason}]`;
    const outcome = await completeDelivery(pool, claim, { decision, httpStatus, errorMessage });
    return report(outcome, { http_status: httpStatus, http_duration_ms: httpDuration,
      ...(outcome !== 'lost_lease' && decision.kind !== 'succeeded' ? { reason: decision.reason } : {}),
      ...(outcome === 'retry_scheduled' && decision.kind === 'retry' ? { retry_delay_ms: decision.delayMs } : {}) });
  } catch (error) {
    observe(options.onEvent, { ...context, event: 'delivery.processing_failed', error_code: errorCode(error),
      duration_ms: performance.now() - started });
    throw error;
  }
}
