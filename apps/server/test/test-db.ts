import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
import { numericParsers, type DB } from '../src/db/database.js';
import { createMigrator } from '../src/db/migrator.js';
import type { Database } from '../src/db/schema.js';

/**
 * A real, in-process Postgres (PGlite) with all migrations applied.
 * Lets database tests run with `npm test` alone: no Docker required.
 * Uses the same NUMERIC/BIGINT parsing as the production pg driver.
 */
export async function createTestDb(): Promise<DB> {
  const db = new Kysely<Database>({
    dialect: new PGliteDialect(new PGlite({ parsers: numericParsers })),
  });
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
  return db;
}
