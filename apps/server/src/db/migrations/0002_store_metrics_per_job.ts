import { sql, type Kysely } from 'kysely';

/**
 * Metrics are keyed per job, not just per store.
 *
 * With `store_pk` alone as the key, a second job over the same upload could not save its
 * results (the insert's ON CONFLICT DO NOTHING kept the first job's row), so the second job
 * showed every store as enriched but had nothing to score. Each job now owns its own rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE store_metrics DROP CONSTRAINT store_metrics_pkey`.execute(db);
  await sql`ALTER TABLE store_metrics ADD PRIMARY KEY (job_id, store_pk)`.execute(db);
  // The new primary key leads with job_id, so it replaces the old job_id index.
  await sql`DROP INDEX store_metrics_job`.execute(db);
  // Keeps ON DELETE CASCADE from stores cheap now that store_pk is no longer the key.
  await sql`CREATE INDEX store_metrics_store ON store_metrics (store_pk)`.execute(db);
}

/** Restores one row per store, keeping each store's most recent metrics. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM store_metrics m
    USING store_metrics newer
    WHERE newer.store_pk = m.store_pk
      AND (newer.fetched_at, newer.job_id) > (m.fetched_at, m.job_id)`.execute(db);
  await sql`DROP INDEX store_metrics_store`.execute(db);
  await sql`ALTER TABLE store_metrics DROP CONSTRAINT store_metrics_pkey`.execute(db);
  await sql`ALTER TABLE store_metrics ADD PRIMARY KEY (store_pk)`.execute(db);
  await sql`CREATE INDEX store_metrics_job ON store_metrics (job_id)`.execute(db);
}
