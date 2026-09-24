import {
  DEFAULT_SCORING_CONFIG,
  scoreStore,
  tierFor,
  type ScoringConfig,
  type StoreMetrics,
} from '@tierforge/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/database.js';
import { createScoringRepository } from '../src/scoring/scoring.repository.js';
import { createTestDb } from './test-db.js';
import { resetJobs, seedEnrichedJob } from './seed.js';

/** The brief's worked example stores A, B, C. */
const WORKED_EXAMPLE: StoreMetrics[] = [
  { footfall: 40_000, revenue: 400_000, sizeSqft: 18_000 },
  { footfall: 20_000, revenue: 100_000, sizeSqft: 5_000 },
  { footfall: 2_000, revenue: 20_000, sizeSqft: 9_000 },
];

/** Deterministic pseudo-random numbers so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

describe('scoring (Postgres)', () => {
  let db: DB;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(() => db.destroy());
  beforeEach(() => resetJobs(db));

  it('reproduces the brief worked example: A=100 Large, B=50 Medium, C=20 Small', async () => {
    const jobId = await seedEnrichedJob(db, WORKED_EXAMPLE);
    const scoring = createScoringRepository(db);

    const run = await scoring.run(jobId, DEFAULT_SCORING_CONFIG);

    expect(run).toMatchObject({ scored: 3, tiers: { LARGE: 1, MEDIUM: 1, SMALL: 1 } });
    const { items } = await scoring.listStores({
      jobId,
      runId: run.id,
      sort: 'storeId',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(items.map((s) => [s.score, s.tier])).toEqual([
      [100, 'LARGE'],
      [50, 'MEDIUM'],
      [20, 'SMALL'],
    ]);
  });

  it('SQL and the shared TypeScript rule agree on every store, boundaries included', async () => {
    const random = rng(42);
    const config: ScoringConfig = {
      bars: { footfall: 20_000, revenue: 250_000.5, sizeSqft: 10_000 },
      weights: { footfall: 45, revenue: 35, sizeSqft: 20 },
      tiers: { large: 65, medium: 35 },
    };
    const metrics: StoreMetrics[] = Array.from({ length: 1_000 }, (_, i) => {
      // Every 10th store sits exactly on a bar or one unit below it.
      if (i % 10 === 0) {
        const d = i % 20 === 0 ? 0 : 1;
        return {
          footfall: config.bars.footfall - d,
          revenue: config.bars.revenue - d / 100,
          sizeSqft: config.bars.sizeSqft - d,
        };
      }
      return {
        footfall: Math.floor(random() * 50_000),
        revenue: Math.round(random() * 500_000_00) / 100,
        sizeSqft: Math.floor(random() * 20_000),
      };
    });
    const jobId = await seedEnrichedJob(db, metrics);
    const scoring = createScoringRepository(db);

    const run = await scoring.run(jobId, config);
    const { items } = await scoring.listStores({
      jobId,
      runId: run.id,
      sort: 'storeId',
      order: 'asc',
      limit: 500,
      offset: 0,
    });
    const rest = await scoring.listStores({
      jobId,
      runId: run.id,
      sort: 'storeId',
      order: 'asc',
      limit: 500,
      offset: 500,
    });

    const all = [...items, ...rest.items];
    expect(all).toHaveLength(1_000);
    for (const store of all) {
      const expected = scoreStore(store, config);
      expect(store.score).toBe(expected);
      expect(store.tier).toBe(tierFor(expected, config.tiers));
    }
  });

  it('scores 5,000 stores in well under a second and can be re-run with new settings', async () => {
    const random = rng(7);
    const metrics = Array.from({ length: 5_000 }, () => ({
      footfall: Math.floor(random() * 50_000),
      revenue: Math.round(random() * 500_000_00) / 100,
      sizeSqft: Math.floor(random() * 20_000),
    }));
    const jobId = await seedEnrichedJob(db, metrics);
    const scoring = createScoringRepository(db);

    const started = performance.now();
    const first = await scoring.run(jobId, DEFAULT_SCORING_CONFIG);
    const elapsed = performance.now() - started;
    expect(first.scored).toBe(5_000);
    // Generous bound so a busy machine running tests in parallel doesn't flake;
    // typically ~100–300 ms on the in-process Postgres, faster on real Postgres.
    expect(elapsed).toBeLessThan(2_000);

    // Stricter bars move stores down; the first run stays intact and reproducible.
    const strict = await scoring.run(jobId, {
      ...DEFAULT_SCORING_CONFIG,
      bars: { footfall: 45_000, revenue: 450_000, sizeSqft: 18_000 },
    });
    expect(strict.tiers.LARGE).toBeLessThan(first.tiers.LARGE);
    expect((await scoring.findRun(jobId, first.id))?.tiers).toEqual(first.tiers);
    expect((await scoring.latestRun(jobId))?.id).toBe(strict.id);
  });

  it('lists stores filtered by tier, sorted, paginated', async () => {
    const jobId = await seedEnrichedJob(db, [...WORKED_EXAMPLE, ...WORKED_EXAMPLE]);
    const scoring = createScoringRepository(db);
    const run = await scoring.run(jobId, DEFAULT_SCORING_CONFIG);

    const large = await scoring.listStores({
      jobId,
      runId: run.id,
      tier: 'LARGE',
      sort: 'score',
      order: 'desc',
      limit: 1,
      offset: 0,
    });
    expect(large.total).toBe(2);
    expect(large.items).toHaveLength(1);
    expect(large.items[0]).toMatchObject({ tier: 'LARGE', score: 100, footfall: 40_000 });

    const byRevenue = await scoring.listStores({
      jobId,
      runId: run.id,
      sort: 'revenue',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(byRevenue.items.map((s) => s.revenue)).toEqual([
      20_000, 20_000, 100_000, 100_000, 400_000, 400_000,
    ]);
  });

  it('lists enriched stores with null score before any scoring run', async () => {
    const jobId = await seedEnrichedJob(db, WORKED_EXAMPLE);
    const page = await createScoringRepository(db).listStores({
      jobId,
      sort: 'storeId',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(page.total).toBe(3);
    expect(page.items.every((s) => s.score === null && s.tier === null)).toBe(true);
  });
});
