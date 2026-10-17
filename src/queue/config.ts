export function loadQueueConfig(env: NodeJS.ProcessEnv = process.env) {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required for the dispatcher');
  try {
    const url = new URL(redisUrl);
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid Redis URL');
  } catch {
    throw new Error('REDIS_URL must be a Redis connection URL');
  }
  return { redisUrl };
}
