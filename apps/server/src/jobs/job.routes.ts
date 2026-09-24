import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../http/errors.js';
import type { JobRepository } from './job.repository.js';

const StartJobBody = z.object({ uploadId: z.string().uuid() });
const JobParams = z.object({ id: z.string().uuid() });
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest('INVALID_REQUEST', `Invalid ${what}`, z.flattenError(result.error));
  }
  return result.data;
}

export function registerJobRoutes(app: FastifyInstance, jobs: JobRepository): void {
  /** Starts enriching every store of an upload. 409 if a job is already running. */
  app.post('/jobs', async (request, reply) => {
    const { uploadId } = parse(StartJobBody, request.body, 'body');
    const job = await jobs.start(uploadId);
    return reply.code(201).send({ job, progress: await jobs.progress(job.id) });
  });

  app.get('/jobs', async () => ({ jobs: await jobs.list() }));

  /** Job status plus live counts: enriched / failed / pending / in flight. */
  app.get('/jobs/:id', async (request) => {
    const { id } = parse(JobParams, request.params, 'job id');
    const job = await jobs.findById(id);
    if (!job) throw notFound(`Job ${id} not found`);
    return { job, progress: await jobs.progress(id) };
  });

  /** Stores that ultimately failed, with the reason. */
  app.get('/jobs/:id/failures', async (request) => {
    const { id } = parse(JobParams, request.params, 'job id');
    const { limit, offset } = parse(Page, request.query, 'query');
    if (!(await jobs.findById(id))) throw notFound(`Job ${id} not found`);
    return { ...(await jobs.failures(id, limit, offset)), limit, offset };
  });
}
