/** What we send to the Enrichment API for one store. */
export interface StoreInput {
  store_id: string;
  store_name: string;
  address: string;
  city: string;
  state: string;
}

export interface StoreMetrics {
  footfall: number;
  revenue: number;
  sizeSqft: number;
}

/**
 * Every possible result of one enrichment call. The client never throws:
 * each failure mode is a value the retry policy can reason about.
 */
export type EnrichmentOutcome =
  | { kind: 'success'; metrics: StoreMetrics; httpStatus: 200 }
  | { kind: 'rate_limited'; httpStatus: 429 }
  | { kind: 'server_error'; httpStatus: number; message: string }
  | { kind: 'client_error'; httpStatus: number; message: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'network_error'; message: string }
  /** 200 with a body that doesn't match the contract. Treated like a server error. */
  | { kind: 'invalid_response'; httpStatus: number; message: string };

export type FailureOutcome = Exclude<EnrichmentOutcome, { kind: 'success' }>;
