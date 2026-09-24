import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCORING_CONFIG as config,
  ScoringConfigSchema,
  scoreStore,
  tierFor,
  type ScoringConfig,
} from '../src/scoring.js';

describe('the brief worked example', () => {
  it.each([
    ['A', { footfall: 40_000, revenue: 400_000, sizeSqft: 18_000 }, 100, 'LARGE'],
    ['B', { footfall: 20_000, revenue: 100_000, sizeSqft: 5_000 }, 50, 'MEDIUM'],
    ['C', { footfall: 2_000, revenue: 20_000, sizeSqft: 9_000 }, 20, 'SMALL'],
  ] as const)('store %s scores %i and is %s', (_name, metrics, score, tier) => {
    expect(scoreStore(metrics, config)).toBe(score);
    expect(tierFor(score, config.tiers)).toBe(tier);
  });
});

describe('boundaries', () => {
  it('a value exactly at the bar clears it; one below does not', () => {
    const at = { footfall: 15_000, revenue: 150_000, sizeSqft: 8_000 };
    expect(scoreStore(at, config)).toBe(100);
    expect(scoreStore({ footfall: 14_999, revenue: 149_999.99, sizeSqft: 7_999 }, config)).toBe(0);
  });

  it('a score exactly at a cut-off gets the higher tier', () => {
    expect(tierFor(70, config.tiers)).toBe('LARGE');
    expect(tierFor(69, config.tiers)).toBe('MEDIUM');
    expect(tierFor(40, config.tiers)).toBe('MEDIUM');
    expect(tierFor(39, config.tiers)).toBe('SMALL');
    expect(tierFor(0, config.tiers)).toBe('SMALL');
    expect(tierFor(100, config.tiers)).toBe('LARGE');
  });

  it('a zero-weight bar contributes nothing even when cleared', () => {
    const cfg: ScoringConfig = { ...config, weights: { footfall: 100, revenue: 0, sizeSqft: 0 } };
    expect(scoreStore({ footfall: 0, revenue: 1e9, sizeSqft: 1e9 }, cfg)).toBe(0);
  });

  it('a zero bar is cleared by every store', () => {
    const cfg: ScoringConfig = { ...config, bars: { footfall: 0, revenue: 0, sizeSqft: 0 } };
    expect(scoreStore({ footfall: 0, revenue: 0, sizeSqft: 0 }, cfg)).toBe(100);
  });
});

describe('ScoringConfigSchema', () => {
  const issues = (value: unknown): string[] => {
    const r = ScoringConfigSchema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('accepts the default config', () => {
    expect(issues(config)).toEqual([]);
  });

  it('requires weights to add up to exactly 100', () => {
    expect(issues({ ...config, weights: { footfall: 33, revenue: 33, sizeSqft: 33 } })).toEqual([
      'weights: weights must add up to 100 (currently 99)',
    ]);
  });

  it('rejects fractional weights (no 33.33 + 33.33 + 33.34)', () => {
    expect(
      issues({ ...config, weights: { footfall: 33.33, revenue: 33.33, sizeSqft: 33.34 } }),
    ).toContain('weights.footfall: must be a whole number');
  });

  it('requires Large above Medium', () => {
    expect(issues({ ...config, tiers: { large: 40, medium: 40 } })).toEqual([
      'tiers: the Large cut-off must be higher than the Medium cut-off',
    ]);
  });

  it('rejects negative bars, out-of-range values and extra cents', () => {
    expect(issues({ ...config, bars: { ...config.bars, footfall: -1 } })).toHaveLength(1);
    expect(issues({ ...config, tiers: { large: 101, medium: 40 } })).toHaveLength(1);
    expect(issues({ ...config, bars: { ...config.bars, revenue: 10.123 } })).toEqual([
      'bars.revenue: at most 2 decimals',
    ]);
  });
});
