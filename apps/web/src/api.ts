import type { ScoringConfig, Tier } from '@tierforge/shared';

/** Mirrors the API's error envelope: { error: { code, message, details } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the TierForge API. Is the server running?');
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      res.status,
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? `Request failed (${res.status})`,
      error?.details,
    );
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ---- Types (match the API responses) ---------------------------------------

export type JobStatus =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_FAILURES' | 'FAILED_SYSTEMIC';

export interface Job {
  id: string;
  uploadId: string;
  status: JobStatus;
  total: number;
  createdAt: string;
  startedAt: string | null;
  lastProgressAt: string | null;
  finishedAt: string | null;
  terminalReason: string | null;
}

export interface Progress {
  total: number;
  pending: number;
  inFlight: number;
  succeeded: number;
  failed: number;
  aborted: number;
}

export interface RowError {
  line: number;
  storeId?: string;
  reason: string;
}

export interface UploadResult {
  upload: { id: string; filename: string; rowCount: number; createdAt: string };
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  errors: RowError[];
  errorsTruncated: boolean;
}

export interface FailedStore {
  storeId: string;
  storeName: string;
  status: 'FAILED' | 'ABORTED';
  attempts: number;
  lastError: string | null;
  lastHttpStatus: number | null;
}

export type TierCounts = Record<Tier, number>;

export interface ScoringRun {
  id: string;
  jobId: string;
  config: ScoringConfig;
  createdAt: string;
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

export interface Page<T> {
  total: number;
  items: T[];
  limit: number;
  offset: number;
}

// ---- Endpoints ---------------------------------------------------------------

export const api = {
  upload(file: File): Promise<UploadResult> {
    const form = new FormData();
    form.append('file', file);
    return request('/uploads', { method: 'POST', body: form });
  },
  startJob(uploadId: string): Promise<{ job: Job; progress: Progress }> {
    return request('/jobs', json('POST', { uploadId }));
  },
  listJobs(): Promise<{ jobs: Job[] }> {
    return request('/jobs');
  },
  getJob(id: string): Promise<{ job: Job; progress: Progress }> {
    return request(`/jobs/${id}`);
  },
  failures(id: string, limit: number, offset: number): Promise<Page<FailedStore>> {
    return request(`/jobs/${id}/failures?limit=${limit}&offset=${offset}`);
  },
  score(
    id: string,
    config: ScoringConfig,
  ): Promise<{ run: ScoringRun; partial: boolean; totalStores: number }> {
    return request(`/jobs/${id}/scoring-runs`, json('POST', config));
  },
  async latestRun(id: string): Promise<ScoringRun | null> {
    try {
      return (await request<{ run: ScoringRun }>(`/jobs/${id}/scoring-runs/latest`)).run;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NO_SCORING_RUN') return null;
      throw error;
    }
  },
  stores(
    id: string,
    params: {
      runId: string;
      tier?: Tier;
      sort: StoreSort;
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    },
  ): Promise<Page<ScoredStore> & { runId: string | null }> {
    const q = new URLSearchParams({
      run: params.runId,
      sort: params.sort,
      order: params.order,
      limit: String(params.limit),
      offset: String(params.offset),
    });
    if (params.tier) q.set('tier', params.tier);
    return request(`/jobs/${id}/stores?${q}`);
  },
};

export const isTerminal = (status: JobStatus): boolean =>
  status === 'COMPLETED' || status === 'COMPLETED_WITH_FAILURES' || status === 'FAILED_SYSTEMIC';
