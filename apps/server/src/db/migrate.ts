import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { loadConfig } from '../config.js';
import { createDb } from './database.js';

/** Usage: `npm run db:migrate` (latest) or `npm run db:migrate:down` (undo the last migration). */
async function main(): Promise<void> {
  const direction = process.argv[2] === 'down' ? 'down' : 'latest';
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL, 1);

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    }),
  });

  const { error, results } =
    direction === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest();

  for (const result of results ?? []) {
    const verb = result.direction === 'Up' ? 'applied' : 'reverted';
    const line = `${result.status === 'Success' ? verb : 'FAILED'}: ${result.migrationName}`;
    process.stdout.write(`${line}\n`);
  }
  if (results?.length === 0) process.stdout.write('database already up to date\n');

  await db.destroy();
  if (error) {
    process.stderr.write(`migration failed: ${String(error)}\n`);
    process.exit(1);
  }
}

void main();
