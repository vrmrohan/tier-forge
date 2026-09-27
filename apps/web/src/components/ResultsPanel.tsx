import { clearedBars, METRICS, TIERS, type Metric, type Tier } from '@tierforge/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ScoringRun, type StoreSort } from '../api';
import { fmt, fmtMoney, pct } from '../format';
import { Pager } from './JobPanel';
import { METRIC_LABEL } from './ScoringPanel';
import { ErrorNote, Section } from './Section';

const TIER_LABEL: Record<Tier, string> = { LARGE: 'Large', MEDIUM: 'Medium', SMALL: 'Small' };
const PAGE = 25;

export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className="tier-badge">
      <span className={`swatch tier-${tier.toLowerCase()}`} aria-hidden="true" />
      {TIER_LABEL[tier]}
    </span>
  );
}

/** Parts of a whole: one 100% bar with direct labels, plus tiles carrying the exact numbers. */
function TierBreakdown({ run }: { run: ScoringRun }) {
  const total = run.scored;
  return (
    <div className="breakdown">
      <div className="tiles">
        {TIERS.map((t) => (
          <div key={t} className="tile">
            <div className="tile-label">
              <TierBadge tier={t} />
            </div>
            <div className="tile-value">{fmt(run.tiers[t])}</div>
            <div className="tile-sub">{pct(run.tiers[t], total)} of scored stores</div>
          </div>
        ))}
      </div>
      {total > 0 && (
        <div
          className="tier-bar"
          role="img"
          aria-label={TIERS.map((t) => `${TIER_LABEL[t]} ${fmt(run.tiers[t])}`).join(', ')}
        >
          {TIERS.filter((t) => run.tiers[t] > 0).map((t) => (
            <div
              key={t}
              className={`tier-seg tier-${t.toLowerCase()}`}
              style={{ flexGrow: run.tiers[t] }}
              title={`${TIER_LABEL[t]}: ${fmt(run.tiers[t])} (${pct(run.tiers[t], total)})`}
            >
              {run.tiers[t] / total >= 0.08 && (
                <span className="tier-seg-label">
                  {TIER_LABEL[t]} {pct(run.tiers[t], total)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SortHeader(props: {
  label: string;
  column: StoreSort;
  sort: StoreSort;
  order: 'asc' | 'desc';
  onSort: (c: StoreSort) => void;
  numeric?: boolean;
}) {
  const active = props.sort === props.column;
  return (
    <th
      scope="col"
      className={props.numeric ? 'num' : undefined}
      aria-sort={active ? (props.order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button className="sort" onClick={() => props.onSort(props.column)}>
        {props.label}
        <span aria-hidden="true" className="sort-icon">
          {active ? (props.order === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

export function ResultsPanel({ jobId }: { jobId: string }) {
  const run = useQuery({ queryKey: ['run', jobId], queryFn: () => api.latestRun(jobId) });
  const job = useQuery({ queryKey: ['job', jobId], queryFn: () => api.getJob(jobId) });
  const [tier, setTier] = useState<Tier | undefined>();
  const [sort, setSort] = useState<StoreSort>('score');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

  const runId = run.data?.id;
  const stores = useQuery({
    queryKey: ['stores', jobId, runId, tier, sort, order, page],
    queryFn: () =>
      api.stores(jobId, {
        runId: runId!,
        ...(tier ? { tier } : {}),
        sort,
        order,
        limit: PAGE,
        offset: page * PAGE,
      }),
    enabled: !!runId,
    placeholderData: keepPreviousData,
  });

  const onSort = (column: StoreSort) => {
    if (column === sort) setOrder(order === 'asc' ? 'desc' : 'asc');
    else {
      setSort(column);
      setOrder(column === 'storeId' ? 'asc' : 'desc');
    }
    setPage(0);
  };

  if (run.error) {
    return (
      <Section step={4} title="Results">
        <ErrorNote error={run.error} />
      </Section>
    );
  }
  if (!run.data) {
    return (
      <Section step={4} title="Results">
        <p className="hint">{run.isLoading ? 'Loading…' : 'Score the job to see tiers here.'}</p>
      </Section>
    );
  }

  const r = run.data;
  const enrichedNow = job.data?.progress.succeeded ?? r.scored;
  const unscored = enrichedNow - r.scored;
  const pages = Math.max(1, Math.ceil((stores.data?.total ?? 0) / PAGE));
  const filterCounts: Record<string, number> = { ALL: r.scored, ...r.tiers };

  return (
    <Section
      step={4}
      title="Results"
      aside={<span className="hint">Scored {new Date(r.createdAt).toLocaleString()}</span>}
    >
      <TierBreakdown run={r} />
      {unscored > 0 && (
        <p className="note">
          {fmt(unscored)} more {unscored === 1 ? 'store has' : 'stores have'} been enriched since
          this run. Score again to include {unscored === 1 ? 'it' : 'them'}.
        </p>
      )}

      <div className="filters" role="group" aria-label="Filter by tier">
        {(['ALL', ...TIERS] as const).map((t) => {
          const selected = (t === 'ALL' && !tier) || t === tier;
          return (
            <button
              key={t}
              className={`chip${selected ? ' chip-on' : ''}`}
              aria-pressed={selected}
              onClick={() => {
                setTier(t === 'ALL' ? undefined : t);
                setPage(0);
              }}
            >
              {t === 'ALL' ? 'All' : TIER_LABEL[t]}{' '}
              <span className="chip-count">{fmt(filterCounts[t] ?? 0)}</span>
            </button>
          );
        })}
      </div>

      <ErrorNote error={stores.error} />
      <div className="table-wrap">
        <table className="table stores">
          <thead>
            <tr>
              <SortHeader
                label="Store"
                column="storeId"
                sort={sort}
                order={order}
                onSort={onSort}
              />
              <th scope="col">City</th>
              <SortHeader
                label="Footfall"
                column="footfall"
                sort={sort}
                order={order}
                onSort={onSort}
                numeric
              />
              <SortHeader
                label="Revenue"
                column="revenue"
                sort={sort}
                order={order}
                onSort={onSort}
                numeric
              />
              <SortHeader
                label="Size (sqft)"
                column="sizeSqft"
                sort={sort}
                order={order}
                onSort={onSort}
                numeric
              />
              <SortHeader
                label="Score"
                column="score"
                sort={sort}
                order={order}
                onSort={onSort}
                numeric
              />
              <th scope="col">Tier</th>
            </tr>
          </thead>
          <tbody className={stores.isPlaceholderData ? 'loading' : undefined}>
            {stores.data?.items.map((s) => {
              const cleared = clearedBars(s, r.config);
              const cell = (m: Metric, text: string) => (
                <td className="num">
                  {text}
                  <span
                    className={cleared[m] ? 'bar-hit' : 'bar-miss'}
                    title={`${cleared[m] ? 'Clears' : 'Below'} the ${METRIC_LABEL[m].toLowerCase()} bar (+${cleared[m] ? r.config.weights[m] : 0})`}
                  >
                    {cleared[m] ? ` ✓+${r.config.weights[m]}` : ''}
                  </span>
                </td>
              );
              return (
                <tr key={s.storeId}>
                  <td>
                    <div className="store-name">{s.storeName}</div>
                    <div className="store-id">{s.storeId}</div>
                  </td>
                  <td>
                    {s.city}, {s.state}
                  </td>
                  {cell('footfall', fmt(s.footfall))}
                  {cell('revenue', fmtMoney(s.revenue))}
                  {cell('sizeSqft', fmt(s.sizeSqft))}
                  <td className="num">
                    <strong>{s.score ?? '–'}%</strong>
                  </td>
                  <td>{s.tier && <TierBadge tier={s.tier} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-foot">
        <span className="hint">
          {fmt(stores.data?.total ?? 0)} stores · ✓+N marks a cleared bar and the weight it adds
        </span>
        {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
      </div>
      <p className="sr-only">Metrics: {METRICS.map((m) => METRIC_LABEL[m]).join(', ')}.</p>
    </Section>
  );
}
