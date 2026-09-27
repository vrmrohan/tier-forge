import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, isTerminal, type JobStatus, type Progress } from '../api';
import { ago, duration, fmt, pct } from '../format';
import { ErrorNote, Section } from './Section';

const STATUS: Record<JobStatus, { label: string; icon: string; tone: string }> = {
  QUEUED: { label: 'Queued', icon: '○', tone: 'neutral' },
  RUNNING: { label: 'Running', icon: '◐', tone: 'info' },
  COMPLETED: { label: 'Completed', icon: '✓', tone: 'good' },
  COMPLETED_WITH_FAILURES: { label: 'Completed with failures', icon: '!', tone: 'warning' },
  FAILED_SYSTEMIC: { label: 'Stopped: API broken', icon: '✕', tone: 'critical' },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS[status];
  return (
    <span className={`badge badge-${s.tone}`}>
      <span aria-hidden="true">{s.icon}</span> {s.label}
    </span>
  );
}

/** Refreshes every second so "last progress 3s ago" stays honest while a job runs. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function ProgressBar({ p }: { p: Progress }) {
  const segments = [
    { key: 'succeeded', n: p.succeeded, cls: 'seg-good', label: 'Enriched' },
    { key: 'failed', n: p.failed, cls: 'seg-critical', label: 'Failed' },
    { key: 'aborted', n: p.aborted, cls: 'seg-muted', label: 'Aborted' },
  ].filter((s) => s.n > 0);
  const done = p.succeeded + p.failed + p.aborted;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={p.total}
      aria-valuenow={done}
      aria-label={`${fmt(done)} of ${fmt(p.total)} stores processed`}
    >
      {segments.map((s) => (
        <div
          key={s.key}
          className={`progress-seg ${s.cls}`}
          style={{ flexGrow: s.n }}
          title={`${s.label}: ${fmt(s.n)}`}
        />
      ))}
      {p.total - done > 0 && <div className="progress-rest" style={{ flexGrow: p.total - done }} />}
    </div>
  );
}

export function JobPanel({ jobId }: { jobId: string }) {
  const query = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.getJob(jobId),
    // Poll while the job runs; stop once it reaches a final state.
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.job.status) ? false : 2000),
  });
  const running = !!query.data && !isTerminal(query.data.job.status);
  const now = useNow(running);

  if (query.error) {
    return (
      <Section step={2} title="Enrichment">
        <ErrorNote error={query.error} />
      </Section>
    );
  }
  if (!query.data) {
    return (
      <Section step={2} title="Enrichment">
        <p className="hint">Loading job…</p>
      </Section>
    );
  }

  const { job, progress: p } = query.data;
  const waiting = p.pending + p.inFlight;
  const done = p.succeeded + p.failed + p.aborted;

  return (
    <Section step={2} title="Enrichment" aside={<StatusBadge status={job.status} />}>
      <ProgressBar p={p} />
      <dl className="stats">
        <div>
          <dt>
            <span className="swatch seg-good" aria-hidden="true" /> Enriched
          </dt>
          <dd>{fmt(p.succeeded)}</dd>
        </div>
        <div>
          <dt>
            <span className="swatch seg-critical" aria-hidden="true" /> Failed
          </dt>
          <dd>{fmt(p.failed)}</dd>
        </div>
        {p.aborted > 0 && (
          <div>
            <dt>
              <span className="swatch seg-muted" aria-hidden="true" /> Aborted
            </dt>
            <dd>{fmt(p.aborted)}</dd>
          </div>
        )}
        <div>
          <dt>
            <span className="swatch seg-rest" aria-hidden="true" /> Pending
          </dt>
          <dd>
            {fmt(waiting)}
            {p.inFlight > 0 && <small> ({p.inFlight} in flight)</small>}
          </dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{fmt(p.total)}</dd>
        </div>
      </dl>
      <p className="hint">
        {pct(done, p.total)} processed · running for {duration(job.startedAt, job.finishedAt)}
        {running && <> · last progress {ago(job.lastProgressAt, now)}</>}
      </p>

      {job.status === 'FAILED_SYSTEMIC' && job.terminalReason && (
        <p className="note note-error" role="alert">
          <strong>Job stopped.</strong> {job.terminalReason}. Unfinished stores were aborted; start
          a new job once the Enrichment API is healthy.
        </p>
      )}

      {p.failed + p.aborted > 0 && <FailuresTable jobId={jobId} total={p.failed + p.aborted} />}
    </Section>
  );
}

const PAGE = 20;

function FailuresTable({ jobId, total }: { jobId: string; total: number }) {
  const [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: ['failures', jobId, page, total],
    queryFn: () => api.failures(jobId, PAGE, page * PAGE),
    placeholderData: keepPreviousData,
  });
  const pages = Math.max(1, Math.ceil((query.data?.total ?? total) / PAGE));

  return (
    <details className="failures" open={total <= 20}>
      <summary>
        Why {fmt(total)} {total === 1 ? 'store' : 'stores'} did not get enriched
      </summary>
      <ErrorNote error={query.error} />
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th scope="col">Store</th>
              <th scope="col">Name</th>
              <th scope="col" className="num">
                Attempts
              </th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items.map((f) => (
              <tr key={f.storeId}>
                <td>{f.storeId}</td>
                <td>{f.storeName}</td>
                <td className="num">{f.attempts}</td>
                <td>{f.lastError ?? f.status.toLowerCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
    </details>
  );
}

export function Pager(props: { page: number; pages: number; onPage: (p: number) => void }) {
  return (
    <nav className="pager" aria-label="Pages">
      <button onClick={() => props.onPage(props.page - 1)} disabled={props.page === 0}>
        ‹ Prev
      </button>
      <span>
        Page {props.page + 1} of {props.pages}
      </span>
      <button onClick={() => props.onPage(props.page + 1)} disabled={props.page >= props.pages - 1}>
        Next ›
      </button>
    </nav>
  );
}
