import { DEFAULT_SCORING_CONFIG } from '@tierforge/shared';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { DB } from '../src/db/database.js';
import { createJobRepository } from '../src/jobs/job.repository.js';
import { createScoringRepository } from '../src/scoring/scoring.repository.js';
import { createUploadRepository } from '../src/uploads/upload.repository.js';
import { createTestDb } from './test-db.js';
import { resetJobs, seedEnrichedJob } from './seed.js';

const metrics = [
  { footfall: 40_000, revenue: 400_000, sizeSqft: 18_000 },
  { footfall: 20_000, revenue: 100_000, sizeSqft: 5_000 },
  { footfall: 2_000, revenue: 20_000, sizeSqft: 9_000 },
];

describe('scoring routes', () => {
  let db: DB;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildApp({
      config: loadConfig({ LOG_LEVEL: 'fatal' }),
      db,
      redis: {} as Redis,
      uploads: createUploadRepository(db),
      jobs: createJobRepository(db),
      scoring: createScoringRepository(db),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });
  beforeEach(() => resetJobs(db));

  const score = (jobId: string, body: unknown) =>
    app.inject({ method: 'POST', url: `/jobs/${jobId}/scoring-runs`, payload: body as object });

  it('scores a finished job and returns the tier breakdown', async () => {
    const jobId = await seedEnrichedJob(db, metrics);
    const res = await score(jobId, DEFAULT_SCORING_CONFIG);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      run: { scored: 3, tiers: { LARGE: 1, MEDIUM: 1, SMALL: 1 }, config: DEFAULT_SCORING_CONFIG },
      jobStatus: 'COMPLETED',
      totalStores: 3,
      partial: false,
    });
  });

  it('flags a run made while enrichment is still going as partial', async () => {
    const jobId = await seedEnrichedJob(db, metrics, 'RUNNING');
    const res = await score(jobId, DEFAULT_SCORING_CONFIG);
    expect(res.json()).toMatchObject({ partial: true, jobStatus: 'RUNNING' });
  });

  it('rejects an invalid config with every problem listed', async () => {
    const jobId = await seedEnrichedJob(db, metrics);
    const res = await score(jobId, {
      ...DEFAULT_SCORING_CONFIG,
      weights: { footfall: 50, revenue: 30, sizeSqft: 10 },
      tiers: { large: 30, medium: 40 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual([
      { path: 'weights', message: 'weights must add up to 100 (currently 90)' },
      { path: 'tiers', message: 'the Large cut-off must be higher than the Medium cut-off' },
    ]);
  });

  it('serves the latest run and the store list filtered by tier', async () => {
    const jobId = await seedEnrichedJob(db, metrics);
    await score(jobId, DEFAULT_SCORING_CONFIG);

    const latest = await app.inject({ url: `/jobs/${jobId}/scoring-runs/latest` });
    expect(latest.json().run.tiers).toEqual({ LARGE: 1, MEDIUM: 1, SMALL: 1 });

    const medium = await app.inject({ url: `/jobs/${jobId}/stores?tier=MEDIUM` });
    expect(medium.statusCode).toBe(200);
    expect(medium.json()).toMatchObject({
      runId: latest.json().run.id,
      total: 1,
      items: [{ storeId: 'ST000002', score: 50, tier: 'MEDIUM', footfall: 20_000 }],
    });
  });

  it('explains what is missing instead of failing silently', async () => {
    const jobId = await seedEnrichedJob(db, metrics);
    expect(
      (await app.inject({ url: `/jobs/${jobId}/scoring-runs/latest` })).json().error.code,
    ).toBe('NO_SCORING_RUN');
    expect((await app.inject({ url: `/jobs/${jobId}/stores?tier=LARGE` })).statusCode).toBe(409);
    expect((await app.inject({ url: `/jobs/${jobId}/stores?tier=HUGE` })).statusCode).toBe(400);
    expect(
      (await score('55555555-5555-4555-8555-555555555555', DEFAULT_SCORING_CONFIG)).statusCode,
    ).toBe(404);
  });
});
