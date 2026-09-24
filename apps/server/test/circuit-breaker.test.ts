import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/enrichment/circuit-breaker.js';
import type { EnrichmentOutcome } from '../src/enrichment/types.js';

const fail: EnrichmentOutcome = { kind: 'server_error', httpStatus: 500, message: 'boom' };
const ok: EnrichmentOutcome = {
  kind: 'success',
  httpStatus: 200,
  metrics: { footfall: 1, revenue: 1, sizeSqft: 1 },
};

function breakerAt(start = 0) {
  let now = start;
  const breaker = new CircuitBreaker({ windowMs: 30_000, minFailures: 10 }, () => now);
  return { breaker, advance: (ms: number) => (now += ms) };
}

describe('CircuitBreaker', () => {
  it('trips after 30 s of unbroken failures', () => {
    const { breaker, advance } = breakerAt();
    for (let i = 0; i < 120; i++) {
      const verdict = breaker.record(fail, 'HTTP 500: boom');
      if (i < 120 && advance(0) < 30_000) expect(verdict.tripped).toBe(false);
      advance(250);
    }
    const verdict = breaker.record(fail, 'HTTP 500: boom');
    expect(verdict).toMatchObject({ tripped: true });
    expect(verdict.tripped && verdict.reason).toContain('last error: HTTP 500: boom');
  });

  it('never trips on normal noise: any success resets the streak', () => {
    const { breaker, advance } = breakerAt();
    for (let i = 0; i < 2_000; i++) {
      // 1 in 5 calls succeeds: far worse than the simulator's ~88%, still healthy.
      expect(breaker.record(i % 5 === 0 ? ok : fail).tripped).toBe(false);
      advance(250);
    }
  });

  it('rides out a short outage such as a quick restart', () => {
    const { breaker, advance } = breakerAt();
    for (let i = 0; i < 80; i++) {
      expect(breaker.record({ kind: 'network_error', message: 'ECONNREFUSED' }).tripped).toBe(
        false,
      );
      advance(250); // 20 s of failures
    }
    expect(breaker.record(ok).tripped).toBe(false);
    advance(15_000);
    expect(breaker.record(fail).tripped).toBe(false); // new streak starts from zero
  });

  it('needs a minimum number of failures, not just elapsed time', () => {
    const { breaker, advance } = breakerAt();
    breaker.record({ kind: 'timeout', timeoutMs: 10_000 });
    advance(29_000);
    breaker.record({ kind: 'timeout', timeoutMs: 10_000 });
    advance(2_000);
    expect(breaker.record({ kind: 'timeout', timeoutMs: 10_000 }).tripped).toBe(false);
  });

  it('ignores 429s and other 4xx: they are about us, not the API', () => {
    const { breaker, advance } = breakerAt();
    for (let i = 0; i < 200; i++) {
      expect(breaker.record({ kind: 'rate_limited', httpStatus: 429 }).tripped).toBe(false);
      expect(
        breaker.record({ kind: 'client_error', httpStatus: 422, message: 'bad' }).tripped,
      ).toBe(false);
      advance(250);
    }
  });

  it('drops a stale streak after a quiet gap (e.g. between jobs)', () => {
    const { breaker, advance } = breakerAt();
    for (let i = 0; i < 9; i++) breaker.record(fail);
    advance(60 * 60_000); // an hour later, a new job's first failures
    expect(breaker.record(fail).tripped).toBe(false);
  });
});
