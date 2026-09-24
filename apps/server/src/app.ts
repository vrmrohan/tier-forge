import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { DB } from './db/database.js';

export interface AppDeps {
  config: Config;
  db: DB;
  redis: Redis;
}

type CheckResult = 'ok' | 'down';

async function check(probe: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await probe();
    return 'ok';
  } catch {
    return 'down';
  }
}

export function buildApp({ config, db, redis }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  // Liveness of this service and reachability of each dependency.
  app.get('/health', async (_request, reply) => {
    const [database, cache, enrichmentApi] = await Promise.all([
      check(() => sql`SELECT 1`.execute(db)),
      check(() => redis.ping()),
      check(async () => {
        const res = await fetch(`${config.SIMULATOR_URL}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
      }),
    ]);
    const healthy = database === 'ok' && cache === 'ok';
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? 'ok' : 'degraded', database, redis: cache, enrichmentApi });
  });

  return app;
}
