import { sql } from 'kysely';
import type { DB } from '../db/database.js';

/** Postgres channel carrying "job <id> progress changed". Payload: the job id. */
export const JOB_PROGRESS_CHANNEL = 'job_progress';

/**
 * Signals that a job's progress changed. Call it inside the same transaction as the change:
 * Postgres delivers a NOTIFY only when that transaction commits (and drops it on rollback),
 * so listeners never see progress that isn't in the database yet.
 */
export async function notifyJobProgress(
  executor: DB,
  jobIds: string | readonly string[],
): Promise<void> {
  const ids = [...new Set(typeof jobIds === 'string' ? [jobIds] : jobIds)];
  for (const id of ids) {
    await sql`SELECT pg_notify(${JOB_PROGRESS_CHANNEL}, ${id})`.execute(executor);
  }
}
