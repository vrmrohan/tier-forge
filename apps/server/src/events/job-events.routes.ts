import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { notFound } from '../http/errors.js';
import { parseInput } from '../http/validation.js';
import { isTerminalStatus, type JobRepository, type JobSnapshot } from '../jobs/job.repository.js';
import type { JobEventHub } from './job-event-hub.js';

const JobParams = z.object({ id: z.string().uuid() });

export interface JobEventsOptions {
  /** Comment line sent on idle streams so proxies don't close them. */
  heartbeatMs?: number;
  /** Tells EventSource how long to wait before reconnecting. */
  retryMs?: number;
}

/**
 * GET /jobs/:id/events — Server-Sent Events for live job progress.
 *
 *   event: progress   data: { job, progress }   on connect, then on every change
 *   event: done       data: { job, progress }   once the job reaches a final state; stream ends
 *
 * Changes arrive via Postgres NOTIFY (see JobEventHub), so nothing polls the database.
 */
export function registerJobEventRoutes(
  app: FastifyInstance,
  jobs: JobRepository,
  hub: JobEventHub<JobSnapshot>,
  options: JobEventsOptions = {},
): void {
  const open = new Set<ServerResponse>();
  app.addHook('onClose', async () => {
    for (const res of open) res.end();
    open.clear();
  });

  app.get('/jobs/:id/events', async (request, reply) => {
    const { id } = parseInput(JobParams, request.params, 'job id');

    // Subscribe before reading the snapshot, so a change in between isn't missed.
    const buffered: JobSnapshot[] = [];
    let deliver: (s: JobSnapshot) => void = (s) => buffered.push(s);
    const unsubscribe = hub.subscribe(id, (s) => deliver(s));

    const first = await jobs.snapshot(id).catch((error: unknown) => {
      unsubscribe();
      throw error;
    });
    if (!first) {
      unsubscribe();
      throw notFound(`Job ${id} not found`);
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    open.add(res);

    let seq = 0;
    let finished = false;
    const send = (event: 'progress' | 'done', data: JobSnapshot): void => {
      res.write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), options.heartbeatMs ?? 15_000);
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(res);
      res.end();
    };
    request.raw.on('close', finish);

    const push = (s: JobSnapshot): void => {
      if (finished) return;
      send('progress', s);
      if (isTerminalStatus(s.job.status)) {
        send('done', s);
        finish();
      }
    };

    res.write(`retry: ${options.retryMs ?? 5_000}\n\n`);
    push(first);
    deliver = push;
    for (const s of buffered) push(s);
  });
}
