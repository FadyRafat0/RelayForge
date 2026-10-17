import type { DeliveryOutcome } from '../worker/process.js';
import type { WorkerOutcome } from '../worker/run.js';

export interface DeliveryLogEvent {
  event: 'delivery.claimed' | 'delivery.processed' | 'delivery.processing_failed';
  delivery_id: string;
  worker_id: string;
  endpoint_id?: string;
  event_id?: string;
  attempt_id?: string;
  attempt_number?: number;
  outcome?: DeliveryOutcome;
  http_status?: number | null;
  reason?: string;
  retry_delay_ms?: number;
  duration_ms?: number;
  http_duration_ms?: number;
  error_code?: string;
}
export interface WorkerLogEvent {
  event: 'worker.job_started' | 'worker.job_acknowledged' | 'worker.job_failed' | 'worker.loop_failed';
  consumer: string;
  stream_id?: string;
  delivery_id?: string;
  active_jobs: number;
  outcome?: Exclude<WorkerOutcome, 'empty'>;
  error_code?: string;
}
