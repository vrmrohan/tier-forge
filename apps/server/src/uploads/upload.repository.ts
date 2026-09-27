import type { DB } from '../db/database.js';
import type { ParsedStore } from './csv-parser.js';

export interface UploadSummary {
  id: string;
  filename: string;
  rowCount: number;
  createdAt: Date;
}

/** Persistence port for uploads, so routes can be tested without a database. */
export interface UploadRepository {
  create(filename: string, stores: readonly ParsedStore[]): Promise<UploadSummary>;
  findById(id: string): Promise<UploadSummary | undefined>;
}

// 7 bound parameters per row; stays well under Postgres' 65,535 parameter limit.
const INSERT_CHUNK_SIZE = 1_000;

export function createUploadRepository(db: DB): UploadRepository {
  return {
    async create(filename, stores) {
      // One transaction: either the upload and all its stores exist, or nothing does.
      return db.transaction().execute(async (trx) => {
        const upload = await trx
          .insertInto('uploads')
          .values({ filename, row_count: stores.length })
          .returning(['id', 'filename', 'row_count', 'created_at'])
          .executeTakeFirstOrThrow();

        for (let i = 0; i < stores.length; i += INSERT_CHUNK_SIZE) {
          const chunk = stores.slice(i, i + INSERT_CHUNK_SIZE);
          await trx
            .insertInto('stores')
            .values(chunk.map((s) => ({ upload_id: upload.id, ...s })))
            .execute();
        }

        return {
          id: upload.id,
          filename: upload.filename,
          rowCount: upload.row_count,
          createdAt: upload.created_at,
        };
      });
    },

    async findById(id) {
      const row = await db
        .selectFrom('uploads')
        .select(['id', 'filename', 'row_count', 'created_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      return (
        row && {
          id: row.id,
          filename: row.filename,
          rowCount: row.row_count,
          createdAt: row.created_at,
        }
      );
    },
  };
}
