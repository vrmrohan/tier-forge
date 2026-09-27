import { ScoringConfigSchema, TIERS } from '@tierforge/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, notFound } from '../http/errors.js';
import { parseInput } from '../http/validation.js';
import type { JobRepository } from '../jobs/job.repository.js';
import type { ScoringRepository } from './scoring.repository.js';

const JobParams = z.object({ id: z.string().uuid() });
const RunParams = z.object({ id: z.string().uuid(), runId: z.string().uuid() });
const StoresQuery = z.object({
  run: z.string().uuid().optional(),
  tier: z.enum(TIERS).optional(),
  sort: z.enum(['score', 'storeId', 'footfall', 'revenue', 'sizeSqft']).default('score'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerScoringRoutes(
  app: FastifyInstance,
  jobs: JobRepository,
  scoring: ScoringRepository,
): void {
  async function requireJob(id: string) {
    const job = await jobs.findById(id);
    if (!job) throw notFound(`Job ${id} not found`);
    return job;
  }

  /**
   * Scores and tiers every enriched store with the given bars, weights and cut-offs.
   * Uses stored metrics only (no API calls). Allowed while the job is still running:
   * the response says how many of the job's stores were scored.
   */
  app.post('/jobs/:id/scoring-runs', async (request, reply) => {
    const { id } = parseInput(JobParams, request.params, 'job id');
    const config = parseInput(ScoringConfigSchema, request.body, 'scoring config');
    const job = await requireJob(id);

    const run = await scoring.run(id, config);
    return reply.code(201).send({
      run,
      jobStatus: job.status,
      totalStores: job.total,
      /** True when enrichment was still running, so later-enriched stores aren't in this run. */
      partial: job.status === 'RUNNING',
    });
  });

  app.get('/jobs/:id/scoring-runs/latest', async (request) => {
    const { id } = parseInput(JobParams, request.params, 'job id');
    await requireJob(id);
    const run = await scoring.latestRun(id);
    if (!run) throw new AppError(404, 'NO_SCORING_RUN', 'This job has not been scored yet');
    return { run };
  });

  app.get('/jobs/:id/scoring-runs/:runId', async (request) => {
    const { id, runId } = parseInput(RunParams, request.params, 'ids');
    await requireJob(id);
    const run = await scoring.findRun(id, runId);
    if (!run) throw notFound(`Scoring run ${runId} not found`);
    return { run };
  });

  /**
   * Enriched stores with metrics, score and tier (from `run`, default: the latest run),
   * filterable by tier, sortable, paginated.
   */
  app.get('/jobs/:id/stores', async (request) => {
    const { id } = parseInput(JobParams, request.params, 'job id');
    const query = parseInput(StoresQuery, request.query, 'query');
    await requireJob(id);

    const run = query.run ? await scoring.findRun(id, query.run) : await scoring.latestRun(id);
    if (query.run && !run) throw notFound(`Scoring run ${query.run} not found`);
    if (query.tier && !run) {
      throw new AppError(409, 'NO_SCORING_RUN', 'Score the job before filtering by tier');
    }

    const page = await scoring.listStores({
      jobId: id,
      ...(run ? { runId: run.id } : {}),
      ...(query.tier ? { tier: query.tier } : {}),
      sort: query.sort,
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return { runId: run?.id ?? null, ...page, limit: query.limit, offset: query.offset };
  });
}
