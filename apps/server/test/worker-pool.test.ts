import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/database.js';
import { CircuitBreaker } from '../src/enrichment/circuit-breaker.js';
import type { EnrichmentClient } from '../src/enrichment/enrichment-client.js';
import {
  createInMemoryRateLimiter,
  RateLimiterUnavailableError,
  type RateLimiter,
} from '../src/enrichment/rate-limiter.js';
import { createTaskQueue } from '../src/enrichment/task-queue.js';
import type { EnrichmentOutcome } from '../src/enrichment/types.js';
import { WorkerPool, type WorkerPoolOptions } from '../src/enrichment/worker-pool.js';
import { createJobRepository, type JobView } from '../src/jobs/job.repository.js';
import { createTestDb } from './test-db.js';
import { resetJobs, seedUpload } from './seed.js';

const logger = pino({ level: 'silent' });
const baseOptions: WorkerPoolOptions = {
  concurrency: 4,
  leaseMs: 30_000,
  idlePollMs: 5,
  rateLimitPauseMs: 0,
  errorBackoffMs: 5,
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 4,
  reaperIntervalMs: 20,
};
const success = (n: number): EnrichmentOutcome => ({
  kind: 'success',
  httpStatus: 200,
  metrics: { footfall: n, revenue: n * 10, sizeSqft: n },
});

async function runUntilDone(db: DB, pool: WorkerPool, jobId: string): Promise<JobView> {
  const jobs = createJobRepository(db);
  pool.start();
  const deadline = Date.now() + 20_000;
  try {
    for (;;) {
      const job = (await jobs.findById(jobId))!;
      if (job.status !== 'RUNNING') return job;
      if (Date.now() > deadline) throw new Error('job did not finish in time');
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    await pool.stop();
  }
}

describe('worker pool (Postgres)', () => {
  let db: DB;
  let uploadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    uploadId = await seedUpload(db, 40);
  });
  afterAll(() => db.destroy());
  beforeEach(() => resetJobs(db));

  const pool = (
    client: EnrichmentClient,
    overrides: Partial<WorkerPoolOptions> = {},
    limiter: RateLimiter = createInMemoryRateLimiter(1_000),
    breaker = new CircuitBreaker({ windowMs: 60_000, minFailures: 1_000 }),
  ) =>
    new WorkerPool(
      { db, queue: createTaskQueue(db), client, limiter, breaker, logger, random: () => 0.5 },
      { ...baseOptions, ...overrides },
    );

  it('enriches every store through transient failures without duplicates', async () => {
    const job = await createJobRepository(db).start(uploadId);
    const calls = new Map<string, number>();
    const failures: EnrichmentOutcome[] = [
      { kind: 'server_error', httpStatus: 500, message: 'boom' },
      { kind: 'rate_limited', httpStatus: 429 },
      { kind: 'timeout', timeoutMs: 10 },
      { kind: 'network_error', message: 'ECONNRESET' },
    ];
    const client: EnrichmentClient = {
      async enrich(store) {
        const n = (calls.get(store.store_id) ?? 0) + 1;
        calls.set(store.store_id, n);
        const idx = Number(store.store_id.slice(2));
        return n === 1 ? failures[idx % failures.length]! : success(idx);
      },
    };

    const finished = await runUntilDone(db, pool(client), job.id);

    expect(finished.status).toBe('COMPLETED');
    expect(await createJobRepository(db).progress(job.id)).toMatchObject({
      succeeded: 40,
      failed: 0,
    });
    expect([...calls.values()].every((n) => n === 2)).toBe(true);
    expect(await db.selectFrom('store_metrics').selectAll().execute()).toHaveLength(40);
  });

  it('fails stores that never succeed after the attempt cap, and 4xx immediately', async () => {
    const job = await createJobRepository(db).start(uploadId);
    const calls = new Map<string, number>();
    const client: EnrichmentClient = {
      async enrich(store) {
        calls.set(store.store_id, (calls.get(store.store_id) ?? 0) + 1);
        if (store.store_id === 'ST000001')
          return { kind: 'server_error', httpStatus: 500, message: 'down' };
        if (store.store_id === 'ST000002')
          return { kind: 'client_error', httpStatus: 422, message: 'bad' };
        return success(1);
      },
    };

    const finished = await runUntilDone(db, pool(client), job.id);

    expect(finished.status).toBe('COMPLETED_WITH_FAILURES');
    expect(calls.get('ST000001')).toBe(3);
    expect(calls.get('ST000002')).toBe(1);
    const { items } = await createJobRepository(db).failures(job.id, 10, 0);
    expect(items.map((f) => [f.storeId, f.lastError])).toEqual([
      ['ST000001', 'gave up after 3 attempts; last error: HTTP 500: down'],
      ['ST000002', 'not retryable: HTTP 422: bad'],
    ]);
  });

  it('recovers work from a worker that dies mid-call (lease reclaimed and retried)', async () => {
    const job = await createJobRepository(db).start(uploadId);
    let thrown = 0;
    const client: EnrichmentClient = {
      async enrich(store) {
        if (thrown < 3) {
          thrown++;
          throw new Error('worker crashed mid-call'); // task stays IN_FLIGHT, nobody records it
        }
        return success(Number(store.store_id.slice(2)));
      },
    };

    const finished = await runUntilDone(db, pool(client, { leaseMs: 200 }), job.id);

    expect(thrown).toBe(3);
    expect(finished.status).toBe('COMPLETED');
    expect(await createJobRepository(db).progress(job.id)).toMatchObject({ succeeded: 40 });
  });

  it('stops a systemically broken run with a clear terminal state', async () => {
    const job = await createJobRepository(db).start(uploadId);
    let calls = 0;
    const client: EnrichmentClient = {
      async enrich() {
        calls++;
        return { kind: 'network_error', message: 'connect ECONNREFUSED 127.0.0.1:8000' };
      },
    };
    const breaker = new CircuitBreaker({ windowMs: 150, minFailures: 5 });

    const finished = await runUntilDone(
      db,
      pool(client, { maxAttempts: 1_000 }, createInMemoryRateLimiter(1_000), breaker),
      job.id,
    );

    expect(finished.status).toBe('FAILED_SYSTEMIC');
    expect(finished.terminalReason).toContain('last error: network error: connect ECONNREFUSED');
    const progress = await createJobRepository(db).progress(job.id);
    expect(progress.succeeded).toBe(0);
    expect(progress.pending + progress.inFlight).toBe(0);
    expect(progress.aborted + progress.failed).toBe(40);
    const callsAtStop = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(callsAtStop); // nothing keeps hammering the API
  });

  it('never calls the API or claims a task while the rate limiter is down', async () => {
    const job = await createJobRepository(db).start(uploadId);
    let calls = 0;
    const p = pool(
      {
        async enrich() {
          calls++;
          return success(1);
        },
      },
      {},
      {
        acquire: () => Promise.reject(new RateLimiterUnavailableError(new Error('ECONNREFUSED'))),
        pause: () => Promise.resolve(),
      },
    );
    p.start();
    await new Promise((r) => setTimeout(r, 100));
    await p.stop();

    expect(calls).toBe(0);
    expect(await createJobRepository(db).progress(job.id)).toMatchObject({
      pending: 40,
      inFlight: 0,
    });
  });
});
