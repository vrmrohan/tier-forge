import { sql } from 'kysely';
import type { DB } from '../db/database.js';
import type { AttemptOutcome } from '../db/schema.js';
import type { StoreInput, StoreMetrics } from './types.js';

/** A task leased to one worker. Only the holder of `leaseToken` may write its result. */
export interface ClaimedTask {
  taskId: number;
  jobId: string;
  /** Includes the attempt just started. */
  attempts: number;
  leaseToken: string;
  store: StoreInput;
}

export type WriteResult = 'saved' | 'stale';

interface AttemptLog {
  outcome: AttemptOutcome;
  httpStatus: number | null;
  latencyMs: number;
  error: string | null;
}

interface ClaimRow {
  id: number;
  job_id: string;
  attempts: number;
  lease_token: string;
  store_id: string;
  store_name: string;
  address: string;
  city: string;
  state: string;
}

/**
 * The Postgres-backed work queue.
 *
 * Every write happens in a short transaction; no transaction is ever held open
 * while the API call is in progress (that would pin a DB connection for up to 10 s).
 */
export function createTaskQueue(db: DB) {
  async function logAttempt(executor: DB, task: ClaimedTask, attempt: AttemptLog): Promise<void> {
    await executor
      .insertInto('enrichment_attempts')
      .values({
        task_id: task.taskId,
        attempt_no: task.attempts,
        lease_token: task.leaseToken,
        outcome: attempt.outcome,
        http_status: attempt.httpStatus,
        latency_ms: attempt.latencyMs,
        error: attempt.error,
      })
      .execute();
  }

  return {
    /**
     * Atomically leases the next due task of a RUNNING job.
     * SKIP LOCKED lets many workers claim in parallel without blocking or double-claiming.
     */
    async claimNext(leaseMs: number): Promise<ClaimedTask | undefined> {
      const { rows } = await sql<ClaimRow>`
        WITH next AS (
          SELECT t.id
          FROM enrichment_tasks t
          JOIN enrichment_jobs j ON j.id = t.job_id AND j.status = 'RUNNING'
          WHERE t.status = 'PENDING' AND t.next_attempt_at <= now()
          ORDER BY t.next_attempt_at, t.id
          FOR UPDATE OF t SKIP LOCKED
          LIMIT 1
        ),
        claimed AS (
          UPDATE enrichment_tasks t
          SET status = 'IN_FLIGHT',
              lease_token = gen_random_uuid(),
              lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
              attempts = t.attempts + 1,
              updated_at = now()
          FROM next
          WHERE t.id = next.id
          RETURNING t.id, t.job_id, t.attempts, t.lease_token, t.store_pk
        )
        SELECT c.id, c.job_id, c.attempts, c.lease_token,
               s.store_id, s.store_name, s.address, s.city, s.state
        FROM claimed c
        JOIN stores s ON s.id = c.store_pk
      `.execute(db);

      const row = rows[0];
      if (!row) return undefined;
      return {
        taskId: Number(row.id),
        jobId: row.job_id,
        attempts: row.attempts,
        leaseToken: row.lease_token,
        store: {
          store_id: row.store_id,
          store_name: row.store_name,
          address: row.address,
          city: row.city,
          state: row.state,
        },
      };
    },

    /**
     * Saves metrics and marks the task SUCCEEDED in one transaction, but only if this
     * worker still holds the lease. A late answer from a reclaimed attempt returns
     * 'stale' and changes nothing except the audit log.
     */
    async recordSuccess(
      task: ClaimedTask,
      metrics: StoreMetrics,
      latencyMs: number,
    ): Promise<WriteResult> {
      return db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('enrichment_tasks')
          .set({
            status: 'SUCCEEDED',
            lease_token: null,
            lease_expires_at: null,
            last_error: null,
            last_http_status: 200,
            updated_at: sql`now()`,
          })
          .where('id', '=', task.taskId)
          .where('lease_token', '=', task.leaseToken)
          .where('status', '=', 'IN_FLIGHT')
          .returning('store_pk')
          .executeTakeFirst();

        if (!updated) {
          await logAttempt(trx, task, {
            outcome: 'STALE_IGNORED',
            httpStatus: 200,
            latencyMs,
            error: 'success arrived after the lease was reclaimed; discarded',
          });
          return 'stale';
        }

        // DO NOTHING: results are deterministic per store, so an existing row is already correct.
        await trx
          .insertInto('store_metrics')
          .values({
            store_pk: updated.store_pk,
            job_id: task.jobId,
            footfall: metrics.footfall,
            revenue: metrics.revenue,
            size_sqft: metrics.sizeSqft,
          })
          .onConflict((oc) => oc.column('store_pk').doNothing())
          .execute();

        await logAttempt(trx, task, {
          outcome: 'SUCCEEDED',
          httpStatus: 200,
          latencyMs,
          error: null,
        });
        await trx
          .updateTable('enrichment_jobs')
          .set({ last_progress_at: sql`now()` })
          .where('id', '=', task.jobId)
          .execute();
        return 'saved';
      });
    },

    /**
     * Records a failed attempt: either schedules a retry (back to PENDING after `retryInMs`)
     * or fails the task for good. Same lease guard as recordSuccess.
     */
    async recordFailure(
      task: ClaimedTask,
      attempt: AttemptLog & { error: string },
      decision: { action: 'retry'; delayMs: number } | { action: 'fail'; reason: string },
    ): Promise<WriteResult> {
      return db.transaction().execute(async (trx) => {
        const base = trx
          .updateTable('enrichment_tasks')
          .where('id', '=', task.taskId)
          .where('lease_token', '=', task.leaseToken)
          .where('status', '=', 'IN_FLIGHT');

        const updated =
          decision.action === 'retry'
            ? await base
                .set({
                  status: 'PENDING',
                  lease_token: null,
                  lease_expires_at: null,
                  next_attempt_at: sql`now() + make_interval(secs => ${decision.delayMs / 1000})`,
                  last_error: attempt.error,
                  last_http_status: attempt.httpStatus,
                  updated_at: sql`now()`,
                })
                .returning('id')
                .executeTakeFirst()
            : await base
                .set({
                  status: 'FAILED',
                  lease_token: null,
                  lease_expires_at: null,
                  last_error: decision.reason,
                  last_http_status: attempt.httpStatus,
                  updated_at: sql`now()`,
                })
                .returning('id')
                .executeTakeFirst();

        if (!updated) {
          await logAttempt(trx, task, {
            ...attempt,
            outcome: 'STALE_IGNORED',
            error: `late failure after the lease was reclaimed: ${attempt.error}`,
          });
          return 'stale';
        }

        await logAttempt(trx, task, attempt);
        if (decision.action === 'fail') {
          await trx
            .updateTable('enrichment_jobs')
            .set({ last_progress_at: sql`now()` })
            .where('id', '=', task.jobId)
            .execute();
        }
        return 'saved';
      });
    },
  };
}

export type TaskQueue = ReturnType<typeof createTaskQueue>;
