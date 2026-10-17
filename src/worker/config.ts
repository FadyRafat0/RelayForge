export const DEFAULT_WORKER_CONCURRENCY = 4;
export const MAX_WORKER_CONCURRENCY = 16;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.ALLOW_LOOPBACK_ENDPOINTS !== undefined && !['true', 'false'].includes(env.ALLOW_LOOPBACK_ENDPOINTS)) {
    throw new Error('ALLOW_LOOPBACK_ENDPOINTS must be true or false');
  }
  const concurrencyText = env.WORKER_CONCURRENCY ?? String(DEFAULT_WORKER_CONCURRENCY);
  const concurrency = Number(concurrencyText);
  if (!/^[1-9][0-9]*$/.test(concurrencyText) || !Number.isInteger(concurrency) || concurrency > MAX_WORKER_CONCURRENCY) {
    throw new Error(`WORKER_CONCURRENCY must be an integer from 1 to ${MAX_WORKER_CONCURRENCY}`);
  }
  return { allowLoopback: env.ALLOW_LOOPBACK_ENDPOINTS === 'true', concurrency };
}
