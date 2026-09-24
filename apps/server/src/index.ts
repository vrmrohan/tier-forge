import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/database.js';
import { createHttpEnrichmentClient } from './enrichment/enrichment-client.js';
import { createRedisRateLimiter } from './enrichment/rate-limiter.js';
import { createTaskQueue } from './enrichment/task-queue.js';
import { WorkerPool } from './enrichment/worker-pool.js';
import { createJobRepository } from './jobs/job.repository.js';
import { createRedis, waitForRedis } from './redis.js';
import { createUploadRepository } from './uploads/upload.repository.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const app = buildApp({
    config,
    db,
    redis,
    uploads: createUploadRepository(db),
    jobs: createJobRepository(db),
  });

  const workers = config.RUN_WORKERS
    ? new WorkerPool(
        {
          db,
          queue: createTaskQueue(db),
          client: createHttpEnrichmentClient({
            baseUrl: config.SIMULATOR_URL,
            timeoutMs: config.REQUEST_TIMEOUT_MS,
          }),
          limiter: createRedisRateLimiter(redis, config.RATE_LIMIT_PER_SECOND),
          logger: app.log,
        },
        {
          concurrency: config.WORKER_CONCURRENCY,
          leaseMs: config.LEASE_MS,
          idlePollMs: config.WORKER_IDLE_POLL_MS,
          rateLimitPauseMs: config.RATE_LIMIT_PAUSE_MS,
          errorBackoffMs: 2_000,
          maxAttempts: config.MAX_ATTEMPTS,
          baseDelayMs: config.BACKOFF_BASE_MS,
          maxDelayMs: config.BACKOFF_MAX_MS,
        },
      )
    : undefined;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await workers?.stop();
    await Promise.allSettled([db.destroy(), redis.quit()]);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  if (workers) {
    // Start workers once Redis is connected, so the first rate-limit calls don't race the connection.
    // If it isn't up in time, start anyway: workers wait (fail closed) and resume when Redis returns.
    await waitForRedis(redis, 10_000).catch((error: unknown) =>
      app.log.warn({ err: error }, 'Redis not ready; workers will wait for it'),
    );
    workers.start();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
