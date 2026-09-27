import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import pino from 'pino';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { DB } from '../src/db/database.js';
import { createTaskQueue } from '../src/enrichment/task-queue.js';
import { JobEventHub, type NotificationSource } from '../src/events/job-event-hub.js';
import { notifyJobProgress } from '../src/events/job-notify.js';
import { createJobRepository, finalizeFinishedJobs } from '../src/jobs/job.repository.js';
import { createScoringRepository } from '../src/scoring/scoring.repository.js';
import { createUploadRepository } from '../src/uploads/upload.repository.js';
import { resetJobs, seedUpload } from './seed.js';
import { createTestDatabase, pgliteNotificationSource } from './test-db.js';

const logger = pino({ level: 'silent' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const metrics = { footfall: 1, revenue: 1, sizeSqft: 1 };

/** A source we can fire by hand, and break on purpose. */
function manualSource() {
  let emit: (id: string) => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  let listens = 0;
  const source: NotificationSource = {
    async listen(onJobId, onError) {
      listens++;
      emit = onJobId;
      fail = onError;
      return async () => undefined;
    },
  };
  return {
    source,
    emit: (id: string) => emit(id),
    fail: (e: Error) => fail(e),
    listens: () => listens,
  };
}

describe('Postgres NOTIFY for job progress', () => {
  let db: DB;
  let pglite: PGlite;
  let uploadId: string;

  beforeAll(async () => {
    ({ db, pglite } = await createTestDatabase());
    uploadId = await seedUpload(db, 2);
  });
  afterAll(() => db.destroy());
  beforeEach(() => resetJobs(db));

  async function collect(): Promise<{ ids: string[]; stop: () => Promise<void> }> {
    const ids: string[] = [];
    const stop = await pgliteNotificationSource(pglite).listen(
      (id) => ids.push(id),
      () => undefined,
    );
    return { ids, stop };
  }

  it('is delivered on commit and dropped on rollback', async () => {
    const { ids, stop } = await collect();
    await db
      .transaction()
      .execute(async (trx) => {
        await notifyJobProgress(trx, 'rolled-back');
        throw new Error('rollback');
      })
      .catch(() => undefined);
    await db.transaction().execute((trx) => notifyJobProgress(trx, 'committed'));
    await wait(50);
    await stop();
    expect(ids).toEqual(['committed']);
  });

  it('is sent by every write that changes progress', async () => {
    const job = await createJobRepository(db).start(uploadId);
    const { ids, stop } = await collect();
    const queue = createTaskQueue(db);

    const a = (await queue.claimNext(30_000))!;
    await queue.recordSuccess(a, metrics, 1);
    const b = (await queue.claimNext(30_000))!;
    await queue.recordFailure(
      b,
      { outcome: 'SERVER_ERROR', httpStatus: 500, latencyMs: 1, error: 'x' },
      { action: 'fail', reason: 'x' },
    );
    await finalizeFinishedJobs(db);
    await wait(50);
    await stop();

    expect(ids).toEqual([job.id, job.id, job.id]); // success, failure, job closed
  });
});

describe('JobEventHub', () => {
  it('coalesces a burst into one snapshot read shared by all subscribers', async () => {
    const m = manualSource();
    let loads = 0;
    const hub = new JobEventHub({
      source: m.source,
      loadSnapshot: async (id) => ({ id, n: ++loads }),
      logger,
      coalesceMs: 30,
    });
    await hub.start();
    const a: unknown[] = [];
    const b: unknown[] = [];
    hub.subscribe('job-1', (s) => a.push(s));
    hub.subscribe('job-1', (s) => b.push(s));

    for (let i = 0; i < 10; i++) m.emit('job-1');
    m.emit('job-2'); // nobody watching: never loaded
    await wait(80);

    expect(loads).toBe(1);
    expect(a).toEqual([{ id: 'job-1', n: 1 }]);
    expect(b).toEqual(a);
    await hub.close();
  });

  it('stops delivering after unsubscribe', async () => {
    const m = manualSource();
    const hub = new JobEventHub({
      source: m.source,
      loadSnapshot: async () => 1,
      logger,
      coalesceMs: 5,
    });
    await hub.start();
    const got: unknown[] = [];
    const off = hub.subscribe('j', (s) => got.push(s));
    off();
    m.emit('j');
    await wait(30);
    expect(got).toEqual([]);
    expect(hub.subscriberCount()).toBe(0);
    await hub.close();
  });

  it('reconnects after the LISTEN connection drops and refreshes watched jobs', async () => {
    const m = manualSource();
    const got: unknown[] = [];
    const hub = new JobEventHub({
      source: m.source,
      loadSnapshot: async (id) => id,
      logger,
      coalesceMs: 5,
      reconnectMs: 20,
    });
    await hub.start();
    hub.subscribe('j', (s) => got.push(s));
    m.fail(new Error('connection reset'));
    await wait(60);
    expect(m.listens()).toBe(2);
    expect(got).toEqual(['j']); // refreshed once after reconnecting, in case something was missed
    await hub.close();
  });
});

/** Minimal SSE reader over fetch: returns parsed events until the stream ends. */
async function readEvents(url: string, onEvent?: (e: { event: string; data: unknown }) => void) {
  const res = await fetch(url);
  const events: { event: string; data: unknown }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) {
        const e = { event, data: JSON.parse(data) as unknown };
        events.push(e);
        onEvent?.(e);
      }
    }
  }
  return { status: res.status, contentType: res.headers.get('content-type'), events };
}

describe('GET /jobs/:id/events (SSE)', () => {
  let db: DB;
  let pglite: PGlite;
  let app: FastifyInstance;
  let base: string;
  let uploadId: string;

  beforeAll(async () => {
    ({ db, pglite } = await createTestDatabase());
    uploadId = await seedUpload(db, 3);
    app = buildApp({
      config: loadConfig({ LOG_LEVEL: 'fatal' }),
      db,
      redis: {} as Redis,
      uploads: createUploadRepository(db),
      jobs: createJobRepository(db),
      scoring: createScoringRepository(db),
      notifications: pgliteNotificationSource(pglite),
      eventsOptions: { coalesceMs: 10, heartbeatMs: 1_000 },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });
  afterEach(() => resetJobs(db));

  it('streams a snapshot, then every change, then done, and closes', async () => {
    const job = await createJobRepository(db).start(uploadId);
    const queue = createTaskQueue(db);
    let started = false;

    const stream = readEvents(`${base}/jobs/${job.id}/events`, (e) => {
      if (started || e.event !== 'progress') return;
      started = true;
      // Drive the job to completion once the first snapshot arrived.
      void (async () => {
        for (let i = 0; i < 3; i++) {
          await queue.recordSuccess((await queue.claimNext(30_000))!, metrics, 1);
          await wait(30);
        }
        await finalizeFinishedJobs(db);
      })();
    });
    const { status, contentType, events } = await stream;

    expect(status).toBe(200);
    expect(contentType).toContain('text/event-stream');
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe('progress');
    expect(kinds.at(-1)).toBe('done');
    const succeeded = events.map(
      (e) => (e.data as { progress: { succeeded: number } }).progress.succeeded,
    );
    expect(succeeded[0]).toBe(0);
    expect(succeeded.at(-1)).toBe(3);
    // Counts only ever move forward.
    expect(succeeded).toEqual([...succeeded].sort((x, y) => x - y));
    expect((events.at(-1)!.data as { job: { status: string } }).job.status).toBe('COMPLETED');
  });

  it('sends the final state and closes straight away for a finished job', async () => {
    const job = await createJobRepository(db).start(uploadId);
    await sql`UPDATE enrichment_jobs SET status = 'FAILED_SYSTEMIC' WHERE id = ${job.id}`.execute(
      db,
    );
    const { events } = await readEvents(`${base}/jobs/${job.id}/events`);
    expect(events.map((e) => e.event)).toEqual(['progress', 'done']);
  });

  it('404s for an unknown job and 400s for a bad id, as normal JSON errors', async () => {
    const missing = await fetch(`${base}/jobs/66666666-6666-4666-8666-666666666666/events`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect((await fetch(`${base}/jobs/nope/events`)).status).toBe(400);
  });
});
