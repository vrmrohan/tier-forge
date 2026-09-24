# TierForge

Resilient bulk store scoring and tiering. TierForge ingests a CSV of stores, enriches each one through a slow,
rate-limited and flaky Enrichment API, then scores and tiers every store (Large / Medium / Small) from
user-configured bars and weights.

> Status: Phase 0 (scaffold, infrastructure, database schema). Features land phase by phase.

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

| Command                | What it does                            |
| ---------------------- | --------------------------------------- |
| `npm run infra:up`     | Start Postgres, Redis and the simulator |
| `npm run db:migrate`   | Apply all migrations                    |
| `npm run dev:server`   | Run the API with reload                 |
| `npm run typecheck`    | TypeScript checks for every workspace   |
| `npm run lint`         | ESLint                                  |
| `npm run format:check` | Prettier                                |

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

Full design notes, trade-offs and known limitations will be completed as the phases land.
