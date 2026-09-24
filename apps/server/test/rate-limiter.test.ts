import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryRateLimiter,
  createRedisRateLimiter,
  pauseUntil,
  reserveSlot,
  type RateLimiter,
} from '../src/enrichment/rate-limiter.js';

describe('reserveSlot', () => {
  it('gives an idle limiter a slot right now', () => {
    expect(reserveSlot(1_000, 0, 250)).toEqual({ waitMs: 0, nextFreeMs: 1_250 });
  });

  it('queues callers one interval apart, never in a burst', () => {
    let next = 0;
    const waits = [0, 0, 0, 0, 0].map(() => {
      const r = reserveSlot(1_000, next, 250);
      next = r.nextFreeMs;
      return r.waitMs;
    });
    expect(waits).toEqual([0, 250, 500, 750, 1_000]);
  });

  it('pause pushes the next slot out but never pulls it closer', () => {
    expect(pauseUntil(1_000, 1_250, 1_000)).toBe(2_000);
    expect(pauseUntil(1_000, 5_000, 1_000)).toBe(5_000);
  });
});

/** At 20/s, 6 acquisitions must take at least 5 intervals (250 ms). */
async function expectEvenSpacing(limiter: RateLimiter): Promise<void> {
  const start = performance.now();
  const times: number[] = [];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      await limiter.acquire();
      times.push(performance.now() - start);
    }),
  );
  times.sort((a, b) => a - b);
  expect(times.at(-1)!).toBeGreaterThanOrEqual(240);
  // No two calls closer than ~one interval (small tolerance for timer jitter).
  for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThan(35);
}

describe('in-memory rate limiter', () => {
  it('spaces concurrent callers evenly', async () => {
    await expectEvenSpacing(createInMemoryRateLimiter(20));
  });
});

/**
 * Uses a real Redis when one is reachable: TEST_REDIS_URL, else redis://localhost:6379.
 * Skipped (not failed) when none is running, so `npm test` works on any machine.
 * Set TEST_REDIS_URL=off to skip it explicitly.
 */
async function findRedis(): Promise<string | undefined> {
  const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
  if (url === 'off') return undefined;
  const probe = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });
  probe.on('error', () => undefined); // a refused connection is an answer, not a test failure
  try {
    await probe.connect();
    await probe.ping();
    return url;
  } catch {
    return undefined;
  } finally {
    probe.disconnect();
  }
}

const redisUrl = await findRedis();
const redisLabel = redisUrl
  ? `redis rate limiter (${redisUrl})`
  : 'redis rate limiter (skipped: no Redis reachable; start one or set TEST_REDIS_URL)';

describe.skipIf(!redisUrl)(redisLabel, () => {
  it('spaces callers evenly across separate clients (like separate processes)', async () => {
    const key = `tierforge:test:${Date.now()}`;
    const a = new Redis(redisUrl!);
    const b = new Redis(redisUrl!);
    const limiterA = createRedisRateLimiter(a, 20, key);
    const limiterB = createRedisRateLimiter(b, 20, key);
    const shared: RateLimiter = {
      acquire: (s) => (Math.random() < 0.5 ? limiterA : limiterB).acquire(s),
      pause: (ms) => limiterA.pause(ms),
    };
    try {
      await expectEvenSpacing(shared);
    } finally {
      await Promise.all([a.quit(), b.quit()]);
    }
  });
});
