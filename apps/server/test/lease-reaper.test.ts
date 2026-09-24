import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/database.js';
import { reapExpiredLeases } from '../src/enrichment/lease-reaper.js';
import { createTaskQueue } from '../src/enrichment/task-queue.js';
import { createJobRepository, failRunningJobsSystemically } from '../src/jobs/job.repository.js';
import { createTestDb } from './test-db.js';
import { resetJobs, seedUpload } from './seed.js';

const MAX_ATTEMPTS = 3;
const metrics = { footfall: 1, revenue: 1, sizeSqft: 1 };

describe('lease reaper + systemic stop (Postgres)', () => {
  let db: DB;
  let uploadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    uploadId = await seedUpload(db, 3);
  });
  afterAll(() => db.destroy());
  beforeEach(() => resetJobs(db));

  const expireLease = (taskId: number) =>
    sql`UPDATE enrichment_tasks SET lease_expires_at = now() - interval '1 second'
        WHERE id = ${taskId}`.execute(db);

  it('requeues a task whose worker went silent, and rejects the lost worker later', async () => {
    await createJobRepository(db).start(uploadId);
    const queue = createTaskQueue(db);
    const lost = (await queue.claimNext(30_000))!;
    const healthy = (await queue.claimNext(30_000))!;
    await expireLease(lost.taskId);

    expect(await reapExpiredLeases(db, MAX_ATTEMPTS)).toEqual({ requeued: 1, failed: 0 });

    const row = await db
      .selectFrom('enrichment_tasks')
      .selectAll()
      .where('id', '=', lost.taskId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'PENDING',
      lease_token: null,
      attempts: 1,
      last_error: 'worker stopped responding (lease expired)',
    });
    // The healthy, unexpired lease was left alone.
    expect(
      (
        await db
          .selectFrom('enrichment_tasks')
          .select('status')
          .where('id', '=', healthy.taskId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('IN_FLIGHT');

    // Like any retry it waits behind fresh work: the untouched third task goes first.
    const fresh = (await queue.claimNext(30_000))!;
    expect(fresh.taskId).not.toBe(lost.taskId);
    // Then the reclaimed task is retried; the lost worker's late answer is discarded.
    const retry = (await queue.claimNext(30_000))!;
    expect(retry.taskId).toBe(lost.taskId);
    expect(retry.attempts).toBe(2);
    expect(await queue.recordSuccess(lost, metrics, 50_000)).toBe('stale');
    expect(await queue.recordSuccess(retry, metrics, 10)).toBe('saved');
  });

  it('fails a task whose lost attempt was its last one', async () => {
    const job = await createJobRepository(db).start(uploadId);
    const queue = createTaskQueue(db);
    const task = (await queue.claimNext(30_000))!;
    await sql`UPDATE enrichment_tasks SET attempts = ${MAX_ATTEMPTS} WHERE id = ${task.taskId}`.execute(
      db,
    );
    await expireLease(task.taskId);

    expect(await reapExpiredLeases(db, MAX_ATTEMPTS)).toEqual({ requeued: 0, failed: 1 });
    const { items } = await createJobRepository(db).failures(job.id, 10, 0);
    expect(items[0]?.lastError).toBe(
      'gave up after 3 attempts; last error: worker stopped responding (lease expired)',
    );
  });

  it('does nothing when no lease has expired', async () => {
    await createJobRepository(db).start(uploadId);
    await createTaskQueue(db).claimNext(30_000);
    expect(await reapExpiredLeases(db, MAX_ATTEMPTS)).toEqual({ requeued: 0, failed: 0 });
  });

  it('a systemic stop fails the job and aborts pending and in-flight tasks atomically', async () => {
    const jobs = createJobRepository(db);
    const job = await jobs.start(uploadId);
    const queue = createTaskQueue(db);
    const done = (await queue.claimNext(30_000))!;
    await queue.recordSuccess(done, metrics, 10);
    const inFlight = (await queue.claimNext(30_000))!;

    const ids = await failRunningJobsSystemically(db, 'API down for 30s');

    expect(ids).toEqual([job.id]);
    expect(await jobs.findById(job.id)).toMatchObject({
      status: 'FAILED_SYSTEMIC',
      terminalReason: 'API down for 30s',
    });
    expect(await jobs.progress(job.id)).toMatchObject({
      succeeded: 1,
      aborted: 2,
      pending: 0,
      inFlight: 0,
    });
    // A terminal job stays terminal: the in-flight answer is discarded.
    expect(await queue.recordSuccess(inFlight, metrics, 10)).toBe('stale');
    expect(await queue.claimNext(30_000)).toBeUndefined();
    // And a new job can now be started.
    await expect(jobs.start(uploadId)).resolves.toMatchObject({ status: 'RUNNING' });
  });
});
