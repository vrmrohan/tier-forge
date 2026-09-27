import {
  DEFAULT_SCORING_CONFIG,
  METRICS,
  ScoringConfigSchema,
  type Metric,
  type ScoringConfig,
} from '@tierforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, isTerminal } from '../api';
import { fmt } from '../format';
import { ErrorNote, Section } from './Section';

export const METRIC_LABEL: Record<Metric, string> = {
  footfall: 'Monthly footfall',
  revenue: 'Monthly revenue',
  sizeSqft: 'Store size (sqft)',
};

/** Form values are kept as text so a half-typed number doesn't jump around. */
interface FormValues {
  bars: Record<Metric, string>;
  weights: Record<Metric, string>;
  tiers: { large: string; medium: string };
}

const toForm = (c: ScoringConfig): FormValues => ({
  bars: {
    footfall: String(c.bars.footfall),
    revenue: String(c.bars.revenue),
    sizeSqft: String(c.bars.sizeSqft),
  },
  weights: {
    footfall: String(c.weights.footfall),
    revenue: String(c.weights.revenue),
    sizeSqft: String(c.weights.sizeSqft),
  },
  tiers: { large: String(c.tiers.large), medium: String(c.tiers.medium) },
});

const num = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text));

/**
 * Validates with the exact schema the API uses (@tierforge/shared), so every error is
 * shown while typing and the server's 400 is only a backstop.
 */
function validate(form: FormValues): { config?: ScoringConfig; errors: Map<string, string> } {
  const candidate = {
    bars: {
      footfall: num(form.bars.footfall),
      revenue: num(form.bars.revenue),
      sizeSqft: num(form.bars.sizeSqft),
    },
    weights: {
      footfall: num(form.weights.footfall),
      revenue: num(form.weights.revenue),
      sizeSqft: num(form.weights.sizeSqft),
    },
    tiers: { large: num(form.tiers.large), medium: num(form.tiers.medium) },
  };
  const result = ScoringConfigSchema.safeParse(candidate);
  const errors = new Map<string, string>();
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      const message = issue.message.includes('NaN') ? 'enter a number' : issue.message;
      if (!errors.has(path)) errors.set(path, message);
    }
  }
  return result.success ? { config: result.data, errors } : { errors };
}

export function ScoringPanel({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const job = useQuery({ queryKey: ['job', jobId], queryFn: () => api.getJob(jobId) });
  const latest = useQuery({ queryKey: ['run', jobId], queryFn: () => api.latestRun(jobId) });

  const [form, setForm] = useState<FormValues>(() => toForm(DEFAULT_SCORING_CONFIG));
  const touched = useRef(false);
  // Start from the last settings used for this job, unless the user already started editing.
  useEffect(() => {
    if (latest.data && !touched.current) setForm(toForm(latest.data.config));
  }, [latest.data]);

  const { config, errors } = useMemo(() => validate(form), [form]);
  const weightSum = METRICS.reduce((s, m) => s + (num(form.weights[m]) || 0), 0);

  const score = useMutation({
    mutationFn: (c: ScoringConfig) => api.score(jobId, c),
    onSuccess: ({ run }) => {
      queryClient.setQueryData(['run', jobId], run);
      void queryClient.invalidateQueries({ queryKey: ['stores', jobId] });
    },
  });

  const set = (group: 'bars' | 'weights', metric: Metric, value: string) => {
    touched.current = true;
    setForm((f) => ({ ...f, [group]: { ...f[group], [metric]: value } }));
  };
  const setTier = (key: 'large' | 'medium', value: string) => {
    touched.current = true;
    setForm((f) => ({ ...f, tiers: { ...f.tiers, [key]: value } }));
  };

  const progress = job.data?.progress;
  const enriched = progress?.succeeded ?? 0;
  const running = job.data ? !isTerminal(job.data.job.status) : false;

  return (
    <Section step={3} title="Score & tier">
      <p className="hint">
        A store earns a metric's weight when it reaches that metric's bar. Its score is the sum
        (0–100%), and the score decides the tier. Scoring uses stored results only, so re-run it as
        often as you like.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (config) score.mutate(config);
        }}
        noValidate
      >
        <div className="table-wrap">
          <table className="table form-table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Bar (at least)</th>
                <th scope="col">Weight %</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => (
                <tr key={m}>
                  <th scope="row">{METRIC_LABEL[m]}</th>
                  <td>
                    <input
                      inputMode="decimal"
                      aria-label={`${METRIC_LABEL[m]} bar`}
                      aria-invalid={errors.has(`bars.${m}`)}
                      value={form.bars[m]}
                      onChange={(e) => set('bars', m, e.target.value)}
                    />
                    {errors.has(`bars.${m}`) && (
                      <span className="field-error">{errors.get(`bars.${m}`)}</span>
                    )}
                  </td>
                  <td>
                    <input
                      className="short"
                      inputMode="numeric"
                      aria-label={`${METRIC_LABEL[m]} weight`}
                      aria-invalid={errors.has(`weights.${m}`) || errors.has('weights')}
                      value={form.weights[m]}
                      onChange={(e) => set('weights', m, e.target.value)}
                    />
                    {errors.has(`weights.${m}`) && (
                      <span className="field-error">{errors.get(`weights.${m}`)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>
                  Total weight
                </th>
                <td className={weightSum === 100 ? 'text-good' : 'text-bad'}>
                  <span aria-hidden="true">{weightSum === 100 ? '✓ ' : '✕ '}</span>
                  {weightSum}%
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {errors.has('weights') && <p className="field-error">{errors.get('weights')}</p>}

        <fieldset className="tiers">
          <legend>Tier cut-offs (score at least)</legend>
          <label>
            Large ≥
            <input
              className="short"
              inputMode="numeric"
              aria-invalid={errors.has('tiers.large') || errors.has('tiers')}
              value={form.tiers.large}
              onChange={(e) => setTier('large', e.target.value)}
            />
            %
          </label>
          <label>
            Medium ≥
            <input
              className="short"
              inputMode="numeric"
              aria-invalid={errors.has('tiers.medium') || errors.has('tiers')}
              value={form.tiers.medium}
              onChange={(e) => setTier('medium', e.target.value)}
            />
            %
          </label>
          <span className="hint">otherwise Small</span>
        </fieldset>
        {['tiers', 'tiers.large', 'tiers.medium'].map(
          (k) =>
            errors.has(k) && (
              <p key={k} className="field-error">
                {errors.get(k)}
              </p>
            ),
        )}

        <div className="row">
          <button
            type="submit"
            className="primary"
            disabled={!config || score.isPending || enriched === 0}
          >
            {score.isPending ? 'Scoring…' : `Score ${fmt(enriched)} enriched stores`}
          </button>
          {enriched === 0 && <span className="hint">Waiting for the first enriched stores.</span>}
          {running && enriched > 0 && (
            <span className="hint">
              Enrichment is still running: stores enriched later need another run.
            </span>
          )}
        </div>
        <ErrorNote error={score.error} />
      </form>
    </Section>
  );
}
