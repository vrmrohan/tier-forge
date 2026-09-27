import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { JOB_PROGRESS_CHANNEL } from './job-notify.js';

/** Where notifications come from. Production: one dedicated pg connection. Tests: PGlite. */
export interface NotificationSource {
  /** Starts listening; returns a function that stops. Calls `onError` if the connection drops. */
  listen(
    onJobId: (jobId: string) => void,
    onError: (error: Error) => void,
  ): Promise<() => Promise<void>>;
}

export type Listener<T> = (snapshot: T) => void;

export interface JobEventHubOptions<T> {
  source: NotificationSource;
  /** Reads the current state of a job (job + progress counts). */
  loadSnapshot: (jobId: string) => Promise<T | undefined>;
  logger: FastifyBaseLogger;
  /** Merge bursts of notifications for one job into one snapshot per window. */
  coalesceMs?: number;
  /** Wait before re-listening after the connection drops. */
  reconnectMs?: number;
}

/**
 * Fans Postgres NOTIFY events out to SSE subscribers.
 *
 * One LISTEN connection per process (not one per browser tab). Workers finish up to
 * 4 tasks/s, so notifications for a job are coalesced: at most one snapshot query per
 * job per `coalesceMs`, shared by every subscriber of that job.
 */
export class JobEventHub<T> {
  private readonly subscribers = new Map<string, Set<Listener<T>>>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private stopListening: (() => Promise<void>) | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: JobEventHubOptions<T>) {}

  async start(): Promise<void> {
    if (this.closed) return;
    try {
      this.stopListening = await this.options.source.listen(
        (jobId) => this.schedule(jobId),
        (error) => this.onConnectionLost(error),
      );
      // Anything missed while disconnected: refresh every watched job once.
      for (const jobId of this.subscribers.keys()) this.schedule(jobId);
    } catch (error) {
      this.onConnectionLost(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Returns an unsubscribe function. */
  subscribe(jobId: string, listener: Listener<T>): () => void {
    let set = this.subscribers.get(jobId);
    if (!set) this.subscribers.set(jobId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.subscribers.delete(jobId);
    };
  }

  subscriberCount(jobId?: string): number {
    if (jobId) return this.subscribers.get(jobId)?.size ?? 0;
    let n = 0;
    for (const s of this.subscribers.values()) n += s.size;
    return n;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.subscribers.clear();
    await this.stopListening?.().catch(() => undefined);
  }

  /** Coalesce: the first notification opens a window; the snapshot is read when it closes. */
  private schedule(jobId: string): void {
    if (!this.subscribers.has(jobId) || this.pending.has(jobId)) return;
    const timer = setTimeout(() => void this.flush(jobId), this.options.coalesceMs ?? 500);
    this.pending.set(jobId, timer);
  }

  private async flush(jobId: string): Promise<void> {
    this.pending.delete(jobId);
    const listeners = this.subscribers.get(jobId);
    if (!listeners?.size) return;
    try {
      const snapshot = await this.options.loadSnapshot(jobId);
      if (snapshot === undefined) return;
      for (const listener of [...listeners]) listener(snapshot);
    } catch (error) {
      this.options.logger.warn({ err: error, jobId }, 'could not load job snapshot for SSE');
    }
  }

  private onConnectionLost(error: Error): void {
    if (this.closed) return;
    this.options.logger.warn({ err: error }, 'job event listener disconnected; reconnecting');
    this.stopListening = undefined;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.start(), this.options.reconnectMs ?? 2_000);
  }
}

/** A dedicated pg connection running LISTEN (a pooled connection can't hold a LISTEN). */
export function createPgNotificationSource(connectionString: string): NotificationSource {
  return {
    async listen(onJobId, onError) {
      const client = new pg.Client({ connectionString });
      let stopping = false;
      client.on('notification', (msg) => {
        if (msg.channel === JOB_PROGRESS_CHANNEL && msg.payload) onJobId(msg.payload);
      });
      client.on('error', (err) => {
        if (!stopping) onError(err);
      });
      client.on('end', () => {
        if (!stopping) onError(new Error('LISTEN connection ended'));
      });
      await client.connect();
      await client.query(`LISTEN ${JOB_PROGRESS_CHANNEL}`);
      return async () => {
        stopping = true;
        await client.end();
      };
    },
  };
}
