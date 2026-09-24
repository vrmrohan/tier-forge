import { Migrator } from 'kysely/migration';
import type { DB } from './database.js';
import { migrations } from './migrations/index.js';

export function createMigrator(db: DB): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
}
