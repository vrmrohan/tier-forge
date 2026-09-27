import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_initial.js';
import * as m0002 from './0002_store_metrics_per_job.js';

/**
 * All migrations, in order. Registered statically (instead of scanning the folder)
 * so they load the same way under tsx, compiled JS and the test runner.
 * Add new migrations here with a sortable name.
 */
export const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_store_metrics_per_job': m0002,
};
