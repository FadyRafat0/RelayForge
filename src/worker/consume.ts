import type { DeliveryConsumer, DeliveryJob } from '../queue/redis.js';
import type { DeliveryOutcome } from './process.js';

export async function consumeOne(queue: DeliveryConsumer, consumer: string,
  process: (deliveryId: string) => Promise<DeliveryOutcome>) {
  const job = await queue.read(consumer);
  if (!job) return 'empty';
  return consumeJob(queue, job, process);
}

// Shared by the one-shot consumer and the bounded concurrent runner.
export async function consumeJob(queue: Pick<DeliveryConsumer, 'ack'>, job: DeliveryJob,
  process: (deliveryId: string) => Promise<DeliveryOutcome>) {
  if (!job.deliveryId || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(job.deliveryId)) {
    await queue.ack(job.id);
    return 'malformed';
  }
  const outcome = await process(job.deliveryId);
  // A database failure throws before this line, leaving the job pending in Redis.
  await queue.ack(job.id);
  return outcome;
}
