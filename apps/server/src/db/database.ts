import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

// node-postgres returns NUMERIC and BIGINT as strings by default, which makes
// comparisons like `revenue >= bar` silently lexicographic. Parse them once, here.
// BIGINT ids stay far below Number.MAX_SAFE_INTEGER at this scale.
const PG_NUMERIC_OID = 1700;
const PG_INT8_OID = 20;
pg.types.setTypeParser(PG_NUMERIC_OID, (value) => Number.parseFloat(value));
pg.types.setTypeParser(PG_INT8_OID, (value) => Number.parseInt(value, 10));

export type DB = Kysely<Database>;

export function createDb(connectionString: string, maxConnections = 20): DB {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: maxConnections }),
    }),
  });
}
