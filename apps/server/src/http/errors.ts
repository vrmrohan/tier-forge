import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * Every error response has the same shape:
 *   { "error": { "code": "INVALID_CSV_HEADER", "message": "...", "details": {...} } }
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown): AppError =>
  new AppError(400, code, message, details);

export const notFound = (message: string): AppError => new AppError(404, 'NOT_FOUND', message);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    // Fastify's own client errors (validation, payload too large, unsupported media type, ...).
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({
        error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
      });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    }),
  );
}
