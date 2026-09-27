import { Redis } from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url, {
    // Fail fast instead of queueing commands forever while Redis is down;
    // callers treat a Redis error as "no token available" (fail closed).
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
}

/** Resolves once the client is connected, or rejects after `timeoutMs`. */
export function waitForRedis(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      reject(new Error(`Redis not ready after ${timeoutMs} ms (status: ${redis.status})`));
    }, timeoutMs);
    function onReady(): void {
      clearTimeout(timer);
      resolve();
    }
    redis.once('ready', onReady);
  });
}
