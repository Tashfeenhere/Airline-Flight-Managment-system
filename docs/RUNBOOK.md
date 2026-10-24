# Runbook

Operational procedures for the Distributed Airline Inventory service. Commands assume the repo root
as the working directory.

---

## 1. Start and stop the local cluster (no Docker)

```bash
npm run db:local:start      # initdb (once) + start on 127.0.0.1:55432 + create airline_inventory and airline_read
npm run db:local:status     # RUNNING/STOPPED, server version, whether citus is available
npm run db:local:stop
```

The cluster lives in `.pgdata/` and logs to `.pgdata.log`. It listens on a non-default port (55432)
so it can never collide with an installed PostgreSQL service. Stop it before moving the checkout or
deleting `.pgdata/`.

For the Docker path, see section 3.

---

## 2. Apply migrations, and what to do about drift

```bash
npm run db:migrate                      # apply everything pending to write + read
node scripts/migrate.js --dry-run       # show what would run
node scripts/migrate.js --target=write  # one target only
node scripts/migrate.js --until=004     # stop after a version
node scripts/migrate.js --status        # applied / pending / DRIFT report
```

The runner records each migration's SHA-256 in `schema_migrations` **per database**. If the recorded
checksum no longer matches the file, the migration was edited after it ran and `db:migrate` aborts
with a drift error. This is deliberate: editing an applied migration makes the database silently
disagree with the source of truth.

**Do not reach for `--ignore-drift` as a habit.** The correct fix is always to add a *new* migration.
Use `--ignore-drift` only when you know the edit was a comment/whitespace change that changes no
SQL, and you have verified that by diffing.

If a migration fails mid-way and it is non-transactional, it is safe to re-run: every non-transactional
statement is written with `IF NOT EXISTS`/`ON CONFLICT`, so partial application is a no-op the second
time. Transactional migrations roll back completely.

---

## 3. Bring up the full Citus cluster (Docker)

```bash
cp .env.example .env
docker compose up -d --build

# ONE-TIME, before the first migration:
docker compose exec coordinator psql -U airline -d airline_inventory \
  -c "SELECT citus_add_node('worker1', 5432);" \
  -c "SELECT citus_add_node('worker2', 5432);"

docker compose --profile tools run --rm migrate
docker compose --profile workers up -d
```

If you forget to register the workers, migrations still succeed but `distributionState` reports no
active workers and the big tables stay **local** (a single-node cluster). Re-running `db:migrate`
after registering workers does not retroactively distribute tables that already exist; create them
on a fresh volume, or distribute them by hand. Check with `db:status` (section 4) before trusting the
topology.

---

## 4. Verify the topology

```bash
npm run db:status
```

For a Citus cluster this reports nodes (`pg_dist_node`), distributed tables (`pg_dist_partition`,
including colocation id) and the shard count (`pg_dist_shard`). Confirm:

- Every worker you expect is listed with `noderole = primary`, `isactive = true`.
- `flights`, `flight_inventory`, `bookings`, `payments`, `booking_outbox` share **one** colocation id
  (that is what guarantees single-shard booking transactions).
- `user_bookings` and `refresh_tokens` share a **different** colocation id (they are distributed by
  `user_id`).
- Reference tables (`airlines`, `airports`, `cabins`, `aircraft_types`, `seat_map_templates`,
  `users`) have no distribution column — they are replicated.

On vanilla PostgreSQL the same report simply says Citus is not active; that is expected on the local
path.

---

## 5. Add a Citus worker

```sql
-- on the coordinator
SELECT citus_add_node('worker3', 5432);
```

New shards created afterwards can be placed on it. Existing shards are **not** moved automatically —
rebalance them (section 6). The worker must already be running with the same credentials and have the
`citus` extension available (the stock `citusdata/citus` image does).

## 6. Rebalance shards

```sql
-- on the coordinator
SELECT rebalance_table_shards('flights');            -- move shards of one table + its colocation group
SELECT rebalance_table_shards(shard_rebalance_strategy => 'by_disk_size');
```

`rebalance_table_shards('flights')` rebalances the whole co-location group, so the booking tables
move together and stay colocated. Rebalancing moves data and takes an exclusive-ish lock per shard;
run it in a low-traffic window. If a shard move fails, `SELECT * FROM citus_shard_move_operations;`
shows progress, and a failed move leaves the original placement intact.

## 7. Partition maintenance

```bash
npm run partitions:maintain      # create upcoming months, drop months past retention
```

Manually, on the coordinator:

```sql
SELECT app_ensure_month_partitions('flights',         0, 12);   -- 12 months ahead
SELECT app_ensure_month_partitions('flight_inventory', 0, 12);
SELECT app_ensure_month_partitions('bookings',         0, 12);
SELECT app_ensure_month_partitions('payments',         0, 12);
SELECT app_ensure_month_partitions('booking_outbox',   0, 12);
SELECT app_drop_partitions_older_than('flights', (date_trunc('month', now()) - interval '24 months')::date);
```

**What happens when a partition is missing:** the insert **fails loudly** with
`no partition of relation "<parent>" found for row`. There is never a silently dropped row. If
bookings start failing with that error, a month's partition was not pre-created — create it and
retry. Always keep partitions created well ahead of the departure dates you accept bookings for.

Dropping follows `PARTITION_RETENTION_MONTHS` (default 24): only *departed* months past retention
are dropped. Dropping is a metadata operation on a whole month (`DROP TABLE`), not a row-by-row
delete.

---

## 8. Monitor the outbox

The projector lags when it cannot keep up or is not running. Query unpublished backlog:

```sql
-- coordinator
SELECT count(*) AS unpublished,
       max(now() - created_at) AS oldest_age,
       count(*) FILTER (WHERE attempts >= 10) AS parked
  FROM booking_outbox
 WHERE published = false;
```

- Backlog rising steadily ⇒ the projector is not running, or `OUTBOX_BATCH_SIZE`/`OUTBOX_POLL_INTERVAL_MS`
  are too small for the write rate. Scale the workers service or raise the batch size.
- `parked > 0` ⇒ rows exhausted `OUTBOX_MAX_ATTEMPTS` and are sitting unpublished with `last_error`.
  Inspect them: `SELECT event_id, event_type, attempts, last_error FROM booking_outbox WHERE published = false AND attempts >= 10;`
  Fix the projection bug, then reset `attempts` to 0 so the poller retries.

The read-model lag surfaced in the `x-read-model-lag-ms` header derives from the same pipeline; see
section 14 for the "read model stale" playbook (and section 16 for the Prometheus alerts).

---

## 9. Reconcile stuck sagas

```bash
npm run saga:reconcile
```

Finds `payments` rows in a non-terminal `saga_state` (`RESERVED`, `AUTHORIZING`, `AUTHORIZED`,
`CAPTURING`, `CAPTURED`, `COMPENSATING`) older than expected and re-drives them: authorize/capture a
sequence that stalled before completion, or release the hold if it should have compensated. Because
`saga_state` is persisted, reconciliation is a database read, not a guess. It is safe to run
repeatedly — every step is an idempotent, conditional, single-shard update.

---

## 10. Run the oversell audit

```bash
npm run audit:oversell
```

This audits the **booking side** — the inventory the API actually sold — and is different from the
loader-side data-quality checks in [DATA_LOADING.md](DATA_LOADING.md). It checks, per (flight, cabin):

- `available_seats + held_seats <= total_seats` (the `inv_capacity` invariant) for every counter row.
- `available_seats >= 0`.
- Counts of live bookings (`PENDING`/`CONFIRMED`) that have a seat number do not exceed the number of
  distinct seats sold, and no seat number is held by more than one live booking (the `uq_live_seat`
  invariant).

**Reading the output:** a clean run prints zero violations. Any row printed is a correctness alarm,
not a warning — it means a constraint that is supposed to be impossible to violate has been violated
(which normally means the database was manipulated out of band, e.g. a `SET session_replication_role`
or an out-of-band import). Capture the rows, then investigate the migration/loader that produced them.
The audit only reads; it never repairs.

---

## 11. Scale the API tier

The API is stateless. Scale it horizontally:

```bash
# Docker
docker compose up -d --scale api=4

# or run named instances directly
npm run start:node-a & npm run start:node-b & npm run start:node-c &
```

Give each instance a distinct `NODE_ID`; it appears in every log line, in the `x-node-id` response
header and in `bookings.node_id`, which is how you attribute a booking to an instance. Keep
`PG_POOL_MAX` per instance small enough that `instances × PG_POOL_MAX` stays under the coordinator's
(or PgBouncer's) `max_client_conn`.

---

## 12. Rotate JWT secrets

Access tokens are stateless: rotating `JWT_ACCESS_SECRET` cannot be undone for tokens already issued,
so they simply stop validating within `JWT_ACCESS_TTL` (default 15m). Refresh tokens live in
`refresh_tokens` and are revocable server-side.

**Rotating `JWT_REFRESH_SECRET` invalidates every existing refresh token**, which logs every user out
on their next refresh. If you want a controlled rollout rather than a mass logout, revoke in the
database first so the invalidation is recorded and auditable:

1. Revoke all refresh tokens for the affected users so no client silently keeps a session:
   `revokeAllForUser(userId)` (the refresh-token repository operation) for each user, or a bulk
   `UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL;` on the coordinator in a
   maintenance window.
2. Update `JWT_REFRESH_SECRET` (and `JWT_ACCESS_SECRET` if rotating both) in the secret store, then
   roll the API instances.
3. Users re-authenticate. Because a presented-but-rotated token revokes its whole family, a stolen
   token cannot quietly outlive the rotation.

Never reuse a dev secret (`dev-only-*-change-me`) in a deployed environment.

---

## 13. Backup and restore, per component

| Component | What to back up | Restore expectation |
|---|---|---|
| Citus coordinator | catalog + distributed table metadata; the *data* lives on workers | restore workers first, then the coordinator catalog; `citus` reconstructs placement from the catalog |
| Citus workers | the shard data (`pg_dump` per shard, or physical/base backup) | point-in-time per worker; shard files must match the coordinator catalog |
| Read model | `flight_availability` + `projection_state` | **optional** — it is a projection; `npm run readmodel:reproject` rebuilds it from the write model |
| Redis | the appendonly file | **optional** — holds/idempotency are conveniences; the DB constraints are authoritative, so an empty Redis is safe (at worst a replayed request is re-checked against the index) |
| `user_bookings` / `refresh_tokens` | these are *in* the write cluster (distributed by `user_id`) | rebuilt for `user_bookings` by reprojection; `refresh_tokens` loss just forces re-login |

The key asymmetry: only the **write cluster** is authoritative. Everything else is reconstructible.
Prefer restoring the write cluster to a consistent point and letting projections rebuild over trying
to restore every store to the same instant.

---

## 14. Incident playbooks

### "Bookings are failing with `SOLD_OUT` everywhere"

Ask first: **is the counter wrong, or is the flight genuinely full?**

1. Confirm the flight is not actually sold out:
   `SELECT flight_id, cabin, total_seats, available_seats, held_seats FROM flight_inventory WHERE flight_id = $1;`
   on the coordinator.
2. If `available_seats` is 0 but `held_seats` is large and flat, holds are not being released.
   Check the reaper (section 14, "hold reaper not firing"). A stalled reaper leaks `held_seats` and
   makes a flight look full.
3. Run `npm run audit:oversell`. If it reports violations, the counter has been corrupted out of
   band — capture the rows and escalate; do **not** hand-edit counters without an incident record.
4. If the counter is genuinely consistent and `total_seats` looks too low, the loader wrote the wrong
   capacity (see [DATA_LOADING.md](DATA_LOADING.md), section on inventory). Fix the loader and
   correct `flight_inventory` for the affected flights.

### "Payment failures are spiking"

- Check `PAYMENT_FAILURE_RATE` in the environment. Any value above `0.0` deliberately injects
  failures to exercise compensation; `0.35` under load will look like an outage but is intended.
- If it is `0.0` and failures are real, look at `payments.failure_reason` and confirm compensating
  releases are happening: `available_seats` should fall back to its pre-booking value for each failed
  booking. If holds are not released, the compensation path is failing — check the API/worker logs for
  `BOOKING_SAGA_COMPENSATE` results, then run `npm run saga:reconcile`.

### "The read model is stale"

1. Is the projector running? `docker compose --profile workers ps` (or check the workers process).
2. Check backlog (section 8). A growing backlog with a running projector means throughput, not a
   crash: raise `OUTBOX_BATCH_SIZE`, lower `OUTBOX_POLL_INTERVAL_MS`, or add worker replicas.
3. Confirm the `x-read-model-lag-ms` header exceeds `READMODEL_LAG_SLA_SECONDS` before treating it as
   an incident — some lag is by design.
4. Worst case, rebuild: `npm run readmodel:reproject`. It replays the write model into
   `flight_availability`; search serves stale-but-labelled data until it catches up.

### "The hold reaper is not firing"

Symptom: `PENDING` bookings never transition to `EXPIRED`, and `held_seats` climbs.

1. Confirm the reaper is running (`npm run reaper:run`, or `docker compose --profile workers up -d`
   for the dedicated workers service). In the compose topology the API has
   `WORKERS_ENABLED=false`, so starting the API does **not** start the reaper.
2. Check for expired holds it should have caught:
   `SELECT count(*) FROM bookings WHERE status = 'PENDING' AND hold_expires_at < now();`
3. If the count is high and the reaper is running, raise `REAPER_BATCH_SIZE` — the sweep is
   batched and may simply be behind. The sweep uses the partial index
   `idx_bookings_hold_expiry ON bookings (hold_expires_at) WHERE status = 'PENDING'`, so it stays
   cheap even as expired rows accumulate.
4. If the reaper process is down, restart it. It is idempotent: a missed sweep is not a correctness
   problem, only a latency one — the seat is still not oversold because the counter was decremented
   at reserve time.

---

## 15. Bulk load and data validation

```bash
# Load (idempotent; resumes from tmp/backfill.checkpoint.json unless --no-resume).
npm run backfill -- --source ndjson --input ./export --outbox --reproject
npm run backfill -- --source synthetic --start 2027-01-01 --days 30 --flights-per-day 50

# Validate the loaded window. Exit 1 on any violation; --strict also fails warnings.
npm run validate:data -- --from 2027-01-01 --to 2027-01-31 --strict
```

Order matters: partitions are created before the first batch, and `--reproject` replays the outbox
so search sees the new flights. Without `--reproject` the loader's `FLIGHT_UPSERTED` events remain
unpublished (the worker will eventually project them; the flag just does it inline).

If `validate:data` reports a violation:

1. **`flights_without_inventory`** — the loader skipped inventory. Those flights cannot be booked.
   Re-run the same input; the loader is idempotent and will fill the gap.
2. **`inventory_accounting_mismatch`** — `total - available - held <> confirmed`. If the import
   created historical CONFIRMED bookings, this is the counter reconciliation step; re-running the
   NDJSON import recomputes it. Do not hand-edit counters.
3. **partition horizon** — run `npm run partitions:maintain`, then re-run the validator.
4. **`outbox_backlog`** — expected during a large load with workers stopped. Start/settle the
   workers, or use `--reproject`, then re-check.

Full contract: [DATA_LOADING.md](DATA_LOADING.md).

---

## 16. Observability and alerts

Prometheus scrapes two jobs: the API (`:3000/metrics`) and the worker process (`:9464/metrics`).
The worker scrape is not optional for the outbox alerts — `airline_outbox_pending_events`,
`airline_outbox_lag_seconds` and `airline_read_model_lag_seconds` are written by the worker
process, so scraping only the API leaves those rules permanently silent.

Local stack:

```bash
docker compose --profile workers --profile observability up -d
open http://localhost:9090/alerts     # firing/pending rules
open http://localhost:9090/graph      # ad-hoc PromQL
```

Rules live in `deploy/observability/alerts.yml`; verify before applying:

```bash
promtool check rules deploy/observability/alerts.yml
```

The useful first queries during an incident:

```promql
# Request rate and error ratio by route
sum by (route) (rate(airline_http_requests_total[5m]))
sum by (route) (rate(airline_http_requests_total{status=~"5.."}[5m]))

# Booking outcomes — 409s are back-pressure, not failures
sum by (status, result) (rate(airline_bookings_total[5m]))

# Is the projector keeping up?
airline_outbox_pending_events
airline_outbox_lag_seconds
airline_read_model_lag_seconds

# Which database pool is slow?
histogram_quantile(0.95, sum by (le, pool) (rate(airline_db_query_duration_ms_bucket[5m])))
```

<a id="incident-api-5xx"></a>
### Incident: API 5xx

1. Hit `/api/health/ready` on each replica; a 503 means that replica has no write model and the
   Service has already (or should have) removed it.
2. Split `airline_db_errors_total` by `pool` and `code`. `40001`/`40P01` under load means retry
   exhaustion (contention); `08006`/`57P01` means the coordinator or a worker vanished.
3. If only one route is failing, the problem is in that path, not the database: compare
   `airline_http_request_duration_ms` by route and the request-id in the logs.
4. Roll back the image if the 5xx started with a deploy; migrations are forward-only, so roll back
   code only when the schema change is backward-compatible (all current migrations are).

<a id="incident-latency"></a>
### Incident: latency

- Read path slow (`route="/api/flights..."`): read model database or projector lag. Check
  `airline_read_model_lag_seconds`; if lag is flat, the read database itself is saturated.
- Write path slow (`route="/api/bookings"`): per-flight inventory row contention is expected to a
  point. If p99 climbs with a flat 409 rate, look at coordinator CPU and PgBouncer
  `client_waiting_connections`.
- Slow across every route with low DB CPU: the API pods are CPU-throttled. Compare resource limits
  with actual usage; raise the limit before raising the HPA ceiling.

<a id="incident-instance-down"></a>
### Incident: instance down

`up{job="airline-api"} == 0` means the scrape failed: the process crashed, lost its port, or
`METRICS_ENABLED` was turned off. Check `kubectl -n airline get pods` (or `docker compose ps`), then
the previous logs for an unhandled rejection or a failed migration at boot.

<a id="incident-booking-failures"></a>
### Incident: booking failures

1. `PAYMENT_FAILURE_RATE > 0` explains `PAYMENT_FAILED`; it is a test hook and must be `0` in
   production.
2. Otherwise compare `airline_inventory_reservations_total` by `result`: `SOLD_OUT` is demand,
   `VERSION_CONFLICT`/`RETRY_EXHAUSTED` is contention.
3. If every attempt is refused on a flight that should have seats, run section 10's audit and check
   the loader's counters (section 15).
4. If bookings are accepted but never reach `CONFIRMED`, the saga worker is not running. Confirm the
   workers Deployment is healthy and `airline_booking_saga_steps_total` is advancing.

<a id="incident-outbox-backlog"></a>
### Incident: outbox backlog / stale read model

1. Is the worker process running and scrapeable? `up{job="airline-workers"}` and
   `airline_outbox_pending_events`.
2. Running but behind: raise `OUTBOX_BATCH_SIZE`, lower `OUTBOX_POLL_INTERVAL_MS`, or add worker
   replicas (section 8).
3. Running but parked: inspect `attempts`/`last_error` (section 8), fix the projection bug, reset
   `attempts`.
4. Do not "fix" staleness by writing the read model by hand. Rebuild with
   `npm run readmodel:reproject`; it is idempotent and ordered.

<a id="incident-database"></a>
### Incident: database

- `airline_db_errors_total` rising on `pool="write"`: coordinator/worker health, then PgBouncer
  saturation. `SELECT * FROM citus_check_cluster_node_health();` on the coordinator.
- Rising on `pool="read"`: the read-model database; search degrades but booking does not. Fail over
  or restore (section 13).
- Latency without errors: check shard balance (`npm run db:status`), then whether one tenant/flight
  is hotspotting a single shard. Citus rebalances with `citus_rebalance_start()` (section 6).

<a id="incident-inventory"></a>
### Incident: inventory refusals

A spike in `SOLD_OUT`/`NO_INVENTORY` is either real demand or bad counters. Run
`npm run audit:oversell` first; if it is clean, compare `airline_inventory_available_seats` with the
loader's totals for the affected flights.

---

## 17. Chaos test: worker down during bookings

```bash
node scripts/chaos-worker-down.js                 # print the plan; no changes
node scripts/chaos-worker-down.js --execute       # stop workers, book, restart, verify
```

The script stops the `workers` service, creates a fixture flight, books N seats, and asserts that
(a) every booking succeeded with the worker down, (b) the read model did not advance and the outbox
grew, (c) after restart the projection matches the write model with no pending events, and (d) the
inventory audit is clean. It cleans up the fixture unless `--keep`.

For Kubernetes, where the workers are a Deployment rather than a compose service:

```bash
node scripts/chaos-worker-down.js --execute \
  --down-cmd "kubectl -n airline scale deployment/airline-workers --replicas=0" \
  --up-cmd   "kubectl -n airline scale deployment/airline-workers --replicas=2"
```

If the workers are stopped out of band, pass `--skip-worker-control`; the script still performs the
bookings and the recovery assertions after you restart them (`--timeout` bounds the wait).

Load scenarios (k6) live in [load/k6/README.md](../load/k6/README.md).

---

## 18. Deploy with Kubernetes

See [deploy/k8s/README.md](../deploy/k8s/README.md) for the manifests, apply order, probes and
scaling. The short version:

```bash
kubectl -n airline delete job airline-migrate --ignore-not-found
kubectl -n airline apply -f deploy/k8s/migrate-job.yaml
kubectl -n airline wait --for=condition=complete job/airline-migrate --timeout=10m
kubectl -n airline set image deployment/airline-api api=ghcr.io/acme/airline@sha256:...
kubectl -n airline set image deployment/airline-workers workers=ghcr.io/acme/airline@sha256:...
kubectl -n airline rollout status deployment/airline-api
```

Migrations run **before** the new image, never as an init container: a rolling update runs one init
per replica, and a migration that must execute once (or that takes a lock) should not race itself.

