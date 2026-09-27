import type { Readable } from 'node:stream';
import { parse, type Info } from 'csv-parse';
import { AppError, badRequest } from '../http/errors.js';

/** The contract from the brief. Order in the file doesn't matter; names do. */
export const REQUIRED_COLUMNS = [
  'store_id',
  'store_name',
  'address',
  'city',
  'state',
  'country',
] as const;
type Column = (typeof REQUIRED_COLUMNS)[number];

export type ParsedStore = Record<Column, string>;

export interface RowError {
  /** 1-based line number in the file, so users can find it in a spreadsheet. */
  line: number;
  storeId?: string;
  reason: string;
}

export interface ParseResult {
  stores: ParsedStore[];
  rejected: RowError[];
  /** Data rows seen (excluding the header and blank lines). */
  totalRows: number;
}

export interface ParseOptions {
  maxRows?: number;
  maxFieldLength?: number;
}

const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_MAX_FIELD_LENGTH = 500;

/**
 * Normalizes header names so files saved from Excel etc. still match:
 * BOM is stripped by the parser; here we trim and lowercase.
 */
export function normalizeHeader(name: string): string {
  return name.trim().toLowerCase();
}

/** Returns the index of each required column, or throws a 400 describing every header problem at once. */
export function validateHeader(rawHeader: readonly string[]): Record<Column, number> {
  const names = rawHeader.map(normalizeHeader);

  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicate.add(name);
    seen.add(name);
  }
  const required = new Set<string>(REQUIRED_COLUMNS);
  const missing = REQUIRED_COLUMNS.filter((c) => !seen.has(c));
  const unexpected = names.filter((n) => !required.has(n));

  if (missing.length || unexpected.length || duplicate.size) {
    const parts = [
      missing.length && `missing: ${missing.join(', ')}`,
      unexpected.length && `unexpected: ${unexpected.map((n) => n || '(blank)').join(', ')}`,
      duplicate.size && `duplicated: ${[...duplicate].join(', ')}`,
    ].filter(Boolean);
    throw badRequest('INVALID_CSV_HEADER', `CSV header is invalid (${parts.join('; ')})`, {
      expected: REQUIRED_COLUMNS,
      received: rawHeader,
      missing,
      unexpected,
      duplicated: [...duplicate],
    });
  }

  return Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, names.indexOf(c)])) as Record<
    Column,
    number
  >;
}

interface ParsedRecord {
  record: string[];
  info: Info;
}

/**
 * Streams a CSV and splits it into valid stores and per-row rejections.
 * Header problems and malformed CSV (e.g. an unclosed quote) reject the whole file;
 * individual bad rows are reported and skipped.
 */
export async function parseStoresCsv(
  input: Readable,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxFieldLength = options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;

  const parser = input.pipe(
    parse({
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true, // we report column-count problems per row instead of failing the file
      info: true,
    }),
  );

  let columns: Record<Column, number> | undefined;
  let headerWidth = 0;
  const stores: ParsedStore[] = [];
  const rejected: RowError[] = [];
  const seenIds = new Map<string, number>();
  let totalRows = 0;

  try {
    for await (const { record, info } of parser as AsyncIterable<ParsedRecord>) {
      if (!columns) {
        columns = validateHeader(record);
        headerWidth = record.length;
        continue;
      }

      totalRows += 1;
      if (totalRows > maxRows) {
        throw badRequest('CSV_TOO_LARGE', `CSV has more than ${maxRows} data rows`);
      }

      const line = info.lines;
      const storeId = record[columns.store_id] ?? '';
      const reject = (reason: string): void => {
        rejected.push(storeId ? { line, storeId, reason } : { line, reason });
      };

      if (record.length !== headerWidth) {
        reject(`expected ${headerWidth} columns, found ${record.length}`);
        continue;
      }

      const store = Object.fromEntries(
        REQUIRED_COLUMNS.map((c) => [c, record[columns![c]] ?? '']),
      ) as ParsedStore;

      const empty = REQUIRED_COLUMNS.filter((c) => store[c] === '');
      if (empty.length) {
        reject(`empty value for ${empty.join(', ')}`);
        continue;
      }
      const tooLong = REQUIRED_COLUMNS.filter((c) => store[c].length > maxFieldLength);
      if (tooLong.length) {
        reject(`value longer than ${maxFieldLength} characters for ${tooLong.join(', ')}`);
        continue;
      }

      const firstLine = seenIds.get(store.store_id);
      if (firstLine !== undefined) {
        reject(`duplicate store_id (first seen on line ${firstLine})`);
        continue;
      }
      seenIds.set(store.store_id, line);
      stores.push(store);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && 'code' in error && String(error.code).startsWith('CSV_')) {
      // csv-parse error, e.g. CSV_QUOTE_NOT_CLOSED
      throw badRequest('MALFORMED_CSV', `CSV could not be parsed: ${error.message}`);
    }
    throw error;
  }

  if (!columns) {
    throw badRequest('EMPTY_CSV', 'CSV file is empty');
  }
  return { stores, rejected, totalRows };
}
