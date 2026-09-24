import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/database.js';
import { createRedis } from './redis.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const app = buildApp({ config, db, redis });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await Promise.allSettled([db.destroy(), redis.quit()]);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
