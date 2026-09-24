import { z } from 'zod';
import type { EnrichmentOutcome, StoreInput } from './types.js';

const EnrichResponse = z.object({
  store_id: z.string(),
  estimated_monthly_footfall: z.number().int().nonnegative(),
  estimated_monthly_revenue: z.number().nonnegative(),
  store_size_sqft: z.number().int().nonnegative(),
});

export interface EnrichmentClient {
  enrich(store: StoreInput): Promise<EnrichmentOutcome>;
}

export interface HttpEnrichmentClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/** Keeps error text short enough for a DB column and a UI cell. */
const clip = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

async function readDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === 'string') return clip(body.detail);
    if (body.detail !== undefined) return clip(JSON.stringify(body.detail));
  } catch {
    // not JSON; fall through
  }
  return clip(text || res.statusText);
}

/**
 * Calls POST /enrich with a hard client-side timeout. The timeout aborts the request,
 * so a 50 s hang frees the worker after `timeoutMs` instead of holding it.
 */
export function createHttpEnrichmentClient(options: HttpEnrichmentClientOptions): EnrichmentClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL('/enrich', options.baseUrl).toString();

  return {
    async enrich(store) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            store_id: store.store_id,
            store_name: store.store_name,
            address: store.address,
            city: store.city,
            state: store.state,
          }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          return { kind: 'timeout', timeoutMs: options.timeoutMs };
        }
        const cause = error instanceof Error ? (error.cause ?? error) : error;
        const message = cause instanceof Error ? cause.message : String(cause);
        return { kind: 'network_error', message: clip(message) };
      }

      if (res.status === 429) {
        await res.body?.cancel();
        return { kind: 'rate_limited', httpStatus: 429 };
      }
      if (res.status >= 500) {
        return { kind: 'server_error', httpStatus: res.status, message: await readDetail(res) };
      }
      if (res.status >= 400) {
        return { kind: 'client_error', httpStatus: res.status, message: await readDetail(res) };
      }

      let parsed: z.infer<typeof EnrichResponse>;
      try {
        const body: unknown = await res.json();
        const result = EnrichResponse.safeParse(body);
        if (!result.success) {
          return {
            kind: 'invalid_response',
            httpStatus: res.status,
            message: clip(
              `response did not match contract: ${result.error.issues[0]?.message ?? ''}`,
            ),
          };
        }
        parsed = result.data;
      } catch (error) {
        // Body stream timed out or wasn't JSON.
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          return { kind: 'timeout', timeoutMs: options.timeoutMs };
        }
        return {
          kind: 'invalid_response',
          httpStatus: res.status,
          message: 'response was not JSON',
        };
      }

      if (parsed.store_id !== store.store_id) {
        return {
          kind: 'invalid_response',
          httpStatus: res.status,
          message: `response was for store ${parsed.store_id}, expected ${store.store_id}`,
        };
      }

      return {
        kind: 'success',
        httpStatus: 200,
        metrics: {
          footfall: parsed.estimated_monthly_footfall,
          revenue: parsed.estimated_monthly_revenue,
          sizeSqft: parsed.store_size_sqft,
        },
      };
    },
  };
}
