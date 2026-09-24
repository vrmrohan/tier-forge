import { describe, expect, it } from 'vitest';
import { backoffDelayMs, decideAfterFailure } from '../src/enrichment/retry-policy.js';
import type { FailureOutcome } from '../src/enrichment/types.js';

const options = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000 };
const serverError: FailureOutcome = { kind: 'server_error', httpStatus: 500, message: 'boom' };

describe('backoffDelayMs', () => {
  it('doubles per attempt with half fixed, half random', () => {
    expect(backoffDelayMs(1, options, () => 0)).toBe(500);
    expect(backoffDelayMs(1, options, () => 1)).toBe(1_000);
    expect(backoffDelayMs(2, options, () => 0)).toBe(1_000);
    expect(backoffDelayMs(3, options, () => 1)).toBe(4_000);
  });

  it('never exceeds the cap', () => {
    expect(backoffDelayMs(20, options, () => 1)).toBe(30_000);
    expect(backoffDelayMs(20, options, () => 0)).toBe(15_000);
  });
});

describe('decideAfterFailure', () => {
  it('retries transient failures while attempts remain', () => {
    for (const outcome of [
      serverError,
      { kind: 'rate_limited', httpStatus: 429 },
      { kind: 'timeout', timeoutMs: 10_000 },
      { kind: 'network_error', message: 'ECONNREFUSED' },
      { kind: 'invalid_response', httpStatus: 200, message: 'bad body' },
    ] satisfies FailureOutcome[]) {
      expect(decideAfterFailure(outcome, 1, options, () => 0).action).toBe('retry');
    }
  });

  it('fails immediately on a non-retryable 4xx', () => {
    const decision = decideAfterFailure(
      { kind: 'client_error', httpStatus: 422, message: 'field required' },
      1,
      options,
    );
    expect(decision).toEqual({ action: 'fail', reason: 'not retryable: HTTP 422: field required' });
  });

  it('gives up once the attempt budget is spent, keeping the last error', () => {
    expect(decideAfterFailure(serverError, 4, options).action).toBe('retry');
    expect(decideAfterFailure(serverError, 5, options)).toEqual({
      action: 'fail',
      reason: 'gave up after 5 attempts; last error: HTTP 500: boom',
    });
  });

  it('describes timeouts in plain words', () => {
    const decision = decideAfterFailure({ kind: 'timeout', timeoutMs: 10_000 }, 5, options);
    expect(decision).toMatchObject({ reason: expect.stringContaining('no response within 10s') });
  });
});
