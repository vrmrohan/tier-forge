import type { DB } from '../src/db/database.js';
import type { ParsedStore } from '../src/uploads/csv-parser.js';
import { createUploadRepository } from '../src/uploads/upload.repository.js';

export const makeStore = (n: number): ParsedStore => ({
  store_id: `ST${String(n).padStart(6, '0')}`,
  store_name: `Shop ${n}`,
  address: `${n} Main St`,
  city: 'Pune',
  state: 'MH',
  country: 'India',
});

/** Creates an upload with `count` stores and returns its id. */
export async function seedUpload(db: DB, count: number): Promise<string> {
  const stores = Array.from({ length: count }, (_, i) => makeStore(i + 1));
  const upload = await createUploadRepository(db).create('seed.csv', stores);
  return upload.id;
}

/** Deletes all job data between tests so the one-active-job rule starts clean. */
export async function resetJobs(db: DB): Promise<void> {
  await db.deleteFrom('enrichment_jobs').execute();
}

/**
 * Creates a job whose stores are already enriched with the given metrics
 * (bypassing the worker), for scoring tests.
 */
export async function seedEnrichedJob(
  db: DB,
  metrics: { footfall: number; revenue: number; sizeSqft: number }[],
  status: 'RUNNING' | 'COMPLETED' = 'COMPLETED',
): Promise<string> {
  const uploadId = await seedUpload(db, metrics.length);
  const job = await db
    .insertInto('enrichment_jobs')
    .values({ upload_id: uploadId, status, total: metrics.length, started_at: new Date() })
    .returning('id')
    .executeTakeFirstOrThrow();
  const stores = await db
    .selectFrom('stores')
    .select('id')
    .where('upload_id', '=', uploadId)
    .orderBy('store_id')
    .execute();
  for (let i = 0; i < metrics.length; i += 1_000) {
    await db
      .insertInto('store_metrics')
      .values(
        metrics.slice(i, i + 1_000).map((m, j) => ({
          store_pk: stores[i + j]!.id,
          job_id: job.id,
          footfall: m.footfall,
          revenue: m.revenue,
          size_sqft: m.sizeSqft,
        })),
      )
      .execute();
  }
  return job.id;
}
