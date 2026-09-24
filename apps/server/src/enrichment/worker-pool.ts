import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '../db/database.js';
import { failRunningJobsSystemically, finalizeFinishedJobs } from '../jobs/job.repository.js';
import { sleep } from '../lib/sleep.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { EnrichmentClient } from './enrichment-client.js';
import { reapExpiredLeases } from './lease-reaper.js';
import { RateLimiterUnavailableError, type RateLimiter } from './rate-limiter.js';
import {
  attemptOutcomeOf,
  decideAfterFailure,
  describeFailure,
  type RetryPolicyOptions,
} from './retry-policy.js';
import type { ClaimedTask, TaskQueue } from './task-queue.js';

export interface WorkerPoolOptions extends RetryPolicyOptions {
  concurrency: number;
  leaseMs: number;
  /** How long an idle worker waits before looking for work again. */
  idlePollMs: number;
  /** Pause all workers this long after a 429. */
  rateLimitPauseMs: number;
  /** Back-off after an unexpected error (DB or Redis down, bug) so a loop never spins. */
  errorBackoffMs: number;
  /** How often to look for expired leases (also done once at start). */
  reaperIntervalMs: number;
}

export interface WorkerPoolDeps {
  db: DB;
  queue: TaskQueue;
  client: EnrichmentClient;
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  logger: FastifyBaseLogger;
  random?: () => number;
}

/**
 * N independent loops: take a rate-limit slot → claim a task → call the API → record the result.
 *
 * The slot is taken before claiming so a task's lease never ticks away while it waits in
 * line, and so a Redis outage (fail closed) never leaves a claimed task stranded.
 */
export class WorkerPool {
  private readonly controller = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(
    private readonly deps: WorkerPoolDeps,
    private readonly options: WorkerPoolOptions,
  ) {}

  start(): void {
    if (this.loops.length) return;
    this.loops = [
      this.runReaper(),
      ...Array.from({ length: this.options.concurrency }, (_, i) => this.runLoop(i)),
    ];
    this.deps.logger.info({ concurrency: this.options.concurrency }, 'enrichment workers started');
  }

  /** Stops claiming new work and waits for in-flight calls to finish recording. */
  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.all(this.loops);
    this.loops = [];
  }

  /** One unit of work. Exposed for tests. Returns false when there was nothing to do. */
  async tick(signal: AbortSignal = this.controller.signal): Promise<boolean> {
    const { queue, limiter, db } = this.deps;
    await limiter.acquire(signal);
    if (signal.aborted) return false;

    const task = await queue.claimNext(this.options.leaseMs);
    if (!task) {
      // Nothing due: a good moment to close jobs whose last task just finished.
      await finalizeFinishedJobs(db);
      return false;
    }
    await this.process(task);
    return true;
  }

  /**
   * Reclaims tasks from workers that stopped responding. Runs immediately on start,
   * so work stranded by a crash or restart is picked up again, then on an interval.
   */
  async reapOnce(): Promise<void> {
    const { db, logger } = this.deps;
    const result = await reapExpiredLeases(db, this.options.maxAttempts);
    if (result.requeued || result.failed) {
      logger.warn(result, 'reclaimed tasks with expired leases');
    }
    if (result.failed) await finalizeFinishedJobs(db);
  }

  private async runReaper(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        await this.reapOnce();
      } catch (error) {
        this.deps.logger.error({ err: error }, 'lease reaper error');
      }
      await sleep(this.options.reaperIntervalMs, signal);
    }
  }

  private async runLoop(workerId: number): Promise<void> {
    const signal = this.controller.signal;
    const log = this.deps.logger.child({ workerId });
    while (!signal.aborted) {
      try {
        const didWork = await this.tick(signal);
        if (!didWork) await sleep(this.options.idlePollMs, signal);
      } catch (error) {
        // Never let one error kill the loop: log, back off, carry on.
        if (error instanceof RateLimiterUnavailableError) {
          // Expected while Redis is down or reconnecting; no stack trace needed.
          log.warn(
            { reason: error.message },
            'waiting for rate limiter; no API calls until it is back',
          );
        } else {
          log.error({ err: error }, 'worker loop error; backing off');
        }
        await sleep(this.options.errorBackoffMs, signal);
      }
    }
  }

  private async process(task: ClaimedTask): Promise<void> {
    const { queue, client, limiter, logger } = this.deps;
    const log = logger.child({
      taskId: task.taskId,
      storeId: task.store.store_id,
      attempt: task.attempts,
    });

    const startedAt = performance.now();
    const outcome = await client.enrich(task.store);
    const latencyMs = Math.round(performance.now() - startedAt);

    if (outcome.kind === 'success') {
      this.deps.breaker.record(outcome);
      const result = await queue.recordSuccess(task, outcome.metrics, latencyMs);
      if (result === 'stale') log.warn('late success ignored: lease was reclaimed');
      else await finalizeFinishedJobs(this.deps.db);
      return;
    }

    if (outcome.kind === 'rate_limited') {
      await limiter.pause(this.options.rateLimitPauseMs).catch(() => undefined);
    }

    const decision = decideAfterFailure(outcome, task.attempts, this.options, this.deps.random);
    const error = describeFailure(outcome);
    const result = await queue.recordFailure(
      task,
      {
        outcome: attemptOutcomeOf(outcome),
        httpStatus: 'httpStatus' in outcome ? outcome.httpStatus : null,
        latencyMs,
        error,
      },
      decision,
    );

    const verdict = this.deps.breaker.record(outcome, error);
    if (verdict.tripped) {
      const jobIds = await failRunningJobsSystemically(this.deps.db, verdict.reason);
      logger.error({ jobIds, reason: verdict.reason }, 'circuit breaker tripped: job stopped');
      return;
    }

    if (result === 'stale') {
      log.warn({ error }, 'late failure ignored: lease was reclaimed');
    } else if (decision.action === 'fail') {
      log.warn({ reason: decision.reason }, 'store failed permanently');
      await finalizeFinishedJobs(this.deps.db);
    } else {
      log.debug({ error, retryInMs: decision.delayMs }, 'attempt failed; retry scheduled');
    }
  }
}
