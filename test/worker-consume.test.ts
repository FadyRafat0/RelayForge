import { describe, expect, it, vi } from 'vitest';
import { consumeOne } from '../src/worker/consume.js';
import type { DeliveryConsumer } from '../src/queue/redis.js';
import type { DeliveryOutcome } from '../src/worker/process.js';

function setup(deliveryId = '11111111-1111-4111-8111-111111111111') {
  const queue = { read: vi.fn<DeliveryConsumer['read']>().mockResolvedValue({ id: '1-0', deliveryId }),
    ack: vi.fn<DeliveryConsumer['ack']>().mockResolvedValue(undefined) };
  const process = vi.fn<(id: string) => Promise<DeliveryOutcome>>().mockResolvedValue('succeeded');
  return { queue, process };
}
describe('Worker acknowledgement order', () => {
  it('acknowledges only after database processing succeeds', async () => {
    const { queue, process } = setup();
    process.mockImplementation(async () => { expect(queue.ack).not.toHaveBeenCalled(); return 'succeeded'; });
    expect(await consumeOne(queue, 'worker-1', process)).toBe('succeeded');
    expect(queue.ack).toHaveBeenCalledWith('1-0');
  });
  it('leaves the message pending when database processing fails', async () => {
    const { queue, process } = setup();
    process.mockRejectedValue(new Error('Database unavailable'));
    await expect(consumeOne(queue, 'worker-1', process)).rejects.toThrow('Database unavailable');
    expect(queue.ack).not.toHaveBeenCalled();
  });
  it('acknowledges malformed jobs without calling the database handler', async () => {
    const { queue, process } = setup('not-a-uuid');
    expect(await consumeOne(queue, 'worker-1', process)).toBe('malformed');
    expect(queue.ack).toHaveBeenCalledOnce();
    expect(process).not.toHaveBeenCalled();
  });
  it('handles an empty stream without acknowledgement', async () => {
    const { queue, process } = setup();
    queue.read.mockResolvedValue(null);
    expect(await consumeOne(queue, 'worker-1', process)).toBe('empty');
    expect(queue.ack).not.toHaveBeenCalled();
  });
  it('acknowledges a stale job after the worker has lost its database lease', async () => {
    const { queue, process } = setup();
    process.mockResolvedValue('lost_lease');
    expect(await consumeOne(queue, 'worker-1', process)).toBe('lost_lease');
    expect(queue.ack).toHaveBeenCalledWith('1-0');
  });
});
