import type { AttemptOutcome } from '../db/schema.js';
import type { FailureOutcome } from './types.js';

export interface RetryPolicyOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type FailureDecision =
  { action: 'retry'; delayMs: number } | { action: 'fail'; reason: string };

/**
 * Exponential backoff with "equal jitter": half of the capped exponential delay is fixed,
 * half is random. The fixed half guarantees a real pause; the random half stops
 * workers that failed together from retrying together.
 *
 *   attempt 1 → 0.5–1 s, 2 → 1–2 s, 3 → 2–4 s, 4 → 4–8 s … capped at maxDelayMs.
 */
export function backoffDelayMs(
  attempt: number,
  { baseDelayMs, maxDelayMs }: Pick<RetryPolicyOptions, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(maxDelayMs, exponential);
  return Math.round(capped / 2 + random() * (capped / 2));
}

/** One line describing a failed call, stored as the task's last_error. */
export function describeFailure(outcome: FailureOutcome): string {
  switch (outcome.kind) {
    case 'rate_limited':
      return 'HTTP 429: rate limited';
    case 'server_error':
      return `HTTP ${outcome.httpStatus}: ${outcome.message}`;
    case 'client_error':
      return `HTTP ${outcome.httpStatus}: ${outcome.message}`;
    case 'invalid_response':
      return `invalid response: ${outcome.message}`;
    case 'timeout':
      return `no response within ${outcome.timeoutMs / 1000}s`;
    case 'network_error':
      return `network error: ${outcome.message}`;
  }
}

/** Maps a failed call to the value stored in enrichment_attempts.outcome. */
export function attemptOutcomeOf(outcome: FailureOutcome): AttemptOutcome {
  switch (outcome.kind) {
    case 'rate_limited':
      return 'RATE_LIMITED';
    case 'server_error':
    case 'invalid_response':
      return 'SERVER_ERROR';
    case 'client_error':
      return 'CLIENT_ERROR';
    case 'timeout':
      return 'TIMEOUT';
    case 'network_error':
      return 'NETWORK_ERROR';
  }
}

/**
 * What to do with a task whose latest attempt failed.
 * `attempts` already includes the attempt that just failed.
 *
 * - 4xx other than 429 means our request is wrong; retrying can't help.
 * - Everything else (429, 5xx, timeouts, network errors, bad bodies) is retried
 *   until the attempt budget is spent. 429s count too, so the loop is always bounded.
 */
export function decideAfterFailure(
  outcome: FailureOutcome,
  attempts: number,
  options: RetryPolicyOptions,
  random: () => number = Math.random,
): FailureDecision {
  const description = describeFailure(outcome);
  if (outcome.kind === 'client_error') {
    return { action: 'fail', reason: `not retryable: ${description}` };
  }
  if (attempts >= options.maxAttempts) {
    return {
      action: 'fail',
      reason: `gave up after ${attempts} attempts; last error: ${description}`,
    };
  }
  return { action: 'retry', delayMs: backoffDelayMs(attempts, options, random) };
}
