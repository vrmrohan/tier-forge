import type { Redis } from 'ioredis';
import { sleep } from '../lib/sleep.js';

/**
 * Global pacing for calls to the Enrichment API.
 *
 * The simulator counts calls in fixed 1-second windows (rejected calls count too), so
 * bursts at a window edge get 429s. Instead of a bursty token bucket we hand out
 * evenly spaced time slots: each caller reserves the next free slot and waits for it.
 * At 4/s that is one call every 250 ms, never two close together.
 */
export interface RateLimiter {
  /**
   * Reserves the next free slot without waiting. `slotMs` is the slot's absolute time on the
   * limiter's clock; `waitMs` is how long until it. Exposed so the spacing can be verified exactly.
   */
  reserve(): Promise<SlotReservation & { slotMs: number }>;
  /** Waits until this caller may send one request. Throws if the limiter is unavailable. */
  acquire(signal?: AbortSignal): Promise<void>;
  /** Pushes every caller's next slot at least `ms` into the future (used after a 429). */
  pause(ms: number): Promise<void>;
}

/** Redis (or whatever backs the limiter) can't be reached. Workers wait; they never call the API unthrottled. */
export class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`rate limiter unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'RateLimiterUnavailableError';
  }
}

export interface SlotReservation {
  waitMs: number;
  nextFreeMs: number;
}

/** Pure scheduling rule shared by both implementations (and mirrored in the Lua script). */
export function reserveSlot(
  nowMs: number,
  nextFreeMs: number,
  intervalMs: number,
): SlotReservation {
  const slot = Math.max(nowMs, nextFreeMs);
  return { waitMs: slot - nowMs, nextFreeMs: slot + intervalMs };
}

export function pauseUntil(nowMs: number, nextFreeMs: number, pauseMs: number): number {
  return Math.max(nextFreeMs, nowMs + pauseMs);
}

const intervalFor = (perSecond: number): number => Math.ceil(1000 / perSecond);

// KEYS[1] = limiter key, ARGV[1] = interval ms. Uses Redis' own clock so every
// process agrees on "now". Returns { wait ms, slot time ms }.
const RESERVE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local nextFree = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, nextFree)
redis.call('SET', KEYS[1], slot + tonumber(ARGV[1]), 'PX', 60000)
return { slot - now, slot }
`;

// KEYS[1] = limiter key, ARGV[1] = pause ms.
const PAUSE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local nextFree = tonumber(redis.call('GET', KEYS[1]) or '0')
redis.call('SET', KEYS[1], math.max(nextFree, now + tonumber(ARGV[1])), 'PX', 60000)
return 1
`;

/** Shared across every worker in every process and every job: one global limit. */
export function createRedisRateLimiter(
  redis: Redis,
  perSecond: number,
  key = 'tierforge:enrichment-api:next-slot',
): RateLimiter {
  const interval = intervalFor(perSecond);
  const reserve: RateLimiter['reserve'] = async () => {
    // Fail closed: if Redis is down this throws and the worker backs off without calling the API.
    let reply: unknown;
    try {
      reply = await redis.eval(RESERVE_SCRIPT, 1, key, interval);
    } catch (error) {
      throw new RateLimiterUnavailableError(error);
    }
    const [waitMs, slotMs] = (reply as [number, number]).map(Number) as [number, number];
    return { waitMs, slotMs, nextFreeMs: slotMs + interval };
  };
  return {
    reserve,
    async acquire(signal) {
      const { waitMs } = await reserve();
      await sleep(waitMs, signal);
    },
    async pause(ms) {
      await redis.eval(PAUSE_SCRIPT, 1, key, ms);
    },
  };
}

/** Same behavior in-process; used by tests and single-process tools. */
export function createInMemoryRateLimiter(
  perSecond: number,
  now: () => number = Date.now,
): RateLimiter {
  const interval = intervalFor(perSecond);
  let nextFreeMs = 0;
  const reserve: RateLimiter['reserve'] = async () => {
    const t = now();
    const reservation = reserveSlot(t, nextFreeMs, interval);
    nextFreeMs = reservation.nextFreeMs;
    return { ...reservation, slotMs: t + reservation.waitMs };
  };
  return {
    reserve,
    async acquire(signal) {
      const { waitMs } = await reserve();
      await sleep(waitMs, signal);
    },
    async pause(ms) {
      nextFreeMs = pauseUntil(now(), nextFreeMs, ms);
    },
  };
}
