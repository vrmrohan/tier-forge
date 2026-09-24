import { sql } from 'kysely';
import type { DB } from '../db/database.js';

export interface ReapResult {
  /** Tasks put back in the queue for another attempt. */
  requeued: number;
  /** Tasks whose expired attempt was their last one. */
  failed: number;
}

/**
 * Returns every IN_FLIGHT task whose lease has expired to the queue.
 *
 * A lease expires when a worker stopped responding (crash, restart, hung process).
 * The lost attempt already counted when the task was claimed, so a task that was on
 * its last attempt is failed instead of retried: the loop stays bounded.
 *
 * Safe to run from several processes at once: each row is updated by at most one
 * of them, and a late answer from the lost worker is rejected by the lease-token guard.
 */
export async function reapExpiredLeases(db: DB, maxAttempts: number): Promise<ReapResult> {
  const { rows } = await sql<{ status: string }>`
    UPDATE enrichment_tasks
    SET status = CASE WHEN attempts >= ${maxAttempts} THEN 'FAILED' ELSE 'PENDING' END,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = now(),
        last_error = CASE
          WHEN attempts >= ${maxAttempts}
          THEN 'gave up after ' || attempts || ' attempts; last error: worker stopped responding (lease expired)'
          ELSE 'worker stopped responding (lease expired)'
        END,
        last_http_status = NULL,
        updated_at = now()
    WHERE status = 'IN_FLIGHT' AND lease_expires_at < now()
    RETURNING status
  `.execute(db);

  return {
    requeued: rows.filter((r) => r.status === 'PENDING').length,
    failed: rows.filter((r) => r.status === 'FAILED').length,
  };
}
