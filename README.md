# TierForge

Resilient bulk store scoring and tiering. TierForge ingests a CSV of stores, enriches each one through a slow,
rate-limited and flaky Enrichment API, then scores and tiers every store (Large / Medium / Small) from
user-configured bars and weights.

> Status: Phase 3 done (CSV upload, enrichment job engine with full failure handling). Features land phase by phase.

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
npm run dev:server        # API on :3000
curl localhost:3000/health
```

Stop the infrastructure with `npm run infra:down` (add `-v` to `docker compose down` to wipe the database).

## Repository layout

| Path                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `apps/server`                   | Fastify API and enrichment workers (Node + TypeScript)   |
| `apps/server/src/db/migrations` | Kysely migrations; the schema's source of truth          |
| `apps/server/src/db/schema.ts`  | Table types used by Kysely, kept in sync with migrations |
| `apps/web` _(Phase 5)_          | React + Vite dashboard                                   |
| `docker-compose.yml`            | Postgres 16, Redis 7 and the simulator                   |

## Scripts

| Command                | What it does                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run infra:up`     | Start Postgres, Redis and the simulator                                                                                                                       |
| `npm run db:migrate`   | Apply all migrations                                                                                                                                          |
| `npm run dev:server`   | Run the API with reload                                                                                                                                       |
| `npm test`             | Unit + Postgres tests (in-process PGlite, no Docker needed); the Redis limiter test also runs when Redis is reachable on `localhost:6379` or `TEST_REDIS_URL` |
| `npm run typecheck`    | TypeScript checks for every workspace                                                                                                                         |
| `npm run lint`         | ESLint                                                                                                                                                        |
| `npm run format:check` | Prettier                                                                                                                                                      |

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

### `GET /jobs/:id/failures?limit=50&offset=0`

Stores that ultimately failed, each with attempts, the last HTTP status and the reason.

### `GET /jobs`

The 20 most recent jobs.

All errors share one shape: `{ "error": { "code", "message", "details"? } }`.

## Architecture (summary)

Two pipelines that share only the database:

- **Enrichment (slow, unreliable):** a Postgres-backed task queue. Workers claim tasks with
  `FOR UPDATE SKIP LOCKED` under a time-limited lease, call the API through a Redis rate limiter
  (4 calls/s, evenly spaced, below the simulator's fixed-window 5 req/s), and write results guarded by the
  lease token so late responses from reclaimed attempts are discarded.
- **Scoring (fast, deterministic):** one set-based SQL pass over stored metrics. Never calls the API and
  can be re-run any time.

### Schema decisions already enforced by the database

- Only one `QUEUED`/`RUNNING` job at a time (partial unique index).
- A task is leased if and only if it is `IN_FLIGHT` (check constraint).
- One task per store per job; one metrics row per store.
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
5. **Close the job** when no task is pending or in flight, using a conditional update so two workers
   finishing together can't both close it.

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

Every attempt is recorded in `enrichment_attempts` (outcome, HTTP status, latency, error).

### Measured against the simulator

| Scenario                                                             | Result                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 5,000 stores, normal run                                             | 24 min; 4,999 succeeded, 1 failed after 5 attempts (four 500s and a timeout); zero 429s                     |
| 300 stores                                                           | 90 s; all succeeded; 33 transient 500s and 5 hangs retried; zero 429s                                       |
| Worker killed with `kill -9` mid-job, new worker started             | In-flight task reclaimed; 100/100 succeeded; one metrics row per store                                      |
| Simulator down for 12 s mid-job                                      | Progress paused, then resumed; no store failed                                                              |
| Simulator down for good                                              | Breaker tripped after 30 s (123 failures in a row); job `FAILED_SYSTEMIC`, 304 tasks `ABORTED`              |
| Two worker processes with separate in-process limiters (by accident) | ~8 calls/s, so 429s; still no duplicates and all succeeded. This is why the real limiter is shared in Redis |

Full design notes, trade-offs and known limitations will be completed as the phases land.
