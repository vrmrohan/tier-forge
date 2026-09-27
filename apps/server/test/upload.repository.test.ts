import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/database.js';
import type { ParsedStore } from '../src/uploads/csv-parser.js';
import { createUploadRepository } from '../src/uploads/upload.repository.js';
import { createTestDb } from './test-db.js';

const store = (n: number): ParsedStore => ({
  store_id: `ST${String(n).padStart(6, '0')}`,
  store_name: `Shop ${n}`,
  address: `${n} Main St`,
  city: 'Pune',
  state: 'MH',
  country: 'India',
});

describe('upload repository (Postgres)', () => {
  let db: DB;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('saves the upload and all stores across several insert chunks', async () => {
    const repo = createUploadRepository(db);
    const stores = Array.from({ length: 2_500 }, (_, i) => store(i + 1));

    const upload = await repo.create('stores.csv', stores);

    expect(upload.rowCount).toBe(2_500);
    const { count } = await db
      .selectFrom('stores')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('upload_id', '=', upload.id)
      .executeTakeFirstOrThrow();
    expect(Number(count)).toBe(2_500);
    expect(await repo.findById(upload.id)).toEqual(upload);
  });

  it('rolls back everything if any row fails to insert', async () => {
    const repo = createUploadRepository(db);
    const before = await db.selectFrom('uploads').select('id').execute();
    // Same store_id twice violates UNIQUE (upload_id, store_id) in the second chunk.
    const stores = [...Array.from({ length: 1_200 }, (_, i) => store(i + 1)), store(1)];

    await expect(repo.create('bad.csv', stores)).rejects.toThrow();

    const after = await db.selectFrom('uploads').select('id').execute();
    expect(after).toHaveLength(before.length);
  });

  it('returns undefined for an unknown id', async () => {
    const repo = createUploadRepository(db);
    expect(await repo.findById('33333333-3333-4333-8333-333333333333')).toBeUndefined();
  });
});
