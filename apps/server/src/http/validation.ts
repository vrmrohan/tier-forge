import type { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Parses request input or throws a 400 listing every problem with its path, e.g.
 * { "path": "weights", "message": "weights must add up to 100 (currently 99)" }.
 */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      'INVALID_REQUEST',
      `Invalid ${what}`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
