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
