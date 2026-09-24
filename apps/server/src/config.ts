import { z } from 'zod';

/**
 * All runtime configuration, validated once at startup.
 * Defaults match docker-compose.yml and the tuning decisions in the design doc.
 */
const ConfigSchema = z.object({
  DATABASE_URL: z.string().url().default('postgres://tierforge:tierforge@localhost:5432/tierforge'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SIMULATOR_URL: z.string().url().default('http://localhost:8000'),

  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Enrichment engine
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  /** Kept below the simulator's 5 req/s because its limit is a fixed 1 s window. */
  RATE_LIMIT_PER_SECOND: z.coerce.number().positive().max(5).default(4),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  LEASE_MS: z.coerce.number().int().positive().default(30_000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
  BACKOFF_MAX_MS: z.coerce.number().int().positive().default(30_000),
  /** How long upstream failures must persist before the job is declared systemically broken. */
  BREAKER_WINDOW_MS: z.coerce.number().int().positive().default(30_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const config = parsed.data;
  if (config.REQUEST_TIMEOUT_MS >= config.LEASE_MS) {
    throw new Error(
      'REQUEST_TIMEOUT_MS must be shorter than LEASE_MS so a timed-out call is never still leased',
    );
  }
  return config;
}
