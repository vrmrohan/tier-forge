import type { EnrichmentOutcome } from './types.js';

export interface CircuitBreakerOptions {
  /** How long failures must continue, with no success in between, before tripping. */
  windowMs: number;
  /** Minimum failures in that streak, so one slow call can't trip it alone. */
  minFailures: number;
}

export type BreakerVerdict = { tripped: false } | { tripped: true; reason: string };

/**
 * Detects a systemically broken Enrichment API.
 *
 * Only signals that the API itself is unhealthy count: 5xx, timeouts, network errors and
 * malformed bodies. Any success resets the streak, so the simulator's normal ~12% failure
 * noise never trips it. 429s (our pacing) and other 4xx (our request) are ignored: they
 * say nothing about the API's health. A short outage, like a quick restart, ends with a
 * success before the window runs out and is simply retried through.
 */
export class CircuitBreaker {
  private streakStartedAt: number | undefined;
  private lastFailureAt: number | undefined;
  private streakFailures = 0;
  private lastError = '';

  constructor(
    private readonly options: CircuitBreakerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  record(outcome: EnrichmentOutcome, errorDescription = ''): BreakerVerdict {
    switch (outcome.kind) {
      case 'success':
        this.reset();
        return { tripped: false };
      case 'rate_limited':
      case 'client_error':
        return { tripped: false };
      case 'server_error':
      case 'timeout':
      case 'network_error':
      case 'invalid_response':
        break;
    }

    const now = this.now();
    // A streak only counts while failures keep coming. After a quiet gap (e.g. between jobs)
    // an old streak is stale and a new one starts.
    if (this.lastFailureAt !== undefined && now - this.lastFailureAt > this.options.windowMs) {
      this.reset();
    }
    this.streakStartedAt ??= now;
    this.lastFailureAt = now;
    this.streakFailures += 1;
    this.lastError = errorDescription || outcome.kind;

    const elapsed = now - this.streakStartedAt;
    if (elapsed >= this.options.windowMs && this.streakFailures >= this.options.minFailures) {
      const reason =
        `Enrichment API failing continuously for ${Math.round(elapsed / 1000)}s ` +
        `(${this.streakFailures} failures in a row, no success); last error: ${this.lastError}`;
      this.reset(); // the next job starts with a clean slate
      return { tripped: true, reason };
    }
    return { tripped: false };
  }

  private reset(): void {
    this.streakStartedAt = undefined;
    this.lastFailureAt = undefined;
    this.streakFailures = 0;
    this.lastError = '';
  }
}
