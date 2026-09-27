import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import { parseStoresCsv, validateHeader } from '../src/uploads/csv-parser.js';
import { HEADER, csvStream } from './helpers.js';

const SAMPLE_CSV = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/stores_5000.csv',
);

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('validateHeader', () => {
  it('accepts the exact columns in any order', () => {
    const idx = validateHeader(['country', 'store_id', 'store_name', 'address', 'city', 'state']);
    expect(idx.store_id).toBe(1);
    expect(idx.country).toBe(0);
  });

  it('tolerates padding and different case', () => {
    expect(() =>
      validateHeader([' Store_ID ', 'STORE_NAME', 'Address', 'city', 'state ', ' country']),
    ).not.toThrow();
  });

  it('names every missing, unexpected and duplicated column in one error', () => {
    try {
      validateHeader(['store_id', 'store_name', 'adress', 'city', 'city', 'country']);
      expect.unreachable();
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe('INVALID_CSV_HEADER');
      expect(err.message).toContain('missing: address, state');
      expect(err.message).toContain('unexpected: adress');
      expect(err.message).toContain('duplicated: city');
    }
  });
});

describe('parseStoresCsv', () => {
  it('parses the provided 5,000-row sample with no rejections', async () => {
    const result = await parseStoresCsv(createReadStream(SAMPLE_CSV));
    expect(result.totalRows).toBe(5000);
    expect(result.stores).toHaveLength(5000);
    expect(result.rejected).toEqual([]);
    expect(result.stores[0]).toEqual({
      store_id: 'ST000001',
      store_name: 'Fresh Supermarket #1',
      address: '71 Church Street',
      city: 'New Delhi',
      state: 'Delhi',
      country: 'India',
    });
  });

  it('handles an Excel-style file: BOM, CRLF, padded values, blank lines', async () => {
    const text = `\uFEFF${HEADER}\r\n ST1 , Shop A ,1 Main St,Pune,MH,India\r\n\r\nST2,Shop B,2 Main St,Pune,MH,India\r\n`;
    const result = await parseStoresCsv(csvStream(text));
    expect(result.stores.map((s) => s.store_id)).toEqual(['ST1', 'ST2']);
    expect(result.stores[0]?.store_name).toBe('Shop A');
  });

  it('supports quoted fields containing commas', async () => {
    const text = `${HEADER}\nST1,"Shop, The Big One","1, Main St",Pune,MH,India\n`;
    const result = await parseStoresCsv(csvStream(text));
    expect(result.stores[0]?.store_name).toBe('Shop, The Big One');
  });

  it('rejects bad rows with line numbers and keeps the good ones', async () => {
    const text = [
      HEADER,
      'ST1,Shop A,1 Main St,Pune,MH,India', // line 2 ok
      ',Shop B,2 Main St,Pune,MH,India', // line 3 empty store_id
      'ST3,Shop C,3 Main St,Pune,MH', // line 4 too few columns
      'ST1,Shop A again,1 Main St,Pune,MH,India', // line 5 duplicate
      'ST5,Shop E,,Pune,,India', // line 6 empty address + state
      'ST6,Shop F,6 Main St,Pune,MH,India', // line 7 ok
    ].join('\n');
    const result = await parseStoresCsv(csvStream(text));

    expect(result.totalRows).toBe(6);
    expect(result.stores.map((s) => s.store_id)).toEqual(['ST1', 'ST6']);
    expect(result.rejected).toEqual([
      { line: 3, reason: 'empty value for store_id' },
      { line: 4, storeId: 'ST3', reason: 'expected 6 columns, found 5' },
      { line: 5, storeId: 'ST1', reason: 'duplicate store_id (first seen on line 2)' },
      { line: 6, storeId: 'ST5', reason: 'empty value for address, state' },
    ]);
  });

  it('rejects over-long values', async () => {
    const text = `${HEADER}\nST1,${'x'.repeat(20)},1 Main St,Pune,MH,India\n`;
    const result = await parseStoresCsv(csvStream(text), { maxFieldLength: 10 });
    expect(result.rejected[0]?.reason).toBe('value longer than 10 characters for store_name');
  });

  it('fails the whole file on an invalid header before reading rows', async () => {
    await expectAppError(parseStoresCsv(csvStream('id,name\nST1,Shop A\n')), 'INVALID_CSV_HEADER');
  });

  it('fails on an empty file', async () => {
    await expectAppError(parseStoresCsv(csvStream('')), 'EMPTY_CSV');
  });

  it('fails on malformed CSV such as an unclosed quote', async () => {
    await expectAppError(
      parseStoresCsv(csvStream(`${HEADER}\nST1,"Shop A,1 Main St,Pune,MH,India\n`)),
      'MALFORMED_CSV',
    );
  });

  it('enforces the row limit', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => `ST${i},S,A,C,S,India`);
    await expectAppError(
      parseStoresCsv(csvStream([HEADER, ...rows].join('\n')), { maxRows: 2 }),
      'CSV_TOO_LARGE',
    );
  });

  it('returns no stores for a header-only file', async () => {
    const result = await parseStoresCsv(csvStream(`${HEADER}\n`));
    expect(result).toEqual({ stores: [], rejected: [], totalRows: 0 });
  });
});
