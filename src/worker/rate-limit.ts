import { createClient } from 'redis';

export type RateAdmission = { allowed: true } | { allowed: false; retryAfterMs: number };
export interface EndpointRateLimiter {
  acquire(endpointId: string, ratePerSecond: number): Promise<RateAdmission>;
}

// Capacity equals one second of refill. Redis TIME avoids differing worker clocks.
// Read, refill, consume, and expiry execute atomically as one small script.
const tokenBucket = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local rate = tonumber(ARGV[1])
local previous = redis.call('HMGET', KEYS[1], 'tokens', 'updated_at')
local tokens = rate
if previous[1] and previous[2] then
  local last = tonumber(previous[2])
  now = math.max(now, last)
  tokens = math.min(rate, tonumber(previous[1]) + (now - last) * rate / 1000)
end
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.max(1, math.ceil((1 - tokens) * 1000 / rate))
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_at', now)
redis.call('PEXPIRE', KEYS[1], 2000)
return {allowed, retry}
`;

export function createEndpointRateLimiter(url: string, onError: (error: Error) => void,
  prefix = 'relayforge:rate-limit:') {
  // A separate connection avoids waiting behind the consumer's blocking read.
  const client = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false },
    disableOfflineQueue: true });
  client.on('error', onError);
  return {
    async connect() { await client.connect(); },
    async acquire(endpointId: string, ratePerSecond: number): Promise<RateAdmission> {
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(endpointId)
        || !Number.isInteger(ratePerSecond) || ratePerSecond < 1 || ratePerSecond > 1000) {
        throw new Error('Invalid endpoint rate-limit configuration');
      }
      const result = await client.withCommandOptions({ timeout: 2000 }).eval(tokenBucket,
        { keys: [prefix + endpointId.toLowerCase()], arguments: [String(ratePerSecond)] });
      if (Array.isArray(result) && result.length === 2) {
        if (result[0] === 1 && result[1] === 0) return { allowed: true };
        const delay = result[1];
        if (result[0] === 0 && typeof delay === 'number' && Number.isInteger(delay) && delay >= 1 && delay <= 1000) {
          return { allowed: false, retryAfterMs: delay };
        }
      }
      throw new Error('Invalid Redis rate-limit decision');
    },
    async close() { if (client.isOpen) await client.close(); },
  };
}
