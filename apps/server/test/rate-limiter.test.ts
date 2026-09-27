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

/**
 * The limiter's guarantee is the schedule it hands out: every caller gets its own slot,
 * exactly one interval apart, with no two in the same window. Checking the reserved slots
 * (not when JS timers happen to fire) keeps this exact even on a busy machine, where an
 * event-loop stall can fire two timers in the same tick.
 */
async function expectEvenlySpacedSlots(limiter: RateLimiter, intervalMs: number): Promise<void> {
  const slots = await Promise.all(Array.from({ length: 6 }, () => limiter.reserve()));
  const times = slots.map((s) => s.slotMs).sort((a, b) => a - b);
  expect(new Set(times).size).toBe(6);
  for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBe(intervalMs);
}

/** acquire() really waits: 6 calls at 20/s can't all finish before 5 intervals have passed. */
async function expectAcquireWaits(limiter: RateLimiter): Promise<void> {
  const start = performance.now();
  await Promise.all(Array.from({ length: 6 }, () => limiter.acquire()));
  // Lower bound only: a busy machine can make this slower, never faster.
  expect(performance.now() - start).toBeGreaterThanOrEqual(240);
}

describe('in-memory rate limiter', () => {
  it('hands concurrent callers slots exactly one interval apart', async () => {
    await expectEvenlySpacedSlots(createInMemoryRateLimiter(20), 50);
  });

  it('makes callers wait for their slot', async () => {
    await expectAcquireWaits(createInMemoryRateLimiter(20));
  });

  it('pushes every later slot out after a pause', async () => {
    let now = 1_000;
    const limiter = createInMemoryRateLimiter(4, () => now);
    expect((await limiter.reserve()).slotMs).toBe(1_000);
    await limiter.pause(2_000);
    expect((await limiter.reserve()).slotMs).toBe(3_000);
    now = 10_000;
    expect((await limiter.reserve()).slotMs).toBe(10_000);
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
  it('hands slots one interval apart across separate clients (like separate processes)', async () => {
    const key = `tierforge:test:${Date.now()}:${Math.random()}`;
    const a = new Redis(redisUrl!);
    const b = new Redis(redisUrl!);
    const limiterA = createRedisRateLimiter(a, 20, key);
    const limiterB = createRedisRateLimiter(b, 20, key);
    let turn = 0;
    const shared: RateLimiter = {
      reserve: () => (turn++ % 2 ? limiterA : limiterB).reserve(),
      acquire: (s) => (turn++ % 2 ? limiterA : limiterB).acquire(s),
      pause: (ms) => limiterA.pause(ms),
    };
    try {
      await expectEvenlySpacedSlots(shared, 50);
      await a.del(key);
      await expectAcquireWaits(shared);
    } finally {
      await a.del(key);
      await Promise.all([a.quit(), b.quit()]);
    }
  });
});
