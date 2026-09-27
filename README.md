# TierForge

Resilient bulk store scoring and tiering. TierForge ingests a CSV of stores, enriches each one through a slow,
rate-limited and flaky Enrichment API, then scores and tiers every store (Large / Medium / Small) from
user-configured bars and weights.

> Status: complete for the brief: CSV upload, resilient enrichment, scoring and tiering, and a live web dashboard.
> Not production-hardened yet; see [Known limitations](#known-limitations) and [Path to production](#path-to-production).

## Prerequisites

- Node.js 22+ (`.nvmrc` provided)
- Docker Desktop (for Postgres, Redis and the simulator)
- The provided `enrichment_simulator/` folder next to this repo (or set `SIMULATOR_DIR`)

```
sigmoid/
├── enrichment_simulator/   # provided, run unmodified
└── tier-forge/             # this repo
```

## Run locally

```bash
cp .env.example .env
npm install
npm run infra:up          # Postgres :5432, Redis :6379, simulator :8000
npm run db:migrate        # create the schema
npm run dev:server        # API on :3000 (terminal 1)
npm run dev:web           # dashboard on http://localhost:5173 (terminal 2)
```

Stop the infrastructure with `npm run infra:down` (add `-v` to `docker compose down` to wipe the database).

## Repository layout

| Path                            | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `apps/server`                   | Fastify API and enrichment workers (Node + TypeScript)        |
| `apps/server/src/db/migrations` | Kysely migrations; the schema's source of truth               |
| `packages/shared`               | Scoring rules and config validation shared by API and web app |
| `apps/server/src/db/schema.ts`  | Table types used by Kysely, kept in sync with migrations      |
| `apps/web`                      | React + Vite dashboard                                        |
| `docker-compose.yml`            | Postgres 16, Redis 7 and the simulator                        |

## Scripts

| Command                | What it does                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run infra:up`     | Start Postgres, Redis and the simulator                                                                                                                       |
| `npm run db:migrate`   | Apply all migrations                                                                                                                                          |
| `npm run dev:server`   | Run the API with reload                                                                                                                                       |
| `npm run dev:web`      | Run the dashboard (proxies `/api` to the API)                                                                                                                 |
| `npm test`             | Unit + Postgres tests (in-process PGlite, no Docker needed); the Redis limiter test also runs when Redis is reachable on `localhost:6379` or `TEST_REDIS_URL` |
| `npm run typecheck`    | TypeScript checks for every workspace                                                                                                                         |
| `npm run lint`         | ESLint                                                                                                                                                        |
| `npm run format:check` | Prettier                                                                                                                                                      |

## Dashboard

One page, four steps, at `http://localhost:5173`:

1. **Upload store list.** Header problems are listed by column; skipped rows show their line and reason.
2. **Enrichment.** Live progress pushed over Server-Sent Events (falls back to polling every 5 s
   only while the stream is unavailable): enriched, failed, pending and in flight, with the time
   since the last progress. Failed stores are listed with attempts and the reason. A
   systemically stopped job shows why.
3. **Score & tier.** Bars, weights and cut-offs, checked while you type with the same rules the API
   uses (`@tierforge/shared`), e.g. the weight total turns red until it reaches 100%. Can run
   mid-job; the page says how many stores were enriched since.
4. **Results.** Tier counts, a 100% bar, and the store list: filter by tier, sort by any metric or
   score, paginated. Each metric shows `✓+N` when the store clears that bar and the weight it adds.

The job being viewed is in the URL (`?job=…`), so a reload or a shared link keeps it. Works in light
and dark mode and down to 320 px wide.

## API

### `POST /uploads`

Multipart form with the CSV in a `file` field. The sample file is in `data/stores_5000.csv`.

```bash
curl -F file=@data/stores_5000.csv localhost:3000/uploads
```

- **Header check first.** Column names are matched after stripping a BOM, trimming and lowercasing, in
  any order. Missing, unexpected or duplicated columns reject the whole file with `400 INVALID_CSV_HEADER`
  naming each problem; nothing is stored.
- **Row checks.** Rows with the wrong column count, an empty value, a value over 500 characters, or a
  repeated `store_id` (first one wins) are skipped and reported with their line number.
- Valid rows are saved in one transaction. The response (`201`) has `acceptedRows`, `rejectedRows` and up
  to 100 row `errors`. A file with no valid rows returns `400 NO_VALID_ROWS`.
- Limits: 20 MB per file, 100,000 rows.

### `GET /uploads/:id`

Returns the upload's id, filename, row count and creation time.

### `POST /jobs`

Body `{ "uploadId": "<uuid>" }`. Creates a job with one task per store and starts enriching in the
background. Returns `409 JOB_ALREADY_RUNNING` if another job is still active.

```bash
curl -X POST localhost:3000/jobs -H 'content-type: application/json' -d '{"uploadId":"<id>"}'
```

### `GET /jobs/:id`

Job status (`RUNNING`, `COMPLETED`, `COMPLETED_WITH_FAILURES`, `FAILED_SYSTEMIC`) and live counts:
`total`, `pending`, `inFlight`, `succeeded`, `failed`, `aborted`, plus `lastProgressAt`.

### `GET /jobs/:id/events` (Server-Sent Events)

Live progress for one job. Sends `event: progress` with `{ job, progress }` on connect and on every
change, then `event: done` when the job reaches a final state, and closes. A `: ping` comment every
15 s keeps proxies from dropping an idle stream; `retry: 5000` tells the browser how soon to
reconnect.

```bash
curl -N localhost:3000/jobs/<jobId>/events
```

### `GET /jobs/:id/failures?limit=50&offset=0`

Stores that ultimately failed, each with attempts, the last HTTP status and the reason.

### `GET /jobs`

The 20 most recent jobs.

### `POST /jobs/:id/scoring-runs`

Scores and tiers every enriched store. Reads stored metrics only (never calls the Enrichment API),
runs in one transaction, and can be repeated whenever the settings change.

```json
{
  "bars": { "footfall": 15000, "revenue": 150000, "sizeSqft": 8000 },
  "weights": { "footfall": 50, "revenue": 30, "sizeSqft": 20 },
  "tiers": { "large": 70, "medium": 40 }
}
```

- **Score** = sum of the weights of the bars a store clears (value ≥ bar), so 0–100.
- **Tier** = `LARGE` if score ≥ `large`, `MEDIUM` if score ≥ `medium`, else `SMALL`.
- Weights are whole numbers adding up to exactly 100; `medium` must be below `large`. Invalid input
  returns `400` listing every problem, e.g. `weights must add up to 100 (currently 90)`.
- Returns the run with its tier counts. Allowed while enrichment is still running; `partial: true`
  then says later-enriched stores aren't included.
- Each run keeps its own settings and results, so earlier breakdowns stay reproducible.

### `GET /jobs/:id/scoring-runs/latest` and `GET /jobs/:id/scoring-runs/:runId`

A run's settings, number of stores scored and tier counts.

### `GET /jobs/:id/stores?tier=LARGE&sort=score&order=desc&limit=50&offset=0`

Enriched stores with name, city, footfall, revenue, size, score and tier, from the latest run (or
`run=<id>`). Filter by `tier`; sort by `score`, `storeId`, `footfall`, `revenue` or `sizeSqft`.

All errors share one shape: `{ "error": { "code", "message", "details"? } }`.

## Architecture (summary)

Two pipelines that share only the database:

- **Enrichment (slow, unreliable):** a Postgres-backed task queue. Workers claim tasks with
  `FOR UPDATE SKIP LOCKED` under a time-limited lease, call the API through a Redis rate limiter
  (4 calls/s, evenly spaced, below the simulator's fixed-window 5 req/s), and write results guarded by the
  lease token so late responses from reclaimed attempts are discarded.
- **Scoring (fast, deterministic):** one pass over stored metrics with the shared scoring function.
  Never calls the API and can be re-run any time.

### Schema decisions already enforced by the database

- Only one `QUEUED`/`RUNNING` job at a time (partial unique index).
- A task is leased if and only if it is `IN_FLIGHT` (check constraint).
- One task per store per job; one metrics row per store per job.
- Scoring weights are whole numbers that must sum to 100; tier cut-offs must satisfy `0 ≤ medium < large ≤ 100`.
- Job progress is counted from task rows; there are no counter columns to drift.

### Enrichment engine

Each worker loop (8 by default, inside the API process) repeats:

1. **Take a rate-limit slot.** A Lua script in Redis hands out slots 250 ms apart using Redis' own
   clock, so every worker and process shares one limit. If Redis is down this fails, and the worker
   backs off without calling the API (fail closed).
2. **Claim a task.** `FOR UPDATE SKIP LOCKED` picks the next due `PENDING` task of a `RUNNING` job,
   sets it `IN_FLIGHT` with a new lease token and a 30 s lease, and counts the attempt. Committed
   immediately: no transaction stays open during the API call.
3. **Call the API** with a 10 s timeout. The client never throws; every result is a typed outcome
   (success, 429, 5xx, 4xx, timeout, network error, invalid body).
4. **Record the result** in one transaction, guarded by the lease token. Success saves metrics and
   marks the task `SUCCEEDED`. A failure either schedules a retry with exponential backoff and jitter
   (0.5–1 s, 1–2 s, 2–4 s … up to 30 s) or fails the task: at once for a 4xx other than 429, or after
   5 attempts otherwise. A result whose lease was reclaimed changes nothing and is logged as
   `STALE_IGNORED`.
5. **Close the job** once no task is pending or in flight: it becomes `COMPLETED` or
   `COMPLETED_WITH_FAILURES`. The check runs after each result commits, so the last finished task
   always sees the job as done. A conditional update (`WHERE status = 'RUNNING'`) makes sure only
   one worker closes it, even if two finish at the same moment.

Two background safeguards run alongside the workers:

- **Lease reaper** (on startup and every 5 s): a task still `IN_FLIGHT` after its 30 s lease belongs to
  a worker that stopped responding (crash, restart, hung process). It goes back to `PENDING`, or to
  `FAILED` if that was its last attempt. If the lost worker's answer arrives later, the lease-token
  guard discards it.
- **Circuit breaker:** if the API returns nothing but 5xx, timeouts, network errors or bad bodies for
  30 s straight (and at least 10 of them), the run is systemically broken. The job becomes
  `FAILED_SYSTEMIC` with the reason, and every unfinished task becomes `ABORTED`, in one transaction.
  Any success resets the count, so the simulator's normal ~12% noise and short outages never trip it.
  429s and other 4xx are ignored: they describe our requests, not the API's health.

**Retries wait behind fresh work.** The queue hands out the task that has been due longest. Fresh tasks
became due when the job started, so a task scheduled for a retry runs after the fresh work ahead of it.
New stores keep flowing and retries get natural extra spacing; the tail of a job is mostly retries.

Every attempt is also recorded in `enrichment_attempts` (outcome, HTTP status, latency, error). This table
is an addition beyond the brief and is **write-only**: no endpoint, screen or retry decision reads it, because
everything the engine needs lives on the task row. It exists for debugging (why did a store fail after 5
tries?), for the measurements below, and as proof that stale answers were discarded (`STALE_IGNORED`).
Dropping it would not change how the system behaves.

### Measured against the simulator

| Scenario                                                             | Result                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 5,000 stores, normal run                                             | 24 min; 4,999 succeeded, 1 failed after 5 attempts (four 500s and a timeout); zero 429s                     |
| 300 stores                                                           | 90 s; all succeeded; 33 transient 500s and 5 hangs retried; zero 429s                                       |
| Worker killed with `kill -9` mid-job, new worker started             | In-flight task reclaimed; 100/100 succeeded; one metrics row per store                                      |
| Simulator down for 12 s mid-job                                      | Progress paused, then resumed; no store failed                                                              |
| Simulator down for good                                              | Breaker tripped after 30 s (123 failures in a row); job `FAILED_SYSTEMIC`, 304 tasks `ABORTED`              |
| Two worker processes with separate in-process limiters (by accident) | ~8 calls/s, so 429s; still no duplicates and all succeeded. This is why the real limiter is shared in Redis |

### Live progress (SSE)

Nothing polls the database for progress. Every transaction that changes it (a recorded result, a
reaped lease, a job closing, a systemic stop) also runs `pg_notify('job_progress', jobId)`, which
Postgres delivers only when that transaction commits. The API holds one `LISTEN` connection per
process and fans notifications out to open streams, coalescing bursts to at most one snapshot query
per job every 500 ms. It works across worker processes because the signal travels through Postgres.
If the `LISTEN` connection drops, it reconnects and refreshes every watched job once. The browser
uses `EventSource`; while the stream is down it polls `GET /jobs/:id` every 5 s instead.

### Scoring

Scoring is deliberately separate from enrichment: it reads only `store_metrics` and writes only
`scoring_configs` + `store_scores`. The rule lives in exactly one place, `scoreStore()` / `tierFor()`
in `@tierforge/shared`. A scoring run loads the job's metrics, applies those functions in Node and
bulk-inserts the results (1,000 rows per statement) in one transaction; 5,000 stores take a few
hundred milliseconds. The web app uses the same functions to mark which bars a store clears, so the
dashboard and the stored tiers can't disagree. Validation is layered on purpose: the shared Zod
schema (form and API) plus database `CHECK` constraints as a backstop.

### Data model

| Table                 | One row per                    | Notes                                                                                                                           |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `uploads`             | uploaded CSV                   | filename and accepted row count                                                                                                 |
| `stores`              | valid CSV row                  | unique `(upload_id, store_id)`                                                                                                  |
| `enrichment_jobs`     | enrichment run over one upload | status, timestamps, `terminal_reason`; partial unique index allows one active job                                               |
| `enrichment_tasks`    | store in a job                 | current state: status, attempts, `next_attempt_at`, lease token and expiry, last error                                          |
| `enrichment_attempts` | API call                       | optional, write-only history: outcome, HTTP status, latency, error; never read by the engine                                    |
| `store_metrics`       | enriched store per job         | footfall, revenue (`numeric(14,2)`), size; primary key `(job_id, store_pk)` (migration 0002), so each job keeps its own results |
| `scoring_configs`     | scoring run                    | immutable bars, weights and cut-offs                                                                                            |
| `store_scores`        | store in a scoring run         | score and tier; primary key `(scoring_config_id, store_pk)`                                                                     |

All foreign keys use `ON DELETE CASCADE`. Migrations live in `apps/server/src/db/migrations`.

## Configuration

Every setting is an environment variable, validated at startup (`apps/server/src/config.ts`); the
server refuses to start on an invalid value. Defaults are in `.env.example`.

| Variable                                     | Default                | Meaning                                                                           |
| -------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`, `REDIS_URL`, `SIMULATOR_URL` | local compose services | Where Postgres, Redis and the Enrichment API are                                  |
| `PORT`, `LOG_LEVEL`                          | `3000`, `info`         | API port and log level                                                            |
| `RUN_WORKERS`                                | `true`                 | Run enrichment workers in this process; set `false` for an API-only process       |
| `WORKER_CONCURRENCY`                         | `8`                    | Worker loops per process (1–64). Throughput is capped by the rate limit, not this |
| `RATE_LIMIT_PER_SECOND`                      | `4`                    | Shared calls per second across all processes (max 5)                              |
| `REQUEST_TIMEOUT_MS`                         | `10000`                | Per-call timeout; must be shorter than `LEASE_MS`                                 |
| `LEASE_MS`                                   | `30000`                | How long a claimed task belongs to one worker before the reaper may take it back  |
| `MAX_ATTEMPTS`                               | `5`                    | Attempts per store before it is marked `FAILED`                                   |
| `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`          | `1000`, `30000`        | Retry backoff: doubles per attempt with jitter, capped                            |
| `BREAKER_WINDOW_MS`, `BREAKER_MIN_FAILURES`  | `30000`, `10`          | Stop the job only after this long and this many upstream failures with no success |
| `REAPER_INTERVAL_MS`                         | `5000`                 | How often expired leases are reclaimed                                            |
| `WORKER_IDLE_POLL_MS`, `RATE_LIMIT_PAUSE_MS` | `500`, `1000`          | Idle wait when the queue is empty; pause after a 429 or when Redis is unavailable |

## Testing

```bash
npm test
```

Runs every workspace's Vitest suite. Database tests use PGlite (Postgres compiled to WebAssembly,
in-process), so no Docker is needed and every test gets a fresh, migrated database. The Redis limiter
test runs only when Redis is reachable (`localhost:6379` or `TEST_REDIS_URL`) and is skipped otherwise.

| Area              | What is proven                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CSV upload        | header rules (BOM, case, order, missing/extra/duplicate columns), row rejects with line numbers, size limits                       |
| Enrichment client | every outcome is typed: success, 429, 5xx, 4xx, timeout, network error, invalid body                                               |
| Retry policy      | backoff ranges, attempt cap, 4xx fails fast                                                                                        |
| Task queue        | each task is claimed exactly once; a late result after reclaim is ignored; retries are not handed out early                        |
| Worker pool       | end to end through transient failures with no duplicates; attempt cap; a worker dying mid-call; no calls while the limiter is down |
| Lease reaper      | expired leases go back to `PENDING` or `FAILED` on the last attempt; a late answer after reaping changes nothing                   |
| Circuit breaker   | ignores 429s and normal noise; trips only on a sustained outage; aborts unfinished tasks                                           |
| Rate limiter      | slots are evenly spaced and shared across clients (real Redis)                                                                     |
| Live progress     | notifications arrive only on commit; bursts are coalesced; `LISTEN` reconnects; the stream sends a snapshot, updates and `done`    |
| Scoring           | boundary values (exactly on a bar and a cut-off), validation messages, repeatable runs, API responses                              |

`npm run typecheck`, `npm run lint` and `npm run format:check` must also pass.

## Design decisions and trade-offs

| Decision                                                     | Why                                                                                                           | Cost                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Postgres is both the source of truth and the queue           | Task state and results change in one transaction, so nothing is lost or double-counted; one less system       | Fine for thousands of tasks per second; a very large system would move to a dedicated queue |
| Redis only for the rate limiter                              | The limit must be shared by every worker and process; Redis' clock and a Lua script make it exact             | One more service; if Redis is down, enrichment pauses (fails closed) rather than risk 429s  |
| 4 calls/s, evenly spaced, not 5                              | The simulator counts a fixed 1 s window and rejected calls count too; bursts at the edge cause 429 storms     | 20% less peak throughput; in return, zero 429s in every measured run                        |
| Leases instead of long transactions                          | No database connection is held during a 50 s hang; a crashed worker's task comes back automatically           | A late answer can arrive after reclaim, so every write is guarded by the lease token        |
| Retries wait behind fresh work                               | New stores keep flowing during a burst of 500s, and retries get natural spacing                               | The last few minutes of a job are mostly retries                                            |
| Circuit breaker counts only 5xx, timeouts and network errors | 429s and 4xx describe our requests, not the API's health; ~12% noise must never stop a job                    | A real outage is detected after 30 s, not instantly                                         |
| Scoring is a separate step over stored metrics               | Re-scoring with new bars takes milliseconds and never calls the slow API                                      | A score reflects the metrics stored when it ran; it can be re-run any time                  |
| One scoring function shared by API and web app               | The dashboard and the stored tiers cannot disagree                                                            | Scoring runs in Node rather than inside one SQL statement (5,000 stores still take < 1 s)   |
| Each scoring run is stored with its own immutable settings   | Earlier breakdowns stay reproducible                                                                          | `store_scores` grows by one row per store per run                                           |
| SSE driven by `pg_notify`, polling only as a fallback        | No per-client polling of the database; works across worker processes because the signal goes through Postgres | One extra `LISTEN` connection per API process                                               |
| One active job at a time                                     | Enforced by a partial unique index; keeps the rate limit and progress easy to reason about                    | A second upload has to wait (409)                                                           |

## Known limitations

- **Failed stores can't be retried in place.** Stores that fail after 5 attempts are listed with the reason, but
  re-running them means a new job. A `FAILED_SYSTEMIC` job can't be resumed or cancelled either.
- **One job at a time**, for the whole system.
- **No reuse across uploads.** The API is deterministic per `store_id`, but uploading the same file again calls it
  again for every store.
- **Workers run in the API process by default.** A restart pauses enrichment briefly; in-flight tasks are
  reclaimed by the reaper after their lease (≤ 30 s). `RUN_WORKERS=false` allows separate API and worker processes,
  but no deployment for that is provided.
- **A job can wait indefinitely** if Redis stays down: it is safe (no calls, nothing lost) but nothing alerts anyone.
- **Tables only grow.** There is no retention for `enrichment_attempts` or old scoring runs, and no delete endpoint.
- **Throughput is bounded by the API**: about 4 stores/s, so 5,000 stores take ~24 min and 100,000 would take ~7 h.
- **Local-only setup**: the server runs through `tsx`, the dashboard through the Vite dev server, and migrations are
  run by hand.

## Path to production

In the order I would do them:

1. **Authentication and authorization** on every endpoint, plus request-size and per-client rate limits.
2. **Operations visibility:** metrics (queue depth, calls/s, 429 and 5xx rates, breaker trips, job duration),
   alerts on a job with no progress, and a `/health` check that includes worker liveness.
3. **Retry failed stores and cancel a job** (small API additions on top of the existing task states).
4. **Separate API and worker deployments** with a production build (compiled server, static dashboard), Dockerfiles,
   CI running the checks above, and migrations run by the pipeline.
5. **Managed Postgres and Redis** with backups and failover; real secrets and TLS instead of the compose defaults.
6. **Reuse metrics across uploads** for the same `store_id` within a freshness window.
7. **Multiple concurrent jobs** sharing the one rate limit, with fair scheduling between them.
8. **Retention** for attempts history and old scoring runs.

## Troubleshooting

| Problem                                            | Fix                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `esbuild` / `tsx` "platform" error on startup      | `node_modules` was installed on another OS (e.g. Linux vs macOS). Delete `node_modules` in the root and every workspace, then `npm install` |
| Port 3000, 5173, 5432, 6379 or 8000 already in use | Stop the other process, or change `PORT` / the compose port mappings and the matching URLs in `.env`                                        |
| `/health` returns `503`                            | Postgres or Redis is not reachable; `npm run infra:up` and check `docker compose ps`                                                        |
| Job progress stalls, logs say Redis is unavailable | Expected fail-closed behaviour: workers wait. Start Redis and progress resumes on its own                                                   |
| Job ends `FAILED_SYSTEMIC`                         | The simulator was unreachable or failing for 30 s. `GET /jobs/:id` shows the reason; start the simulator and create a new job               |
| Why did a store fail?                              | Dashboard step 2 lists failed stores, or `GET /jobs/:id/failures`; every attempt is in `enrichment_attempts`                                |
| `409 JOB_ALREADY_RUNNING`                          | Only one job runs at a time; wait for it to finish                                                                                          |
