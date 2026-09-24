import { z } from 'zod';

/**
 * TierForge scoring rules, in one place for the API and the web app.
 *
 * A store's score is the sum of the weights of every metric bar it clears
 * (value >= bar). Its tier follows from comparing that score to the cut-offs
 * (score >= large → LARGE, score >= medium → MEDIUM, else SMALL).
 * No normalization, no ranges: exactly the brief's worked example.
 *
 * The server runs the same rule as one SQL statement over all stores;
 * a test checks the two always agree.
 */

export const TIERS = ['LARGE', 'MEDIUM', 'SMALL'] as const;
export type Tier = (typeof TIERS)[number];

export const METRICS = ['footfall', 'revenue', 'sizeSqft'] as const;
export type Metric = (typeof METRICS)[number];

export type StoreMetrics = Record<Metric, number>;

const bar = z.number().finite().nonnegative();
const weight = z.number().int('must be a whole number').min(0).max(100);
const cutoff = z.number().int('must be a whole number').min(0).max(100);

export const ScoringConfigSchema = z
  .object({
    /** Minimum value that counts as strong, per metric. Revenue may have cents. */
    bars: z.object({
      footfall: bar.int('must be a whole number'),
      revenue: bar.refine((v) => Math.round(v * 100) === v * 100, 'at most 2 decimals'),
      sizeSqft: bar.int('must be a whole number'),
    }),
    /** Percentage points each cleared bar contributes. Whole numbers summing to 100. */
    weights: z.object({ footfall: weight, revenue: weight, sizeSqft: weight }),
    /** Minimum score for each tier. */
    tiers: z.object({ large: cutoff, medium: cutoff }),
  })
  .superRefine((config, ctx) => {
    const sum = config.weights.footfall + config.weights.revenue + config.weights.sizeSqft;
    if (sum !== 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['weights'],
        message: `weights must add up to 100 (currently ${sum})`,
      });
    }
    if (config.tiers.medium >= config.tiers.large) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiers'],
        message: 'the Large cut-off must be higher than the Medium cut-off',
      });
    }
  });

export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

/** The brief's example: bars 15,000 / 150,000 / 8,000, weights 50/30/20, Large ≥ 70, Medium ≥ 40. */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  bars: { footfall: 15_000, revenue: 150_000, sizeSqft: 8_000 },
  weights: { footfall: 50, revenue: 30, sizeSqft: 20 },
  tiers: { large: 70, medium: 40 },
};

/** Which bars a store clears. A value exactly at the bar clears it. */
export function clearedBars(metrics: StoreMetrics, config: ScoringConfig): Record<Metric, boolean> {
  return {
    footfall: metrics.footfall >= config.bars.footfall,
    revenue: metrics.revenue >= config.bars.revenue,
    sizeSqft: metrics.sizeSqft >= config.bars.sizeSqft,
  };
}

/** Sum of the weights of the cleared bars: 0–100. */
export function scoreStore(metrics: StoreMetrics, config: ScoringConfig): number {
  const cleared = clearedBars(metrics, config);
  return METRICS.reduce((sum, m) => sum + (cleared[m] ? config.weights[m] : 0), 0);
}

/** A score exactly at a cut-off belongs to the higher tier. */
export function tierFor(score: number, tiers: ScoringConfig['tiers']): Tier {
  if (score >= tiers.large) return 'LARGE';
  if (score >= tiers.medium) return 'MEDIUM';
  return 'SMALL';
}
