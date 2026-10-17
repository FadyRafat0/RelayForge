import { createClient } from 'redis';

export const DELIVERY_STREAM = 'relayforge:deliveries';
export const DELIVERY_GROUP = 'relayforge-workers';

export interface DeliveryPublisher {
  publish(deliveryId: string): Promise<string>;
}

function queueClient(url: string, onError: (error: Error) => void) {
  const client = createClient({
    url,
    socket: { connectTimeout: 2000, reconnectStrategy: false },
    disableOfflineQueue: true,
  });
  client.on('error', onError);
  return client;
}

export function createDeliveryQueue(url: string, onError: (error: Error) => void, stream = DELIVERY_STREAM) {
  const client = queueClient(url, onError);
  return {
    async connect() { await client.connect(); },
    async publish(deliveryId: string): Promise<string> {
      // A timeout may mean Redis appended the entry but the reply was lost.
      // Retrying is safe only because duplicate jobs are part of our contract.
      const id = await client.withCommandOptions({ timeout: 2000 })
        .xAdd(stream, '*', { delivery_id: deliveryId });
      if (!id) throw new Error('Redis returned no stream ID');
      return id;
    },
    async close() {
      if (client.isOpen) await client.close();
    },
  };
}

export interface DeliveryJob { id: string; deliveryId: string | undefined }
export interface DeliveryConsumer {
  read(consumer: string): Promise<DeliveryJob | null>;
  ack(id: string): Promise<void>;
}

export function createDeliveryConsumer(url: string, onError: (error: Error) => void,
  stream = DELIVERY_STREAM, group = DELIVERY_GROUP) {
  const reader = queueClient(url, onError);
  const control = queueClient(url, onError);
  let reclaimCursor = '0-0';
  return {
    async connect() {
      await control.connect();
      try {
        // Start at 0 so jobs published before the first worker are included.
        await control.withCommandOptions({ timeout: 2000 }).xGroupCreate(stream, group, '0', { MKSTREAM: true });
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith('BUSYGROUP'))) throw error;
      }
      await reader.connect();
    },
    async read(consumer: string): Promise<DeliveryJob | null> {
      const reclaimed = await reader.withCommandOptions({ timeout: 2000 })
        .xAutoClaim(stream, group, consumer, 60000, reclaimCursor, { COUNT: 1 });
      reclaimCursor = reclaimed.nextId;
      const old = reclaimed.messages.find(message => message !== null);
      if (old) return { id: old.id, deliveryId: old.message.delivery_id };
      const streams = await reader.withCommandOptions({ timeout: 2500 })
        .xReadGroup(group, consumer, { key: stream, id: '>' }, { COUNT: 1, BLOCK: 1000 });
      const job = streams?.[0]?.messages[0];
      return job ? { id: job.id, deliveryId: job.message.delivery_id } : null;
    },
    async ack(id: string) {
      await control.withCommandOptions({ timeout: 2000 }).xAck(stream, group, id);
    },
    async close() {
      await Promise.all([reader.isOpen ? reader.close() : undefined, control.isOpen ? control.close() : undefined]);
    },
  };
}
