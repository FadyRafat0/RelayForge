import type { DeliveryConsumer, DeliveryJob } from '../queue/redis.js';
import { consumeJob } from './consume.js';
import { DEFAULT_WORKER_CONCURRENCY, MAX_WORKER_CONCURRENCY } from './config.js';
import type { DeliveryOutcome } from './process.js';
import type { WorkerLogEvent } from '../observability/events.js';
import { errorCode, observe } from '../observability/logging.js';

export type WorkerOutcome = DeliveryOutcome | 'malformed' | 'empty';
export interface RunOptions {
  concurrency?: number;
  once?: boolean;
  signal?: AbortSignal;
  onOutcome?: (outcome: WorkerOutcome) => void;
  onEvent?: (event: WorkerLogEvent) => void;
}

export async function runWorker(queue: DeliveryConsumer, consumer: string,
  process: (deliveryId: string) => Promise<DeliveryOutcome>, options: RunOptions = {}): Promise<void> {
  const concurrency = options.concurrency ?? DEFAULT_WORKER_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKER_CONCURRENCY) {
    throw new Error(`Worker concurrency must be from 1 to ${MAX_WORKER_CONCURRENCY}`);
  }
  const active = new Set<Promise<void>>();
  let failed = false;
  let firstError: unknown;
  function fail(error: unknown) {
    if (!failed) { failed = true; firstError = error; }
  }
  function launch(job: DeliveryJob) {
    const context = { consumer, stream_id: job.id,
      ...(job.deliveryId && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(job.deliveryId)
        ? { delivery_id: job.deliveryId } : {}) };
    observe(options.onEvent, { ...context, event: 'worker.job_started', active_jobs: active.size + 1 });
    const task = consumeJob(queue, job, process)
      .then(outcome => {
        observe(options.onEvent, { ...context, event: 'worker.job_acknowledged', outcome, active_jobs: active.size });
        options.onOutcome?.(outcome);
      })
      .catch(error => {
        observe(options.onEvent, { ...context, event: 'worker.job_failed', error_code: errorCode(error), active_jobs: active.size });
        fail(error);
      })
      .finally(() => { active.delete(task); });
    active.add(task);
  }
  try {
    while (!options.signal?.aborted && !failed) {
      if (active.size >= concurrency) await Promise.race(active);
      if (options.signal?.aborted || failed) break;
      // Exactly one read is outstanding. A slot is available before Redis assigns work.
      const job = await queue.read(consumer);
      // A stop/failure during a blocking read leaves any returned job pending for recovery.
      if (options.signal?.aborted || failed) break;
      if (job) launch(job);
      else options.onOutcome?.('empty');
      // --once reads at most one job regardless of the configured concurrency.
      if (options.once) break;
    }
  } catch (error) {
    observe(options.onEvent, { event: 'worker.loop_failed', consumer, error_code: errorCode(error), active_jobs: active.size });
    fail(error);
  }
  // Every task handles its rejection immediately; peers drain even after a failure.
  await Promise.all(active);
  if (failed) throw firstError;
}
