import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Kysely table types. Must stay in sync with migrations/ (the migration is the source of truth).
 * Status values are exported as const arrays so the same list backs both types and CHECK constraints.
 */

export const JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_FAILURES',
  'FAILED_SYSTEMIC',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TASK_STATUSES = ['PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'ABORTED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ATTEMPT_OUTCOMES = [
  'SUCCEEDED',
  'RATE_LIMITED', // 429
  'SERVER_ERROR', // 5xx
  'TIMEOUT', // our client-side timeout fired
  'NETWORK_ERROR', // connection refused/reset, DNS, etc.
  'CLIENT_ERROR', // 4xx other than 429: permanent, never retried
  'STALE_IGNORED', // response arrived after the lease was reclaimed; discarded
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

// Tiers come from the shared scoring rules so the DB, API and web app use one list.
import { TIERS, type Tier } from '@tierforge/shared';
export { TIERS, type Tier };

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export interface UploadsTable {
  id: Generated<string>;
  filename: string;
  row_count: number;
  created_at: Generated<Date>;
}

export interface StoresTable {
  id: Generated<number>;
  upload_id: string;
  store_id: string;
  store_name: string;
  address: string;
  city: string;
  state: string;
  country: string;
}

export interface EnrichmentJobsTable {
  id: Generated<string>;
  upload_id: string;
  status: ColumnType<JobStatus, JobStatus | undefined, JobStatus>;
  total: number;
  created_at: Generated<Date>;
  started_at: NullableTimestamp;
  last_progress_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  terminal_reason: string | null;
}

export interface EnrichmentTasksTable {
  id: Generated<number>;
  job_id: string;
  store_pk: number;
  status: ColumnType<TaskStatus, TaskStatus | undefined, TaskStatus>;
  attempts: Generated<number>;
  next_attempt_at: Timestamp;
  lease_token: string | null;
  lease_expires_at: NullableTimestamp;
  last_error: string | null;
  last_http_status: number | null;
  updated_at: Timestamp;
}

export interface EnrichmentAttemptsTable {
  id: Generated<number>;
  task_id: number;
  attempt_no: number;
  lease_token: string;
  outcome: AttemptOutcome;
  http_status: number | null;
  latency_ms: number;
  error: string | null;
  created_at: Generated<Date>;
}

export interface StoreMetricsTable {
  store_pk: number;
  job_id: string;
  footfall: number;
  revenue: number;
  size_sqft: number;
  fetched_at: Generated<Date>;
}

export interface ScoringConfigsTable {
  id: Generated<string>;
  job_id: string;
  footfall_bar: number;
  revenue_bar: number;
  size_bar: number;
  footfall_weight: number;
  revenue_weight: number;
  size_weight: number;
  large_cutoff: number;
  medium_cutoff: number;
  created_at: Generated<Date>;
}

export interface StoreScoresTable {
  scoring_config_id: string;
  store_pk: number;
  score: number;
  tier: Tier;
}

export interface Database {
  uploads: UploadsTable;
  stores: StoresTable;
  enrichment_jobs: EnrichmentJobsTable;
  enrichment_tasks: EnrichmentTasksTable;
  enrichment_attempts: EnrichmentAttemptsTable;
  store_metrics: StoreMetricsTable;
  scoring_configs: ScoringConfigsTable;
  store_scores: StoreScoresTable;
}

export type Store = Selectable<StoresTable>;
export type NewStore = Insertable<StoresTable>;
export type EnrichmentJob = Selectable<EnrichmentJobsTable>;
export type EnrichmentTask = Selectable<EnrichmentTasksTable>;
export type EnrichmentTaskUpdate = Updateable<EnrichmentTasksTable>;
export type ScoringConfig = Selectable<ScoringConfigsTable>;
