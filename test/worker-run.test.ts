import { describe, expect, it, vi } from 'vitest';
import type { DeliveryConsumer, DeliveryJob } from '../src/queue/redis.js';
import { loadWorkerConfig } from '../src/worker/config.js';
import { runWorker } from '../src/worker/run.js';
import type { DeliveryOutcome } from '../src/worker/process.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function job(index: number): DeliveryJob {
  return { id: `${index}-0`, deliveryId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` };
}
function queue(jobs: DeliveryJob[]) {
  return { read: vi.fn<DeliveryConsumer['read']>().mockImplementation(async () => jobs.shift() ?? null),
    ack: vi.fn<DeliveryConsumer['ack']>().mockResolvedValue(undefined) };
}

describe('Worker concurrency configuration', () => {
  it('accepts both concurrency boundaries', () => {
    expect(loadWorkerConfig({ WORKER_CONCURRENCY: '1' }).concurrency).toBe(1);
    expect(loadWorkerConfig({ WORKER_CONCURRENCY: '16' }).concurrency).toBe(16);
  });
  it.each(['', '0', '-1', '17', '1.5', '1e1', '01', ' 2', 'two'])('rejects invalid WORKER_CONCURRENCY %j', value => {
    expect(() => loadWorkerConfig({ WORKER_CONCURRENCY: value })).toThrow('WORKER_CONCURRENCY');
  });
});

describe('Bounded worker runner', () => {
  it('fills available slots, does not prefetch past capacity, and drains on stop', async () => {
    const source = queue([job(1), job(2), job(3), job(4)]);
    const gates = [deferred<DeliveryOutcome>(), deferred<DeliveryOutcome>(), deferred<DeliveryOutcome>()];
    const twoStarted = deferred(), threeStarted = deferred();
    const stop = new AbortController();
    let started = 0;
    const process = vi.fn(async () => {
      const gate = gates[started++]!;
      if (started === 2) twoStarted.resolve();
      if (started === 3) threeStarted.resolve();
      return gate.promise;
    });
    const running = runWorker(source, 'worker', process, { concurrency: 2, signal: stop.signal });
    await twoStarted.promise;
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(source.ack).not.toHaveBeenCalled();
    gates[0]!.resolve('succeeded');
    await threeStarted.promise;
    expect(source.read).toHaveBeenCalledTimes(3);
    expect(source.ack).toHaveBeenCalledWith('1-0');
    stop.abort();
    gates[1]!.resolve('succeeded');
    gates[2]!.resolve('succeeded');
    await running;
    expect(source.read).toHaveBeenCalledTimes(3);
    expect(source.ack).toHaveBeenCalledTimes(3);
  });
  it('keeps a slot occupied until acknowledgement finishes', async () => {
    const source = queue([job(1), job(2)]);
    const ackStarted = deferred(), ackFinished = deferred();
    const stop = new AbortController();
    source.ack.mockImplementation(async () => { ackStarted.resolve(); await ackFinished.promise; });
    const running = runWorker(source, 'worker', async () => 'succeeded', { concurrency: 1, signal: stop.signal });
    await ackStarted.promise;
    expect(source.read).toHaveBeenCalledOnce();
    stop.abort();
    ackFinished.resolve();
    await running;
    expect(source.read).toHaveBeenCalledOnce();
  });
  it('acknowledges completed jobs while another queue read is still pending', async () => {
    const source = queue([]);
    const pendingRead = deferred<DeliveryJob | null>(), readStarted = deferred(), processed = deferred<DeliveryOutcome>();
    const acknowledged = deferred();
    const stop = new AbortController();
    source.read.mockResolvedValueOnce(job(1)).mockImplementationOnce(async () => {
      readStarted.resolve(); return pendingRead.promise;
    });
    source.ack.mockImplementation(async () => { acknowledged.resolve(); });
    const running = runWorker(source, 'worker', async () => processed.promise, { concurrency: 2, signal: stop.signal });
    await readStarted.promise;
    processed.resolve('succeeded');
    await acknowledged.promise;
    stop.abort();
    pendingRead.resolve(null);
    await running;
  });
  it('stops new reads on processing failure but drains and acknowledges successful peers', async () => {
    const source = queue([job(1), job(2), job(3)]);
    const gates = [deferred<DeliveryOutcome>(), deferred<DeliveryOutcome>()];
    const started = deferred();
    let calls = 0;
    const running = runWorker(source, 'worker', async () => {
      const gate = gates[calls++]!;
      if (calls === 2) started.resolve();
      return gate.promise;
    }, { concurrency: 2 });
    const failure = expect(running).rejects.toThrow('database failed');
    await started.promise;
    gates[0]!.reject(new Error('database failed'));
    gates[1]!.resolve('succeeded');
    await failure;
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(source.ack.mock.calls).toEqual([['2-0']]);
  });
  it('drains an active job after a read failure, then reports the failure', async () => {
    const source = queue([]);
    const processGate = deferred<DeliveryOutcome>(), readFailed = deferred();
    source.read.mockResolvedValueOnce(job(1)).mockImplementationOnce(async () => {
      readFailed.resolve(); throw new Error('Redis read failed');
    });
    const running = runWorker(source, 'worker', async () => processGate.promise, { concurrency: 2 });
    const failure = expect(running).rejects.toThrow('Redis read failed');
    await readFailed.promise;
    expect(source.ack).not.toHaveBeenCalled();
    processGate.resolve('succeeded');
    await failure;
    expect(source.ack).toHaveBeenCalledWith('1-0');
  });
  it('leaves a job assigned during shutdown pending without processing or acknowledging it', async () => {
    const source = queue([]);
    const read = deferred<DeliveryJob | null>(), started = deferred();
    source.read.mockImplementation(async () => { started.resolve(); return read.promise; });
    const process = vi.fn(async (): Promise<DeliveryOutcome> => 'succeeded');
    const stop = new AbortController();
    const running = runWorker(source, 'worker', process, { signal: stop.signal });
    await started.promise;
    stop.abort();
    read.resolve(job(1));
    await running;
    expect(process).not.toHaveBeenCalled();
    expect(source.ack).not.toHaveBeenCalled();
  });
  it('surfaces acknowledgement failures without fetching another job', async () => {
    const source = queue([job(1), job(2)]);
    source.ack.mockRejectedValue(new Error('Redis acknowledgement failed'));
    await expect(runWorker(source, 'worker', async () => 'succeeded', { concurrency: 1 }))
      .rejects.toThrow('Redis acknowledgement failed');
    expect(source.read).toHaveBeenCalledOnce();
  });
  it('reads just one job in once mode even with sixteen slots configured', async () => {
    const source = queue([job(1), job(2)]);
    const onOutcome = vi.fn();
    await runWorker(source, 'worker', async () => 'succeeded', { once: true, concurrency: 16, onOutcome });
    expect(source.read).toHaveBeenCalledOnce();
    expect(source.ack).toHaveBeenCalledOnce();
    expect(onOutcome).toHaveBeenCalledWith('succeeded');
  });
  it('reports an empty once read and skips all reads when already stopped', async () => {
    const source = queue([]), onOutcome = vi.fn();
    await runWorker(source, 'worker', async () => 'succeeded', { once: true, onOutcome });
    expect(onOutcome).toHaveBeenCalledWith('empty');
    await runWorker(source, 'worker', async () => 'succeeded', { signal: AbortSignal.abort() });
    expect(source.read).toHaveBeenCalledOnce();
  });
  it.each([0, -1, 1.5, 17, NaN])('rejects an invalid direct runner limit %s', async concurrency => {
    const source = queue([]);
    await expect(runWorker(source, 'worker', async () => 'succeeded', { concurrency })).rejects.toThrow('concurrency');
    expect(source.read).not.toHaveBeenCalled();
  });
});
