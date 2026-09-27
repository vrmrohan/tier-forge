import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { JobPanel } from './components/JobPanel';
import { ResultsPanel } from './components/ResultsPanel';
import { ScoringPanel } from './components/ScoringPanel';
import { UploadPanel } from './components/UploadPanel';

/** The job being viewed lives in the URL (?job=…), so a reload or a shared link keeps it. */
function useJobId(): [string | null, (id: string) => void] {
  const [jobId, setState] = useState(() => new URLSearchParams(location.search).get('job'));
  const setJobId = useCallback((id: string) => {
    const url = new URL(location.href);
    url.searchParams.set('job', id);
    history.replaceState(null, '', url);
    setState(id);
  }, []);
  return [jobId, setJobId];
}

export function App() {
  const [jobId, setJobId] = useJobId();

  // Without a job in the URL, open the most recent one.
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.listJobs, enabled: !jobId });
  const latestJobId = jobs.data?.jobs[0]?.id;
  useEffect(() => {
    if (!jobId && latestJobId) setJobId(latestJobId);
  }, [jobId, latestJobId, setJobId]);

  return (
    <div className="page">
      <header className="masthead">
        <h1>TierForge</h1>
        <p>
          Enrich a store list through the flaky Enrichment API, then score and tier every store.
        </p>
      </header>

      <UploadPanel onJobStarted={setJobId} />

      {jobId ? (
        <>
          <JobPanel jobId={jobId} />
          <ScoringPanel key={`score-${jobId}`} jobId={jobId} />
          <ResultsPanel key={`results-${jobId}`} jobId={jobId} />
        </>
      ) : (
        !jobs.isLoading && (
          <p className="empty">No enrichment job yet. Upload a CSV above to start one.</p>
        )
      )}
    </div>
  );
}
