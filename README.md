# Distributed Airline Inventory System

A distributed, transactionally consistent backend for airline seat inventory, rebuilt on
**distributed PostgreSQL (Citus)** with Node.js, Express and CommonJS. It demonstrates — and
enforces in the database rather than in application code — the invariant
`flight + cabin + seat ⇒ ≤ 1 live booking`, while keeping every write on a single shard so a
booking is one ordinary local ACID transaction with **no two-phase commit**.

This is the successor to the MongoDB prototype archived under `legacy/mongodb-prototype/`. The
HTTP contract is preserved (see [docs/MIGRATION_FROM_MONGODB.md](docs/MIGRATION_FROM_MONGODB.md));
the storage model is not.

> **The database is populated by EXTERNAL Python loaders you own** (~50M flights, ~100k users).
> `npm run seed:dev` inserts only a tiny development fixture. The schema contract, the
> partitioning footguns and ready-to-adapt loader skeletons are in
> [docs/DATA_LOADING.md](docs/DATA_LOADING.md) — read that before writing any loader.

---

## Architecture at a glance

- **Write model on Citus.** `flights`, `flight_inventory`, `bookings`, `payments` and
  `booking_outbox` are all **distributed by `flight_id`** and **co-located**, so every statement in
  the booking path lands on the same worker and commits as a single local transaction.
- **Count-based inventory + lazy seat assignment.** Inventory is a counter per `(flight, cabin)`,
  not a row per physical seat — at 50M flights a seat-per-row model would be ~10 billion rows.
  The physical seat only materializes when someone holds it (`bookings.seat_number`).
- **Saga-based booking.** `reserve → authorize → capture → confirm`, with a compensation path that
  releases the hold. The gateway is simulated; the saga structure and its persisted state are real.
- **Transactional outbox.** The event that describes a state change is written in the *same*
  transaction as the change, so no event can be lost if the process dies after commit.
- **CQRS read model.** Search/availability lives in a separate database (`flight_availability`),
  projected from the outbox. It is eventually consistent by design; lag is measured and surfaced.

```mermaid
flowchart LR
  C[Clients] --> API[API tier<br/>Express, stateless]
  API --> PGB[PgBouncer<br/>transaction pooling]
  PGB --> COORD[(Citus coordinator)]

  subgraph Citus write cluster
    COORD --> W1[(worker1<br/>shards)]
    COORD --> W2[(worker2<br/>shards)]
  end

  API --> READ[(read model<br/>flight_availability)]
  API --> REDIS[(Redis<br/>idempotency, holds, cache)]
  WORKERS[Workers: outbox projector<br/>+ hold reaper] --> COORD
  WORKERS --> READ
  COORD -. outbox rows .-> WORKERS
```

---

## Quick start (local PostgreSQL — no Docker)

This is the path that works on a machine without Docker. It creates a throwaway PostgreSQL cluster
under `.pgdata/` on a non-default port (`55432`) and two databases: `airline_inventory` (write
model) and `airline_read` (read model).

```bash
npm install                     # first time only (no build step)
cp .env.example .env            # adjust if you like; the defaults match this path

npm run db:local:start          # initdb (once) + start + create both databases
npm run db:setup                # create schema + roles expected by the app
npm run db:migrate              # apply db/migrations to write AND read models
npm run seed:dev                # small development fixture (NOT the 50M-flight dataset)
npm start                       # API on http://localhost:3001
```

Then: `curl http://localhost:3001/api/health`, browse the flight search at
`GET /api/flights`, or open the Swagger UI at `http://localhost:3001/api-docs`.

To stop the cluster when you are done:

```bash
npm run db:local:stop
```

To simulate several API instances (the original multi-node story), run in separate shells:

```bash
npm run start:node-a     # NODE_ID=api-1, port 3001
npm run start:node-b     # NODE_ID=api-2, port 3002
npm run start:node-c     # NODE_ID=api-3, port 3003
```

On this path Citus is not present, so migrations create the same tables as ordinary local tables —
identical schema, local placement. That is what lets the test suite run without Docker while
production runs distributed.

---

## Quick start (Docker Compose — Citus cluster)

`docker-compose.yml` starts a coordinator, two workers, a read-model PostgreSQL, Redis, PgBouncer
and the API. Clone it, then:

```bash
cp .env.example .env
docker compose up -d --build                       # datastores + api (workers are excluded by profile)

docker compose exec coordinator \
  psql -U airline -d airline_inventory \
  -c "SELECT citus_add_node('worker1', 5432);" \
  -c "SELECT citus_add_node('worker2', 5432);"     # ONE-TIME: register workers before migrating

docker compose --profile tools run --rm migrate    # apply migrations (distributes the big tables)
docker compose --profile workers up -d             # start the outbox projector + hold reaper
```

The API is on `http://localhost:3000`. `PgBouncer` transaction pooling is used in front of the
coordinator; it is safe here because the booking path holds no session state and uses no prepared
statements. See the header comment in `docker-compose.yml` for what each service is for and
[docs/RUNBOOK.md](docs/RUNBOOK.md) for the operations you will need.

---

## Environment variables

Everything is read once at startup by `src/config/env.js`. Copy `.env.example` to `.env` and edit.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production`/`test` change logging, SSL and rate-limit defaults. |
| `NODE_ID` | `api-local` | Instance identity in logs, headers and `bookings.node_id`. |
| `PORT` | `3000` | HTTP listen port (`.env.example` uses 3001 for the local path). |
| `SWAGGER_ENABLED` | `true` | Serve the OpenAPI spec and Swagger UI. |
| `LOG_LEVEL` | `info` (test: `error`) | `error`/`warn`/`info`/`debug`. |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins, or `*`. |
| `CITUS_COORDINATOR_URL` | `postgres://airline:airline@127.0.0.1:55432/airline_inventory` | Write model (Citus coordinator). |
| `PGBOUNCER_URL` | *unset* | When set, preferred over `CITUS_COORDINATOR_URL` for application queries. |
| `PG_POOL_MAX` | `20` | Write-model pool size. |
| `PG_STATEMENT_TIMEOUT_MS` | `15000` | Per-statement timeout sent as a startup parameter. |
| `PG_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `30000` | Kills a transaction left idle mid-flight. |
| `PG_CONNECTION_TIMEOUT_MS` | `10000` | Connect timeout. |
| `READMODEL_URL` | `postgres://airline:airline@127.0.0.1:55432/airline_read` | Read model database. The projector writes here. |
| `READMODEL_READ_URL` | *unset* | Optional read replica that serves search. Unset means search reads `READMODEL_URL`. |
| `READMODEL_POOL_MAX` | `20` | Read-model pool size. |
| `READMODEL_LAG_SLA_SECONDS` | `60` | Freshness SLA; lag above this is reported as stale. |
| `REDIS_URL` | *unset* | Shared Redis. Unset uses the in-process driver (dev/tests only — it does NOT deduplicate across instances). |
| `REDIS_KEY_PREFIX` | `airline` | Key namespace. |
| `REDIS_CONNECT_TIMEOUT_MS` | `2000` | Connect timeout before degrading to the in-process driver. |
| `BOOKING_HOLD_TTL_SECONDS` | `600` | How long a `PENDING` hold survives before the reaper releases it. |
| `DEFAULT_CABIN` | `ECONOMY` | Cabin used when the request omits one. |
| `SEAT_ASSIGNMENT_MODE` | `requested` | `requested` = accept a specific seat at booking time; `lazy` = assign later. |
| `INVENTORY_STRATEGY` | `single` | `single` = one counter row per (flight, cabin); `sharded` = spread over N rows. |
| `INVENTORY_SHARD_COUNT` | `8` | Number of counter rows when `INVENTORY_STRATEGY=sharded`. |
| `PAYMENT_PROVIDER` | `SIMULATED` | Payment gateway identifier. |
| `PAYMENT_FAILURE_RATE` | `0.0` | `0.35` injects failures to exercise compensation. |
| `PAYMENT_LATENCY_MS` | `0` | Simulated gateway latency. |
| `BOOKING_SAGA_INLINE` | `true` | `true` runs reserve→pay→confirm inline (201); `false` returns 202 PENDING. |
| `JWT_ACCESS_SECRET` | dev placeholder | Access-token signing secret. |
| `JWT_REFRESH_SECRET` | dev placeholder | Refresh-token signing secret. |
| `JWT_ACCESS_TTL` | `15m` | Access-token lifetime. |
| `JWT_REFRESH_TTL_SECONDS` | `2592000` | Refresh-token lifetime (30 days). |
| `JWT_ISSUER` | `distributed-airline-inventory` | Expected `iss` claim. |
| `JWT_AUDIENCE` | `airline-api` | Expected `aud` claim. |
| `AUTH_RATE_LIMIT_PER_MIN` | `30` | Rate limit on auth endpoints. |
| `API_RATE_LIMIT_PER_MIN` | `600` | Rate limit on the API generally. |
| `RATE_LIMIT_ENABLED` | `true` (test: `false`) | Master switch for rate limiting. |
| `REQUIRE_AUTH_FOR_BOOKING` | `false` | `false` allows guest attribution with only `passengerId`. |
| `MAX_RETRIES` | `4` | Transaction retry attempts on transient errors. |
| `RETRY_INITIAL_DELAY_MS` | `15` | Backoff initial delay. |
| `RETRY_MAX_DELAY_MS` | `200` | Backoff ceiling. |
| `WORKERS_ENABLED` | `true` | Run the in-process workers when the API starts. Set `false` when workers are a separate Deployment/service. |
| `WORKER_METRICS_PORT` | `0` | Optional metrics/liveness port for a worker-only process (e.g. `9464`). |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Outbox poll interval. |
| `OUTBOX_BATCH_SIZE` | `200` | Rows projected per poll. |
| `OUTBOX_MAX_ATTEMPTS` | `10` | Attempts before an outbox row is parked (stays unpublished). |
| `REAPER_INTERVAL_MS` | `30000` | Hold-reaper interval. |
| `REAPER_BATCH_SIZE` | `200` | Holds reaped per sweep. |
| `PARTITION_MONTHS_AHEAD` | `6` | Months of partitions kept ahead of today. |
| `PARTITION_MONTHS_BEHIND` | `1` | Months of partitions kept behind today. |
| `PARTITION_RETENTION_MONTHS` | `24` | Age at which departed months are dropped. |
| `METRICS_ENABLED` | `true` | Expose Prometheus metrics. |

---

## npm scripts

| Script | What it does |
|---|---|
| `npm start` | Start one API instance (`node src/server.js`). |
| `npm run start:node-a` / `-b` / `-c` | Start a named instance on ports 3001/3002/3003 for multi-node demos. |
| `npm run db:local:start` | Create (once) and start the local PostgreSQL cluster on port 55432. |
| `npm run db:local:stop` | Stop the local cluster. |
| `npm run db:local:status` | Report whether the local cluster is running and its version. |
| `npm run db:setup` | Create/organise the databases and roles the app expects. |
| `npm run db:migrate` | Apply pending migrations to the write and read models. |
| `npm run db:status` | Show applied/pending/drift state and the Citus topology. |
| `npm run db:reset` | `db:setup --reset`: drop and recreate for a clean slate. |
| `npm run seed:dev` | Insert the small development fixture (NOT the 50M-flight dataset). |
| `npm run partitions:maintain` | Create upcoming monthly partitions and drop months past retention. |
| `npm run readmodel:reproject` | Rebuild the read model from the write model. |
| `npm run backfill` | Bulk-load flights/users/bookings (synthetic or legacy NDJSON), partition-aware and resumable. |
| `npm run backfill:dry` | Show what the loader would write without writing. |
| `npm run validate:data` | Run the data-quality invariants; non-zero exit on a violation. |
| `npm run reaper:run` | Run the hold reaper once/continuously (worker). |
| `npm run outbox:run` | Run the outbox projector (worker). |
| `npm run workers:run` | Run all background workers in one process. |
| `npm run audit:oversell` | Audit the booking side for oversell / accounting violations. |
| `npm run stress` | Live concurrency stress test against running instances. |
| `npm run chaos:worker-down` | Stop workers, keep booking, restart, verify projection recovery (dry run unless `--execute`). |
| `npm run load:smoke` / `load:search` / `load:booking` | k6 scenarios (requires the k6 binary). |
| `npm run saga:reconcile` | Find and reconcile stuck sagas. |
| `npm test` | Run the whole jest suite. |
| `npm run test:unit` | Unit tests (hermetic). |
| `npm run test:integration` | Integration tests (need a real database). |
| `npm run test:concurrency` | Concurrency tests (need a real database). |
| `npm run test:coverage` | Jest with coverage. |

See [docs/TESTING.md](docs/TESTING.md) for what each suite proves.

---

## API surface

Envelopes, routes, headers and status codes are preserved from the original prototype
(`success` / `isIdempotentReplay` / `data`, and the `error` envelope on failure).

| Method & path | Purpose |
|---|---|
| `GET /` | Instance status + links to docs and health. |
| `GET /api/health` | Aggregate health (write model, read model, cache, topology). |
| `GET /api/health/live` | Liveness only — used by the container healthcheck. |
| `GET /api/health/ready` | Readiness — fails while a dependency is unavailable. |
| `GET /api/flights` | Search flights (`origin`, `destination`, `flightNumber`, `maxPrice`, `hasAvailableSeats`, `minAvailableSeats`, `status`). |
| `GET /api/flights/:flightId` | Flight detail. |
| `GET /api/flights/:flightId/seats` | Seat map (derived from the aircraft-type template, left-joined with live holds). |
| `POST /api/bookings` | Create a booking. `201` confirmed, `202` if the saga is deferred, `200` on an idempotent replay. Honours `Idempotency-Key` / `x-idempotency-key`. |
| `GET /api/bookings/:bookingId` | Fetch one booking. |
| `POST /api/bookings/:bookingId/cancel` | Cancel and release the hold. |
| `DELETE /api/bookings/:bookingId` | RESTful alias for cancel. |
| `POST /api/auth/register` | Register a user. |
| `POST /api/auth/login` | Issue an access + refresh token pair. |
| `POST /api/auth/refresh` | Rotate a refresh token (reuse revokes the family). |
| `POST /api/auth/logout` | Revoke the current refresh-token family. |
| `GET /api/me/bookings` | The caller's bookings, read from the per-user projection (single shard). |
| `GET /metrics` | Prometheus metrics (when `METRICS_ENABLED`). |
| `GET /api-docs`, `GET /api-docs.json` | Swagger UI and the raw OpenAPI document. |

Node identity travels in the `x-node-id` header; freshness of a search response in
`x-read-model-lag-ms`.

---

## Testing

```bash
npm run db:local:start && npm run db:migrate   # integration/concurrency need a real database

npm run test:unit           # no database; constants/schema alignment, pure logic
npm run test:integration    # real PostgreSQL: repository + API + saga behaviour
npm run test:concurrency    # hammers one cabin from many callers; asserts ZERO oversell
npm run test:coverage
```

Full detail — including how to reproduce the oversell test locally and the acceptance-criteria
checklist — is in [docs/TESTING.md](docs/TESTING.md).

---

## Loading and validating data

```bash
# Synthetic data (deterministic, resumable, no input files)
npm run backfill -- --source synthetic --start 2027-01-01 --days 30 --flights-per-day 50 \
  --outbox --reproject

# Legacy MongoDB export (NDJSON; see docs/MIGRATION_FROM_MONGODB.md for the shapes)
npm run backfill -- --source ndjson --input ./export --outbox --reproject

# Verify; exits 1 on any violation
npm run validate:data -- --from 2027-01-01 --to 2027-01-30 --strict
```

The loader creates the month partitions it needs before the first batch, maps legacy ObjectIds
through UUIDv5 so a re-run cannot duplicate rows, checkpoints atomically, and reconciles inventory
counters for imported historical bookings. At the full 50M scale, prefer a `COPY`-based external
pipeline; the contract it must satisfy and the SQL to verify it are in
[docs/DATA_LOADING.md](docs/DATA_LOADING.md).

---

## Load, chaos and observability

```bash
k6 run load/k6/smoke.js                 # deploy gate: health + search + booking replay
k6 run -e FLIGHT_ID=<uuid> load/k6/booking.js
node scripts/chaos-worker-down.js --execute
docker compose --profile workers --profile observability up -d
# Prometheus UI: http://localhost:9090/alerts
```

The k6 scenarios measure the read path and the write path separately, and treat a 409 as the
anti-oversell condition doing its job rather than as a failure. The chaos test proves the claim the
outbox exists for: with the workers stopped, bookings still commit; when the workers return, the
read model catches up with a clean inventory audit. Alert rules are in
[deploy/observability/alerts.yml](deploy/observability/alerts.yml).

---

## Deployment

The same image runs the API, the workers and the migration Job. Kubernetes manifests, probes,
scaling and the migration-before-rollout order are documented in
[deploy/k8s/README.md](deploy/k8s/README.md). Releases are published to GHCR by
`.github/workflows/release.yml` with build provenance and an SBOM. The operational procedures
(partition horizon, outbox backlog, restore, alert playbooks) are in
[docs/RUNBOOK.md](docs/RUNBOOK.md).

---

## Design decisions and trade-offs

**Counts, not one row per seat.** Inventory is a counter per `(flight, cabin)`. At 50M flights,
materializing every physical seat would be ~9–10 billion rows; counters bring that to ~150M (one
row per flight per cabin in the `single` strategy) and make the anti-oversell statement a single
conditional `UPDATE`. The physical seat only exists once it is held.

**Co-location by `flight_id` ⇒ no two-phase commit.** `flights`, `flight_inventory`, `bookings`,
`payments` and `booking_outbox` are distributed by `flight_id` and placed in the same co-location
group, so a booking touches exactly one worker. All five writes of a booking commit as one local
transaction. The alternative — cross-shard writes — would need distributed transactions, which
Citus does not offer for arbitrary DDL/DML and which are slower and harder to reason about.

**The read model is eventually consistent, and lag is surfaced.** Search reads a separate database
that is projected from the outbox. It can be dropped and rebuilt, which is why it is allowed to lag.
Rather than hide that, `/api/flights` reports staleness via `x-read-model-lag-ms`, and
`READMODEL_LAG_SLA_SECONDS` defines when a projection is considered stale.

**UUIDv7 for primary keys.** Keys are time-ordered: inserts land at the right edge of the B-tree
instead of scattering across it the way random v4 keys would. At billions of rows that is the
difference between healthy index locality and constant page splits. (`src/utils/ids.js`;
`app_uuidv7()`/`uuidv7()` is the server-side fallback.)

**Outbox instead of dual writes.** The domain event is inserted in the same transaction as the
state change, so it cannot be lost if the process dies after commit. Projection into the read model
and the per-user index is then driven from the outbox by a poller. Dual-writing to the read model in
the request path would be faster until it is not — a crash between the two writes silently
desynchronizes the stores with no record of the gap.

---

## What is deliberately not implemented

- **A real payment gateway.** `PAYMENT_PROVIDER=SIMULATED`; no network calls, no PCI scope. The
  saga, its persisted `saga_state`, its compensation path and its failure injection
  (`PAYMENT_FAILURE_RATE`) are real, but the gateway is a stub.
- **A seat-selection UI.** The backend exposes a derived seat map and guarded seat reservation;
  there is no front end.
- **Tenants / row-level security.** Single-tenant. RLS and per-tenant isolation are out of scope.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, [docs/RUNBOOK.md](docs/RUNBOOK.md)
for operations, [docs/MIGRATION_FROM_MONGODB.md](docs/MIGRATION_FROM_MONGODB.md) for the migration
record, and [docs/DATA_LOADING.md](docs/DATA_LOADING.md) for how to load your own data.
