import { sql } from 'kysely';
import type { DB } from '../db/database.js';
import type { EnrichmentJob, JobStatus, TaskStatus } from '../db/schema.js';
import { AppError, notFound } from '../http/errors.js';

export interface JobProgress {
  total: number;
  pending: number;
  inFlight: number;
  succeeded: number;
  failed: number;
  aborted: number;
}

export interface JobView {
  id: string;
  uploadId: string;
  status: JobStatus;
  total: number;
  createdAt: Date;
  startedAt: Date | null;
  lastProgressAt: Date | null;
  finishedAt: Date | null;
  terminalReason: string | null;
}

export interface FailedStore {
  storeId: string;
  storeName: string;
  status: TaskStatus;
  attempts: number;
  lastError: string | null;
  lastHttpStatus: number | null;
  updatedAt: Date;
}

const toView = (job: EnrichmentJob): JobView => ({
  id: job.id,
  uploadId: job.upload_id,
  status: job.status,
  total: job.total,
  createdAt: job.created_at,
  startedAt: job.started_at,
  lastProgressAt: job.last_progress_at,
  finishedAt: job.finished_at,
  terminalReason: job.terminal_reason,
});

function isActiveJobConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === '23505' && error.message.includes('enrichment_jobs_one_active');
}

export function createJobRepository(db: DB) {
  return {
    /**
     * Creates a RUNNING job with one PENDING task per store of the upload, atomically.
     * Only one active job may exist (enforced by a partial unique index) → 409 otherwise.
     */
    async start(uploadId: string): Promise<JobView> {
      const upload = await db
        .selectFrom('uploads')
        .select('id')
        .where('id', '=', uploadId)
        .executeTakeFirst();
      if (!upload) throw notFound(`Upload ${uploadId} not found`);

      try {
        return await db.transaction().execute(async (trx) => {
          const job = await trx
            .insertInto('enrichment_jobs')
            .values({ upload_id: uploadId, status: 'RUNNING', total: 0, started_at: new Date() })
            .returningAll()
            .executeTakeFirstOrThrow();

          const inserted = await trx
            .insertInto('enrichment_tasks')
            .columns(['job_id', 'store_pk'])
            .expression((eb) =>
              eb
                .selectFrom('stores')
                .select([eb.val(job.id).as('job_id'), 'stores.id'])
                .where('stores.upload_id', '=', uploadId),
            )
            .executeTakeFirstOrThrow();

          const withTotal = await trx
            .updateTable('enrichment_jobs')
            .set({ total: Number(inserted.numInsertedOrUpdatedRows ?? 0) })
            .where('id', '=', job.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          return toView(withTotal);
        });
      } catch (error) {
        if (isActiveJobConflict(error)) {
          throw new AppError(409, 'JOB_ALREADY_RUNNING', 'Another enrichment job is still running');
        }
        throw error;
      }
    },

    async findById(id: string): Promise<JobView | undefined> {
      const job = await db
        .selectFrom('enrichment_jobs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return job && toView(job);
    },

    async list(limit = 20): Promise<JobView[]> {
      const jobs = await db
        .selectFrom('enrichment_jobs')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute();
      return jobs.map(toView);
    },

    /** Counted from task rows every time, so it can never drift from reality. */
    async progress(jobId: string): Promise<JobProgress> {
      const rows = await db
        .selectFrom('enrichment_tasks')
        .select(['status', (eb) => eb.fn.countAll<number>().as('count')])
        .where('job_id', '=', jobId)
        .groupBy('status')
        .execute();
      const by = (status: TaskStatus): number =>
        Number(rows.find((r) => r.status === status)?.count ?? 0);
      const progress = {
        pending: by('PENDING'),
        inFlight: by('IN_FLIGHT'),
        succeeded: by('SUCCEEDED'),
        failed: by('FAILED'),
        aborted: by('ABORTED'),
      };
      const total = Object.values(progress).reduce((a, b) => a + b, 0);
      return { total, ...progress };
    },

    async failures(
      jobId: string,
      limit: number,
      offset: number,
    ): Promise<{ total: number; items: FailedStore[] }> {
      const base = db
        .selectFrom('enrichment_tasks as t')
        .innerJoin('stores as s', 's.id', 't.store_pk')
        .where('t.job_id', '=', jobId)
        .where('t.status', 'in', ['FAILED', 'ABORTED']);

      const [{ count }, rows] = await Promise.all([
        base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
        base
          .select([
            's.store_id',
            's.store_name',
            't.status',
            't.attempts',
            't.last_error',
            't.last_http_status',
            't.updated_at',
          ])
          .orderBy('s.store_id')
          .limit(limit)
          .offset(offset)
          .execute(),
      ]);

      return {
        total: Number(count),
        items: rows.map((r) => ({
          storeId: r.store_id,
          storeName: r.store_name,
          status: r.status,
          attempts: r.attempts,
          lastError: r.last_error,
          lastHttpStatus: r.last_http_status,
          updatedAt: r.updated_at,
        })),
      };
    },
  };
}

export type JobRepository = ReturnType<typeof createJobRepository>;

/**
 * Closes every RUNNING job that has no PENDING or IN_FLIGHT task left.
 * Must run *after* the task update commits: two workers finishing the last two tasks
 * in parallel can't see each other's uncommitted rows. The WHERE status = 'RUNNING'
 * guard makes concurrent calls safe; only one of them changes the row.
 */
export async function finalizeFinishedJobs(db: DB): Promise<number> {
  const result = await sql`
    UPDATE enrichment_jobs j
    SET status = CASE
          WHEN EXISTS (SELECT 1 FROM enrichment_tasks t
                       WHERE t.job_id = j.id AND t.status IN ('FAILED', 'ABORTED'))
          THEN 'COMPLETED_WITH_FAILURES'
          ELSE 'COMPLETED'
        END,
        finished_at = now()
    WHERE j.status = 'RUNNING'
      AND NOT EXISTS (SELECT 1 FROM enrichment_tasks t
                      WHERE t.job_id = j.id AND t.status IN ('PENDING', 'IN_FLIGHT'))
  `.execute(db);
  return Number(result.numAffectedRows ?? 0);
}
