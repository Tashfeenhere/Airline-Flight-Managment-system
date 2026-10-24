# Testing

The suites are split by what they need and what they prove. Unit tests are hermetic and always
runnable; integration and concurrency tests require a real PostgreSQL and (optionally) Redis.

```bash
# Unit tests need nothing.
npm run test:unit            # jest tests/unit --runInBand --forceExit

# Integration and concurrency need a live database. With the no-Docker path:
npm run db:local:start
npm run db:migrate
npm run test:integration     # jest tests/integration --runInBand --detectOpenHandles --forceExit
npm run test:concurrency     # jest tests/concurrency --runInBand --detectOpenHandles --forceExit

npm test                     # everything
npm run test:coverage        # everything with coverage
```

`--runInBand` runs the files sequentially in one process. It is not just a convenience: several suites
share a database and assert on global state (counters, outbox rows), so running files in parallel
would make them race each other.

---

## 1. Unit suite (`tests/unit`)

Proves the pure logic, without a database:

- the frozen enums in `src/config/constants.js` stay aligned with the CHECK constraints and index
  names in `db/migrations` (the constants file documents this as `constantsAlignment`);
- `src/utils/ids.js` produces a genuine UUIDv7 (version nibble, variant, timestamp ordering),
  valid booking references and safe comparisons;
- `src/concurrency/transactionRetry.js` retries exactly the transient SQLSTATEs (40001, 40P01,
  55P03, connection loss) and never retries the ones that would double-apply a booking (unique
  violations, `40003 statement_completion_unknown`);
- validation and mapping helpers that have no database dependencies.

Run it first. If the unit suite is red, the failure is in code, not environment.

---

## 2. Integration suite (`tests/integration`)

Proves behaviour against a **real** PostgreSQL:

- the repository layer's SQL is valid against the actual schema (column names, partial-unique
  indexes, CHECK constraints);
- the migration runner applies cleanly and reports drift correctly;
- a booking round-trips: reserve → confirm → the counter reflects it;
- the saga completes when payment succeeds and compensates when it fails
  (`PAYMENT_FAILURE_RATE` injects the failure) — this is the **saga behaviour** coverage. There is no
  dedicated `test:saga` script; run it with the integration suite, or a single file directly:
  `npx jest tests/integration --runInBand -t "saga"`;
- cancellation and hold expiry release inventory back to the counter;
- the outbox projector moves an event into the read model and marks it published;
- authentication: register/login/refresh rotation, and refresh-token reuse revoking the family;
- the published HTTP contract (envelopes, headers, status codes) still matches the OpenAPI document;
- the Citus topology (`topology.test.js`): distribution keys, co-location groups and shard placement
  when migrations run against a clustered instance — this is the per-node/distribution proof. It
  skips cleanly on the local non-Citus path;
- partition pruning: a date-ranged search touches only the month's partition.

Set the connection environment the same way the app does
(`CITUS_COORDINATOR_URL`, `READMODEL_URL`, optionally `REDIS_URL`) and, for deterministic tests,
`RATE_LIMIT_ENABLED=false`.

---

## 3. Concurrency suite (`tests/concurrency`)

Proves the invariant under contention. It fires many simultaneous booking requests at one cabin (and,
in the seat tests, at one seat) and asserts that **exactly one** succeeds.

### Why this needs a real database

The claim under test is "no oversell". Oversell is a race between two transactions on the same
`flight_inventory` row, resolved by PostgreSQL's row locking and MVCC. A mock or in-memory fake
cannot reproduce that race — it would serialize calls in JavaScript and prove nothing — and it cannot
enforce the `inv_capacity` CHECK constraint or the `uq_live_seat` partial unique index, which are the
backstops that make the invariant true even if application logic is wrong. The only way to test the
guarantee is to run real concurrent transactions against a real MVCC engine. That is why CI stands up
genuine PostgreSQL (see `.github/workflows/ci.yml`), and why these tests are separate from the unit
suite.

### Reproducing the oversell test locally

```bash
npm run db:local:start
npm run db:migrate
npm run seed:dev                 # creates the small fixture the tests book against

npm run test:concurrency
# or run just the oversell case:
npx jest tests/concurrency --runInBand -t "oversell"
```

To reproduce it against running API instances instead of in-process, start one or more nodes and use
the live stress script:

```bash
npm run start:node-a &           # and optionally node-b, node-c
npm run stress                   # dispatches N simultaneous bookings and checks exactly 1 won
```

`npm run stress` also exercises the multi-node story: when several instances are running, requests
are spread across them, so the test proves the invariant holds across processes and not merely within
one.

---

## 4. Acceptance criteria checklist

The system is considered correct when all of the following hold. Each maps to an assertion in the
suites above; the section in parentheses is where the mechanism is documented in
[ARCHITECTURE.md](ARCHITECTURE.md).

- [ ] **Zero oversell under N concurrent bookings on one cabin.** After N simultaneous requests,
      `confirmed == min(N, capacity)` and `available_seats >= 0`; the CHECK `inv_capacity` never
      fires. (ARCHITECTURE §4)
- [ ] **At most one live booking per seat.** Racing bookings for the same `seat_number` yield exactly
      one `PENDING`/`CONFIRMED` holder; the rest get `SEAT_UNAVAILABLE`. Enforced by the
      `uq_live_seat` partial unique index. (ARCHITECTURE §3)
- [ ] **Idempotent replay.** Replaying a request with the same `Idempotency-Key` returns the original
      booking with `isIdempotentReplay: true` and HTTP `200`, and creates no second booking. (ARCHITECTURE §9)
- [ ] **Hold expiry frees inventory.** A `PENDING` hold past its `hold_expires_at` is reaped to
      `EXPIRED` and its seats return to `available_seats`. (ARCHITECTURE §7)
- [ ] **Read-model convergence within the lag SLA.** After a load of bookings settles, the projector
      brings `flight_availability` in line with the write model, and the reported
      `x-read-model-lag-ms` falls back under `READMODEL_LAG_SLA_SECONDS`. (ARCHITECTURE §10)
- [ ] **Partition pruning on a date-ranged search.** A search restricted to a month's dates plans
      against only that month's partition(s) — confirm with `EXPLAIN (ANALYZE, COSTS OFF)` that the
      plan names `..._p<YYYYMM>` and does not scan the parent's other partitions. (ARCHITECTURE §6)
- [ ] **Worker-down resilience.** With every projector stopped, bookings still commit; the read model
      does not advance; when the workers return it converges and the oversell audit stays clean.
      (`npm run chaos:worker-down -- --execute`; RUNBOOK §17)
- [ ] **Bulk load invariants.** After a backfill window, `npm run validate:data -- --strict` exits
      zero: counters reconcile, no orphaned bookings, no negative inventory, partitions present.
      (RUNBOOK §15, [DATA_LOADING.md](DATA_LOADING.md))

To check the pruning criterion by hand:

```sql
EXPLAIN (ANALYZE, COSTS OFF)
SELECT * FROM flight_availability
 WHERE origin = 'ISB' AND destination = 'DXB'
   AND departure_date BETWEEN DATE '2026-11-01' AND DATE '2026-11-30';
-- expect: only flight_availability_p202611 in the plan.
```

---

## 5. Load suite (`load/k6`)

The k6 scenarios run against a deployed API, not in-process. They are the proof for the throughput
and latency acceptance criteria rather than for correctness (the concurrency suite owns that).

```bash
k6 run load/k6/smoke.js                                   # deploy gate
k6 run -e BASE_URL=http://localhost:3000 load/k6/search.js
k6 run -e FLIGHT_ID=<uuid> -e BASE_URL=http://localhost:3000 load/k6/booking.js
```

`smoke.js` checks liveness/readiness, search and an idempotent booking replay. `search.js` drives a
constant arrival rate against `/api/flights` and tags read-model lag and empty-result rate.
`booking.js` hammers one flight: it registers `409` (sold out / seat clash) and `429` (rate limit) as
*expected* outcomes and counts them separately, so anti-oversell refusals do not pollute the error
budget. Set `API_RATE_LIMIT_PER_MIN` high enough for the target QPS or the run measures the limiter
instead of the service. Details and the full metric list are in [load/k6/README.md](../load/k6/README.md).

## 6. Chaos and data-quality checks

```bash
node scripts/chaos-worker-down.js --execute               # stop workers, book, restart, verify
npm run audit:oversell -- --strict                        # accounting invariant over the whole store
npm run validate:data -- --from <date> --to <date> --strict# bulk-load invariants
node scripts/chaos-worker-down.js --help                  # all flags; dry-run is the default
```

`chaos-worker-down.js` stops the worker service (compose by default; `--down-cmd`/`--up-cmd` for
Kubernetes), books seats on a fixture flight, and asserts that (a) every booking still commits while
no projector is running, (b) the read model did **not** advance, and (c) the outbox backlog grew.
It then restarts the workers and polls until `flight_availability` matches the write model, the
outbox pending count is zero, and `inventoryRepository.audit` reports no violations. It exits
non-zero on any mismatch and cleans up its fixture flight. This is the executable form of the
"worker down mid-booking" and "read model recovers" cases in Deliverable 11 of the plan. In
Kubernetes, point the commands at the worker Deployment:

```bash
node scripts/chaos-worker-down.js --execute \
  --down-cmd "kubectl -n airline scale deploy/airline-workers --replicas=0" \
  --up-cmd   "kubectl -n airline scale deploy/airline-workers --replicas=2"
```

## 7. CI

`.github/workflows/ci.yml` runs three independent jobs:

- **lint-and-unit** — `node --check` over `src/**/*.js`, then `npx jest tests/unit --runInBand`.
- **integration** — real `postgres:18` + `redis:7` service containers; creates the read-model
  database, applies migrations, then runs `npx jest tests/integration tests/concurrency --runInBand`
  with `RATE_LIMIT_ENABLED=false`.
- **docker-build** — `docker build .` on pull requests.

The jobs have no `needs:` between them, so a failure in one still reports the others.
