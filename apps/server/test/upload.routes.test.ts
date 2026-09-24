import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { DB } from '../src/db/database.js';
import type { JobRepository } from '../src/jobs/job.repository.js';
import type { ScoringRepository } from '../src/scoring/scoring.repository.js';
import type { ParsedStore } from '../src/uploads/csv-parser.js';
import type { UploadRepository, UploadSummary } from '../src/uploads/upload.repository.js';
import { HEADER, multipartBody } from './helpers.js';

/** In-memory repository: route tests exercise HTTP + parsing without a database. */
class FakeUploads implements UploadRepository {
  readonly saved = new Map<string, { summary: UploadSummary; stores: readonly ParsedStore[] }>();

  async create(filename: string, stores: readonly ParsedStore[]): Promise<UploadSummary> {
    const summary = {
      id: '11111111-1111-4111-8111-111111111111',
      filename,
      rowCount: stores.length,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    this.saved.set(summary.id, { summary, stores });
    return summary;
  }

  async findById(id: string): Promise<UploadSummary | undefined> {
    return this.saved.get(id)?.summary;
  }
}

describe('upload routes', () => {
  let app: FastifyInstance;
  let uploads: FakeUploads;

  beforeEach(async () => {
    uploads = new FakeUploads();
    app = buildApp({
      config: loadConfig({ LOG_LEVEL: 'fatal' }),
      db: {} as DB,
      redis: {} as Redis,
      uploads,
      jobs: {} as JobRepository,
      scoring: {} as ScoringRepository,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const upload = (filename: string, content: string, field?: string) =>
    app.inject({ method: 'POST', url: '/uploads', ...multipartBody(filename, content, field) });

  it('stores valid rows and reports rejected ones', async () => {
    const csv = `${HEADER}\nST1,Shop A,1 Main St,Pune,MH,India\n,Shop B,2 Main St,Pune,MH,India\n`;
    const res = await upload('stores.csv', csv);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      upload: { filename: 'stores.csv', rowCount: 1 },
      totalRows: 2,
      acceptedRows: 1,
      rejectedRows: 1,
      errors: [{ line: 3, reason: 'empty value for store_id' }],
      errorsTruncated: false,
    });
    expect([...uploads.saved.values()][0]?.stores).toHaveLength(1);
  });

  it('returns 400 with a clear message for a bad header and stores nothing', async () => {
    const res = await upload('stores.csv', 'id,name,city\nST1,Shop,Pune\n');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CSV_HEADER');
    expect(res.json().error.details.missing).toContain('store_id');
    expect(uploads.saved.size).toBe(0);
  });

  it('returns 400 when no row is valid', async () => {
    const res = await upload('stores.csv', `${HEADER}\n,,,,,\n`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NO_VALID_ROWS');
  });

  it('rejects non-CSV files', async () => {
    const res = await upload('stores.xlsx', 'binary');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_A_CSV');
  });

  it('rejects a file sent under the wrong field name', async () => {
    const res = await upload('stores.csv', `${HEADER}\n`, 'upload');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_FILE');
  });

  it('rejects a non-multipart request', async () => {
    const res = await app.inject({ method: 'POST', url: '/uploads', payload: { a: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EXPECTED_MULTIPART');
  });

  it('fetches an upload by id, and 404s for unknown ids', async () => {
    await upload('stores.csv', `${HEADER}\nST1,Shop A,1 Main St,Pune,MH,India\n`);
    const found = await app.inject({ url: '/uploads/11111111-1111-4111-8111-111111111111' });
    expect(found.statusCode).toBe(200);
    expect(found.json().upload.rowCount).toBe(1);

    const missing = await app.inject({ url: '/uploads/22222222-2222-4222-8222-222222222222' });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({ url: '/uploads/not-a-uuid' });
    expect(invalid.statusCode).toBe(400);
  });
});
