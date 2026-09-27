import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../http/errors.js';
import { parseStoresCsv } from './csv-parser.js';
import type { UploadRepository } from './upload.repository.js';

/** Row errors returned inline; the counts always cover all of them. */
const MAX_ERRORS_IN_RESPONSE = 100;

const UploadParams = z.object({ id: z.string().uuid() });

export function registerUploadRoutes(app: FastifyInstance, uploads: UploadRepository): void {
  /**
   * POST /uploads  (multipart/form-data, field "file")
   * Validates the header before storing anything, keeps valid rows, reports rejected ones.
   */
  app.post('/uploads', async (request, reply) => {
    if (!request.isMultipart()) {
      throw badRequest(
        'EXPECTED_MULTIPART',
        'Send the CSV as multipart/form-data in a "file" field',
      );
    }
    const file = await request.file();
    if (!file || file.fieldname !== 'file') {
      throw badRequest('MISSING_FILE', 'No file found in the "file" field');
    }
    if (!file.filename.toLowerCase().endsWith('.csv')) {
      file.file.resume(); // drain so the request completes
      throw badRequest('NOT_A_CSV', `Expected a .csv file, got "${file.filename}"`);
    }

    const { stores, rejected, totalRows } = await parseStoresCsv(file.file);

    if (stores.length === 0) {
      throw badRequest('NO_VALID_ROWS', 'The CSV has no valid store rows', {
        totalRows,
        rejectedRows: rejected.length,
        errors: rejected.slice(0, MAX_ERRORS_IN_RESPONSE),
      });
    }

    const upload = await uploads.create(file.filename, stores);
    request.log.info(
      { uploadId: upload.id, accepted: stores.length, rejected: rejected.length },
      'csv uploaded',
    );

    return reply.code(201).send({
      upload,
      totalRows,
      acceptedRows: stores.length,
      rejectedRows: rejected.length,
      errors: rejected.slice(0, MAX_ERRORS_IN_RESPONSE),
      errorsTruncated: rejected.length > MAX_ERRORS_IN_RESPONSE,
    });
  });

  app.get('/uploads/:id', async (request) => {
    const parsed = UploadParams.safeParse(request.params);
    if (!parsed.success) throw badRequest('INVALID_ID', 'Upload id must be a UUID');
    const upload = await uploads.findById(parsed.data.id);
    if (!upload) throw notFound(`Upload ${parsed.data.id} not found`);
    return { upload };
  });
}
