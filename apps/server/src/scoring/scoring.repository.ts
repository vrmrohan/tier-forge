import type { ScoringConfig, Tier } from '@tierforge/shared';
import { sql } from 'kysely';
import type { DB } from '../db/database.js';
import type { ScoringConfigsTable } from '../db/schema.js';
import type { Selectable } from 'kysely';

export interface TierCounts {
  LARGE: number;
  MEDIUM: number;
  SMALL: number;
}

export interface ScoringRun {
  id: string;
  jobId: string;
  config: ScoringConfig;
  createdAt: Date;
  /** Stores scored: every store enriched when the run happened. */
  scored: number;
  tiers: TierCounts;
}

export interface ScoredStore {
  storeId: string;
  storeName: string;
  city: string;
  state: string;
  footfall: number;
  revenue: number;
  sizeSqft: number;
  score: number | null;
  tier: Tier | null;
}

export type StoreSort = 'score' | 'storeId' | 'footfall' | 'revenue' | 'sizeSqft';

const toConfig = (row: Selectable<ScoringConfigsTable>): ScoringConfig => ({
  bars: { footfall: row.footfall_bar, revenue: row.revenue_bar, sizeSqft: row.size_bar },
  weights: {
    footfall: row.footfall_weight,
    revenue: row.revenue_weight,
    sizeSqft: row.size_weight,
  },
  tiers: { large: row.large_cutoff, medium: row.medium_cutoff },
});

export function createScoringRepository(db: DB) {
  async function tierCounts(configId: string): Promise<TierCounts> {
    const rows = await db
      .selectFrom('store_scores')
      .select(['tier', (eb) => eb.fn.countAll<number>().as('count')])
      .where('scoring_config_id', '=', configId)
      .groupBy('tier')
      .execute();
    const counts: TierCounts = { LARGE: 0, MEDIUM: 0, SMALL: 0 };
    for (const r of rows) counts[r.tier] = Number(r.count);
    return counts;
  }

  async function toRun(row: Selectable<ScoringConfigsTable>): Promise<ScoringRun> {
    const tiers = await tierCounts(row.id);
    return {
      id: row.id,
      jobId: row.job_id,
      config: toConfig(row),
      createdAt: row.created_at,
      scored: tiers.LARGE + tiers.MEDIUM + tiers.SMALL,
      tiers,
    };
  }

  return {
    /**
     * Scores every enriched store of a job in one set-based statement.
     * Reads only store_metrics: never calls the Enrichment API, so it is fast and
     * can be re-run whenever bars, weights or cut-offs change. Each run is saved
     * under its own immutable config, so earlier breakdowns stay reproducible.
     */
    async run(jobId: string, config: ScoringConfig): Promise<ScoringRun> {
      const row = await db.transaction().execute(async (trx) => {
        const saved = await trx
          .insertInto('scoring_configs')
          .values({
            job_id: jobId,
            footfall_bar: config.bars.footfall,
            revenue_bar: config.bars.revenue,
            size_bar: config.bars.sizeSqft,
            footfall_weight: config.weights.footfall,
            revenue_weight: config.weights.revenue,
            size_weight: config.weights.sizeSqft,
            large_cutoff: config.tiers.large,
            medium_cutoff: config.tiers.medium,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        // Same rule as scoreStore()/tierFor() in @tierforge/shared; a test keeps them in step.
        await sql`
          INSERT INTO store_scores (scoring_config_id, store_pk, score, tier)
          SELECT c.id, m.store_pk, s.score,
                 CASE WHEN s.score >= c.large_cutoff  THEN 'LARGE'
                      WHEN s.score >= c.medium_cutoff THEN 'MEDIUM'
                      ELSE 'SMALL' END
          FROM store_metrics m
          JOIN scoring_configs c ON c.id = ${saved.id}
          CROSS JOIN LATERAL (
            SELECT (CASE WHEN m.footfall  >= c.footfall_bar THEN c.footfall_weight ELSE 0 END)
                 + (CASE WHEN m.revenue   >= c.revenue_bar  THEN c.revenue_weight  ELSE 0 END)
                 + (CASE WHEN m.size_sqft >= c.size_bar     THEN c.size_weight     ELSE 0 END)
                   AS score
          ) s
          WHERE m.job_id = ${jobId}
        `.execute(trx);
        return saved;
      });
      return toRun(row);
    },

    async findRun(jobId: string, runId: string): Promise<ScoringRun | undefined> {
      const row = await db
        .selectFrom('scoring_configs')
        .selectAll()
        .where('job_id', '=', jobId)
        .where('id', '=', runId)
        .executeTakeFirst();
      return row && toRun(row);
    },

    async latestRun(jobId: string): Promise<ScoringRun | undefined> {
      const row = await db
        .selectFrom('scoring_configs')
        .selectAll()
        .where('job_id', '=', jobId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row && toRun(row);
    },

    /**
     * Enriched stores with their metrics and, when a scoring run is given, score and tier.
     * Without a run, score and tier are null (the store is enriched but not yet scored).
     */
    async listStores(params: {
      jobId: string;
      runId?: string;
      tier?: Tier;
      sort: StoreSort;
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    }): Promise<{ total: number; items: ScoredStore[] }> {
      const runId = params.runId ?? '00000000-0000-0000-0000-000000000000';
      let base = db
        .selectFrom('store_metrics as m')
        .innerJoin('stores as s', 's.id', 'm.store_pk')
        .leftJoin('store_scores as sc', (join) =>
          join.onRef('sc.store_pk', '=', 'm.store_pk').on('sc.scoring_config_id', '=', runId),
        )
        .where('m.job_id', '=', params.jobId);
      if (params.tier) base = base.where('sc.tier', '=', params.tier);

      const sortColumn = {
        score: 'sc.score',
        storeId: 's.store_id',
        footfall: 'm.footfall',
        revenue: 'm.revenue',
        sizeSqft: 'm.size_sqft',
      } as const;

      const [{ count }, rows] = await Promise.all([
        base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
        base
          .select([
            's.store_id',
            's.store_name',
            's.city',
            's.state',
            'm.footfall',
            'm.revenue',
            'm.size_sqft',
            'sc.score',
            'sc.tier',
          ])
          .orderBy(sortColumn[params.sort], params.order)
          .orderBy('s.store_id', 'asc') // stable paging when values tie
          .limit(params.limit)
          .offset(params.offset)
          .execute(),
      ]);

      return {
        total: Number(count),
        items: rows.map((r) => ({
          storeId: r.store_id,
          storeName: r.store_name,
          city: r.city,
          state: r.state,
          footfall: r.footfall,
          revenue: r.revenue,
          sizeSqft: r.size_sqft,
          score: r.score,
          tier: r.tier,
        })),
      };
    },
  };
}

export type ScoringRepository = ReturnType<typeof createScoringRepository>;
