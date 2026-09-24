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
