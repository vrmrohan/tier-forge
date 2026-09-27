import { sql, type Kysely, type RawBuilder } from 'kysely';
import { ATTEMPT_OUTCOMES, JOB_STATUSES, TASK_STATUSES, TIERS } from '../schema.js';

/** Renders `('A', 'B', 'C')` from a const list so CHECK constraints can't drift from the TS types. */
function inList(values: readonly string[]): RawBuilder<unknown> {
  return sql`(${sql.join(values.map((v) => sql.lit(v)))})`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // --- Input ---------------------------------------------------------------
  await sql`
    CREATE TABLE uploads (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      filename    text NOT NULL,
      row_count   integer NOT NULL CHECK (row_count >= 0),
      created_at  timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  await sql`
    CREATE TABLE stores (
      id          bigserial PRIMARY KEY,
      upload_id   uuid NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      store_id    text NOT NULL,
      store_name  text NOT NULL,
      address     text NOT NULL,
      city        text NOT NULL,
      state       text NOT NULL,
      country     text NOT NULL,
      UNIQUE (upload_id, store_id)
    )`.execute(db);

  // --- Enrichment (slow, unreliable side) ------------------------------------
  // Progress is derived by counting tasks, so there are deliberately no counter columns here.
  await sql`
    CREATE TABLE enrichment_jobs (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      upload_id         uuid NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      status            text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ${inList(JOB_STATUSES)}),
      total             integer NOT NULL CHECK (total >= 0),
      created_at        timestamptz NOT NULL DEFAULT now(),
      started_at        timestamptz,
      last_progress_at  timestamptz,
      finished_at       timestamptz,
      terminal_reason   text
    )`.execute(db);

  // Core scope: one active job at a time. A second start attempt violates this and becomes a 409.
  await sql`
    CREATE UNIQUE INDEX enrichment_jobs_one_active
      ON enrichment_jobs ((true))
      WHERE status IN ('QUEUED', 'RUNNING')`.execute(db);

  await sql`
    CREATE TABLE enrichment_tasks (
      id                bigserial PRIMARY KEY,
      job_id            uuid NOT NULL REFERENCES enrichment_jobs(id) ON DELETE CASCADE,
      store_pk          bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ${inList(TASK_STATUSES)}),
      attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at   timestamptz NOT NULL DEFAULT now(),
      lease_token       uuid,
      lease_expires_at  timestamptz,
      last_error        text,
      last_http_status  integer,
      updated_at        timestamptz NOT NULL DEFAULT now(),
      UNIQUE (job_id, store_pk),
      -- A task is leased if and only if it is IN_FLIGHT.
      CONSTRAINT lease_matches_status CHECK (
        (status = 'IN_FLIGHT') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      )
    )`.execute(db);

  // Claim query: next due PENDING task for a job.
  await sql`
    CREATE INDEX enrichment_tasks_claimable
      ON enrichment_tasks (job_id, next_attempt_at)
      WHERE status = 'PENDING'`.execute(db);

  // Reaper query: expired leases.
  await sql`
    CREATE INDEX enrichment_tasks_leases
      ON enrichment_tasks (lease_expires_at)
      WHERE status = 'IN_FLIGHT'`.execute(db);

  // Progress query: COUNT(*) GROUP BY status.
  await sql`CREATE INDEX enrichment_tasks_job_status ON enrichment_tasks (job_id, status)`.execute(
    db,
  );

  // Append-only audit trail: one row per HTTP attempt, including stale late responses.
  await sql`
    CREATE TABLE enrichment_attempts (
      id           bigserial PRIMARY KEY,
      task_id      bigint NOT NULL REFERENCES enrichment_tasks(id) ON DELETE CASCADE,
      attempt_no   integer NOT NULL CHECK (attempt_no >= 1),
      lease_token  uuid NOT NULL,
      outcome      text NOT NULL CHECK (outcome IN ${inList(ATTEMPT_OUTCOMES)}),
      http_status  integer,
      latency_ms   integer NOT NULL CHECK (latency_ms >= 0),
      error        text,
      created_at   timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX enrichment_attempts_task ON enrichment_attempts (task_id)`.execute(db);

  // Raw enrichment results: written once per store, never touched by scoring.
  await sql`
    CREATE TABLE store_metrics (
      store_pk    bigint PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
      job_id      uuid NOT NULL REFERENCES enrichment_jobs(id) ON DELETE CASCADE,
      footfall    integer NOT NULL CHECK (footfall >= 0),
      revenue     numeric(14, 2) NOT NULL CHECK (revenue >= 0),
      size_sqft   integer NOT NULL CHECK (size_sqft >= 0),
      fetched_at  timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX store_metrics_job ON store_metrics (job_id)`.execute(db);

  // --- Scoring (fast, deterministic side) ------------------------------------
  // Configs are immutable; each scoring run inserts a new one. Whole-number weights avoid 99.99 sums.
  await sql`
    CREATE TABLE scoring_configs (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id           uuid NOT NULL REFERENCES enrichment_jobs(id) ON DELETE CASCADE,
      footfall_bar     integer NOT NULL CHECK (footfall_bar >= 0),
      revenue_bar      numeric(14, 2) NOT NULL CHECK (revenue_bar >= 0),
      size_bar         integer NOT NULL CHECK (size_bar >= 0),
      footfall_weight  smallint NOT NULL CHECK (footfall_weight BETWEEN 0 AND 100),
      revenue_weight   smallint NOT NULL CHECK (revenue_weight BETWEEN 0 AND 100),
      size_weight      smallint NOT NULL CHECK (size_weight BETWEEN 0 AND 100),
      large_cutoff     smallint NOT NULL,
      medium_cutoff    smallint NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT weights_sum_to_100 CHECK (footfall_weight + revenue_weight + size_weight = 100),
      CONSTRAINT cutoffs_ordered CHECK (0 <= medium_cutoff AND medium_cutoff < large_cutoff AND large_cutoff <= 100)
    )`.execute(db);
  await sql`CREATE INDEX scoring_configs_job ON scoring_configs (job_id, created_at DESC)`.execute(
    db,
  );

  await sql`
    CREATE TABLE store_scores (
      scoring_config_id  uuid NOT NULL REFERENCES scoring_configs(id) ON DELETE CASCADE,
      store_pk           bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      score              smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
      tier               text NOT NULL CHECK (tier IN ${inList(TIERS)}),
      PRIMARY KEY (scoring_config_id, store_pk)
    )`.execute(db);
  await sql`CREATE INDEX store_scores_tier ON store_scores (scoring_config_id, tier)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'store_scores',
    'scoring_configs',
    'store_metrics',
    'enrichment_attempts',
    'enrichment_tasks',
    'enrichment_jobs',
    'stores',
    'uploads',
  ]) {
    await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
  }
}
