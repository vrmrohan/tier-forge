import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/database.js';
import { createTaskQueue } from '../src/enrichment/task-queue.js';
import { createJobRepository, finalizeFinishedJobs } from '../src/jobs/job.repository.js';
import { AppError } from '../src/http/errors.js';
import { createTestDb } from './test-db.js';
import { resetJobs, seedUpload } from './seed.js';

const LEASE_MS = 30_000;
const metrics = { footfall: 100, revenue: 1234.56, sizeSqft: 900 };
const attempt = (error: string) => ({
  outcome: 'SERVER_ERROR' as const,
  httpStatus: 500,
  latencyMs: 12,
  error,
});

describe('job repository + task queue (Postgres)', () => {
  let db: DB;
  let uploadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    uploadId = await seedUpload(db, 3);
  });
  afterAll(() => db.destroy());
  beforeEach(() => resetJobs(db));

  const jobs = () => createJobRepository(db);
  const queue = () => createTaskQueue(db);

  it('starts a RUNNING job with one PENDING task per store', async () => {
    const job = await jobs().start(uploadId);
    expect(job).toMatchObject({ status: 'RUNNING', total: 3 });
    expect(await jobs().progress(job.id)).toEqual({
      total: 3,
      pending: 3,
      inFlight: 0,
      succeeded: 0,
      failed: 0,
      aborted: 0,
    });
  });

  it('refuses a second job while one is active (409)', async () => {
    await jobs().start(uploadId);
    const error = await jobs()
      .start(uploadId)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 409, code: 'JOB_ALREADY_RUNNING' });
  });

  it('404s for an unknown upload', async () => {
    await expect(jobs().start('44444444-4444-4444-8444-444444444444')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('claims each task exactly once, leased and with its store', async () => {
    await jobs().start(uploadId);
    const claimed = await Promise.all([1, 2, 3, 4].map(() => queue().claimNext(LEASE_MS)));
    const tasks = claimed.filter((t) => t !== undefined);

    expect(tasks).toHaveLength(3);
    expect(new Set(tasks.map((t) => t.taskId)).size).toBe(3);
    expect(tasks.every((t) => t.attempts === 1 && t.leaseToken.length === 36)).toBe(true);
    expect(tasks.map((t) => t.store.store_id).sort()).toEqual(['ST000001', 'ST000002', 'ST000003']);
  });

  it('saves metrics and completes the job once every task succeeded', async () => {
    const job = await jobs().start(uploadId);
    for (let i = 0; i < 3; i++) {
      const task = (await queue().claimNext(LEASE_MS))!;
      expect(await queue().recordSuccess(task, metrics, 10)).toBe('saved');
    }
    expect(await finalizeFinishedJobs(db)).toBe(1);
    expect(await finalizeFinishedJobs(db)).toBe(0); // idempotent

    const done = await jobs().findById(job.id);
    expect(done).toMatchObject({ status: 'COMPLETED' });
    expect(done?.finishedAt).toBeInstanceOf(Date);
    const saved = await db.selectFrom('store_metrics').selectAll().execute();
    expect(saved).toHaveLength(3);
    expect(saved[0]?.revenue).toBe(1234.56); // a number, not the string "1234.56"
  });

  it('ignores a late result whose lease was reclaimed', async () => {
    await jobs().start(uploadId);
    const original = (await queue().claimNext(LEASE_MS))!;

    // Simulate the lease expiring and the task being reclaimed by another worker.
    await sql`UPDATE enrichment_tasks SET status = 'PENDING', lease_token = NULL,
              lease_expires_at = NULL WHERE id = ${original.taskId}`.execute(db);
    const retry = (await queue().claimNext(LEASE_MS))!;
    expect(retry.taskId).toBe(original.taskId);
    expect(retry.attempts).toBe(2);

    // The original call finally answers: it must not overwrite anything.
    expect(await queue().recordSuccess(original, metrics, 50_000)).toBe('stale');
    expect(
      await queue().recordFailure(original, attempt('late 500'), { action: 'fail', reason: 'x' }),
    ).toBe('stale');
    // The current holder still can.
    expect(await queue().recordSuccess(retry, metrics, 10)).toBe('saved');

    const outcomes = await db
      .selectFrom('enrichment_attempts')
      .select(['attempt_no', 'outcome'])
      .where('task_id', '=', original.taskId)
      .orderBy('id')
      .execute();
    expect(outcomes).toEqual([
      { attempt_no: 1, outcome: 'STALE_IGNORED' },
      { attempt_no: 1, outcome: 'STALE_IGNORED' },
      { attempt_no: 2, outcome: 'SUCCEEDED' },
    ]);
    expect(await db.selectFrom('store_metrics').selectAll().execute()).toHaveLength(1);
  });

  it('schedules a retry in the future and does not hand the task out early', async () => {
    const job = await jobs().start(uploadId);
    const task = (await queue().claimNext(LEASE_MS))!;
    await queue().recordFailure(task, attempt('HTTP 500: boom'), {
      action: 'retry',
      delayMs: 60_000,
    });

    const row = await db
      .selectFrom('enrichment_tasks')
      .selectAll()
      .where('id', '=', task.taskId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'PENDING',
      lease_token: null,
      last_error: 'HTTP 500: boom',
    });

    const others = [await queue().claimNext(LEASE_MS), await queue().claimNext(LEASE_MS)];
    expect(others.map((t) => t?.taskId)).not.toContain(task.taskId);
    expect(await queue().claimNext(LEASE_MS)).toBeUndefined();
    expect((await jobs().progress(job.id)).pending).toBe(1);
  });

  it('fails a task for good and closes the job as COMPLETED_WITH_FAILURES', async () => {
    const job = await jobs().start(uploadId);
    const first = (await queue().claimNext(LEASE_MS))!;
    await queue().recordFailure(first, attempt('HTTP 500: boom'), {
      action: 'fail',
      reason: 'gave up after 5 attempts; last error: HTTP 500: boom',
    });
    for (let i = 0; i < 2; i++) {
      await queue().recordSuccess((await queue().claimNext(LEASE_MS))!, metrics, 10);
    }
    await finalizeFinishedJobs(db);

    expect(await jobs().findById(job.id)).toMatchObject({ status: 'COMPLETED_WITH_FAILURES' });
    const failures = await jobs().failures(job.id, 10, 0);
    expect(failures.total).toBe(1);
    expect(failures.items[0]).toMatchObject({
      storeId: first.store.store_id,
      status: 'FAILED',
      attempts: 1,
      lastError: 'gave up after 5 attempts; last error: HTTP 500: boom',
      lastHttpStatus: 500,
    });
  });

  it('only hands out tasks of RUNNING jobs', async () => {
    const job = await jobs().start(uploadId);
    await db
      .updateTable('enrichment_jobs')
      .set({ status: 'FAILED_SYSTEMIC' })
      .where('id', '=', job.id)
      .execute();
    expect(await queue().claimNext(LEASE_MS)).toBeUndefined();
  });
});
