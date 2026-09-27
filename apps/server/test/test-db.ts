import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
import { numericParsers, type DB } from '../src/db/database.js';
import { createMigrator } from '../src/db/migrator.js';
import type { Database } from '../src/db/schema.js';
import type { NotificationSource } from '../src/events/job-event-hub.js';
import { JOB_PROGRESS_CHANNEL } from '../src/events/job-notify.js';

/**
 * A real, in-process Postgres (PGlite) with all migrations applied.
 * Lets database tests run with `npm test` alone: no Docker required.
 * Uses the same NUMERIC/BIGINT parsing as the production pg driver.
 */
export async function createTestDb(): Promise<DB> {
  return (await createTestDatabase()).db;
}

/** Same, plus the PGlite handle (for LISTEN/NOTIFY tests). */
export async function createTestDatabase(): Promise<{ db: DB; pglite: PGlite }> {
  const pglite = new PGlite({ parsers: numericParsers });
  const db = new Kysely<Database>({ dialect: new PGliteDialect(pglite) });
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
  return { db, pglite };
}

/** A NotificationSource backed by PGlite's LISTEN, mirroring the production pg source. */
export function pgliteNotificationSource(pglite: PGlite): NotificationSource {
  return {
    async listen(onJobId) {
      const unlisten = await pglite.listen(JOB_PROGRESS_CHANNEL, (payload) => onJobId(payload));
      return () => unlisten();
    },
  };
}

/** For tests that don't exercise live events. */
export const noNotifications: NotificationSource = {
  listen: () => Promise.resolve(() => Promise.resolve()),
};
