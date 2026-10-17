import { describe, expect, it } from 'vitest';
import { loadQueueConfig } from '../src/queue/config.js';

describe('Dispatcher Redis configuration', () => {
  it('requires a Redis URL only for the dispatcher role', () => {
    expect(() => loadQueueConfig({})).toThrow('REDIS_URL is required');
  });
  it.each(['redis://localhost:6379', 'rediss://user:password@localhost:6379/0'])('accepts %s', redisUrl => {
    expect(loadQueueConfig({ REDIS_URL: redisUrl })).toEqual({ redisUrl });
  });
  it.each(['', 'not-a-url', 'https://localhost', 'redis:///0'])('rejects invalid Redis URL %j', value => {
    expect(() => loadQueueConfig({ REDIS_URL: value })).toThrow('REDIS_URL');
  });
});
