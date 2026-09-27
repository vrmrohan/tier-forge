import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Job, Progress } from './api';

export type LiveState = 'connecting' | 'live' | 'fallback' | 'closed';

/** How often to poll while the live stream is unavailable. */
export const FALLBACK_POLL_MS = 5_000;

/**
 * Subscribes to GET /jobs/:id/events (Server-Sent Events) and writes each snapshot into the
 * same query cache the page already reads, so components don't care where updates come from.
 *
 * The browser's EventSource reconnects on its own; while it is disconnected the state is
 * 'fallback' and the caller polls every FALLBACK_POLL_MS instead.
 */
export function useJobEvents(jobId: string, active: boolean): LiveState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>(active ? 'connecting' : 'closed');

  useEffect(() => {
    if (!active) {
      setState('closed');
      return;
    }
    if (typeof EventSource === 'undefined') {
      setState('fallback');
      return;
    }
    setState('connecting');
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    const apply = (e: MessageEvent<string>) => {
      queryClient.setQueryData(
        ['job', jobId],
        JSON.parse(e.data) as { job: Job; progress: Progress },
      );
    };

    source.onopen = () => setState('live');
    source.addEventListener('progress', apply);
    source.addEventListener('done', (e) => {
      apply(e);
      source.close(); // final state reached; stop here, or EventSource would reconnect
      setState('closed');
    });
    source.onerror = () => {
      // CONNECTING: the browser is retrying. CLOSED: it gave up (e.g. a 404). Poll meanwhile.
      setState('fallback');
    };

    return () => source.close();
  }, [jobId, active, queryClient]);

  return state;
}
