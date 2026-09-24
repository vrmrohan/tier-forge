import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpEnrichmentClient } from '../src/enrichment/enrichment-client.js';
import type { StoreInput } from '../src/enrichment/types.js';

const store: StoreInput = {
  store_id: 'ST000001',
  store_name: 'Fresh Supermarket #1',
  address: '71 Church Street',
  city: 'New Delhi',
  state: 'Delhi',
};

/** A tiny fake Enrichment API whose behavior is chosen by the store_id suffix. */
let server: Server;
let baseUrl: string;
let lastBody: unknown;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw);
      const { store_id } = lastBody as { store_id: string };
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (store_id.endsWith('-429')) return send(429, { detail: 'Rate limit exceeded' });
      if (store_id.endsWith('-500')) return send(500, { detail: 'Transient upstream error' });
      if (store_id.endsWith('-422')) return send(422, { detail: [{ msg: 'Field required' }] });
      if (store_id.endsWith('-hang')) return; // never answers
      if (store_id.endsWith('-bad')) return send(200, { store_id, oops: true });
      if (store_id.endsWith('-other')) return send(200, { ...ok('ST999999') });
      return send(200, ok(store_id));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const ok = (id: string) => ({
  store_id: id,
  estimated_monthly_footfall: 18234,
  estimated_monthly_revenue: 142033.5,
  store_size_sqft: 6210,
});

const client = () => createHttpEnrichmentClient({ baseUrl, timeoutMs: 300 });
const withId = (suffix: string): StoreInput => ({ ...store, store_id: `ST000001${suffix}` });

describe('HTTP enrichment client', () => {
  it('returns metrics on success and sends only the documented fields', async () => {
    const outcome = await client().enrich(store);
    expect(outcome).toEqual({
      kind: 'success',
      httpStatus: 200,
      metrics: { footfall: 18234, revenue: 142033.5, sizeSqft: 6210 },
    });
    expect(lastBody).toEqual(store);
  });

  it('maps 429, 5xx and 4xx to distinct outcomes', async () => {
    expect(await client().enrich(withId('-429'))).toEqual({
      kind: 'rate_limited',
      httpStatus: 429,
    });
    expect(await client().enrich(withId('-500'))).toEqual({
      kind: 'server_error',
      httpStatus: 500,
      message: 'Transient upstream error',
    });
    expect(await client().enrich(withId('-422'))).toMatchObject({
      kind: 'client_error',
      httpStatus: 422,
    });
  });

  it('gives up on a hanging call after the timeout', async () => {
    const started = performance.now();
    const outcome = await client().enrich(withId('-hang'));
    expect(outcome).toEqual({ kind: 'timeout', timeoutMs: 300 });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('rejects bodies that break the contract or belong to another store', async () => {
    expect(await client().enrich(withId('-bad'))).toMatchObject({ kind: 'invalid_response' });
    expect(await client().enrich(withId('-other'))).toMatchObject({
      kind: 'invalid_response',
      message: expect.stringContaining('expected ST000001-other'),
    });
  });

  it('reports a network error when nothing is listening', async () => {
    const dead = createHttpEnrichmentClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1_000 });
    expect(await dead.enrich(store)).toMatchObject({ kind: 'network_error' });
  });
});
