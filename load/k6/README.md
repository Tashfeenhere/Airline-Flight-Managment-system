# k6 load scenarios

Three scenarios, each answering a different question. All of them hit the public HTTP
API, so a run measures the whole stack — Express, PgBouncer, Citus, the projector — not
a service function in isolation.

| Script | Question | Reads / writes |
| --- | --- | --- |
| `smoke.js` | Did the deploy break anything? | health, metrics, one search, one booking + replay |
| `search.js` | Can the read model serve the target rate? | `POST` nothing; `GET /api/flights/search` |
| `booking.js` | Does the write path stay correct under contention? | `GET` availability, `POST` bookings |

## Prerequisites

1. A running stack (`docker compose up`, or `npm start` against a local cluster).
2. Migrations applied and partitions covering the dates used: `npm run migrate`.
3. Data in the read model. Synthetic data is enough:

   ```bash
   npm run backfill -- --source synthetic --start 2027-03-01 --days 1 \
     --flights-per-day 50 --outbox --reproject
   ```

   Search reads `flight_availability`; if the date has no projected rows the scenario
   reports a high `search_empty_results` rate (and fails its threshold).

4. [k6](https://k6.io/docs/get-started/installation/) installed. It is deliberately not
   an npm dependency: it is a Go binary, and pinning it in `package.json` would suggest
   `npm install` installs it, which it does not.

## Smoke

```bash
k6 run load/k6/smoke.js

# Including search and a booking (the flight must have at least two free seats):
k6 run -e ORIGIN=ISB -e DESTINATION=DXB -e DEPARTURE_DATE=2027-03-01 \
       -e FLIGHT_ID=<uuid> load/k6/smoke.js
```

Every check must pass (`checks: rate==1`) and no request may fail. The booking check
books one seat and then replays the same idempotency key, asserting a 200, the
`Idempotent-Replay: true` header, and the same booking id — the three facts a retrying
client depends on. That leaves one real booking behind on the target; clean it with
`npm run oversell:audit` (read-only) or the fixture cleanup in `tests/helpers/db.js`
when running repeatedly against a shared environment.

`/metrics` may legitimately answer 404 when metrics are disabled, so the smoke test
accepts either 200 or 404 there.

## Search

```bash
k6 run -e ORIGIN=ISB -e DESTINATION=DXB -e DEPARTURE_DATE=2027-03-01 \
       -e RATE=50 -e DURATION=2m load/k6/search.js
```

Thresholds: `http_req_failed < 1%`, p95 < 400 ms, p99 < 900 ms, checks > 99%, and fewer
than 5% empty result sets. Watch `airline_read_model_lag_seconds` on `/metrics` during
the run; `search_read_model_lag_ms` in the k6 summary is the client-observed version of
the same number.

## Booking

```bash
k6 run -e FLIGHT_ID=<uuid> -e RATE=20 -e DURATION=60s load/k6/booking.js

# Prove idempotency under load: every VU repeats one key, so at most one seat is sold.
k6 run -e FLIGHT_ID=<uuid> -e REPLAY_KEY=load-replay-1 load/k6/booking.js

# Then prove the counters still add up:
node scripts/oversell-audit.js --flight-id <uuid> --departure-date 2027-03-01
```

Outcomes are counted, not conflated:

| Metric | Meaning |
| --- | --- |
| `booking_confirmed_total` | 201 — a new confirmed booking |
| `booking_replayed_total` | 200 — same key, same booking, no second seat |
| `booking_refused_total` | 409 — sold out, seat taken, or version conflict |
| `booking_throttled_total` | 429 — the per-IP booking limiter fired |
| `booking_unauthorised_total` | 401/403 — supply `-e TOKEN=...` |
| `booking_server_error_rate` | must stay below 1% |

A sold-out run is a **pass**: 409 is the conditional UPDATE correctly refusing to
oversell. What must never happen is a 5xx, a 201 without a booking reference, a replay
that creates a second booking, or a negative counter.

### Rate limits

All VUs share one source IP, so the booking limiter (default
`max(10, API_RATE_LIMIT_PER_MIN / 6)` = 100/min) is reached quickly at rates above
~1.6/s. For a load run, either raise `API_RATE_LIMIT_PER_MIN` on the target (e.g.
`API_RATE_LIMIT_PER_MIN=60000`) or run with `RATE_LIMIT_ENABLED=false`. Leaving the
default and reading `booking_throttled_total` is a valid way to measure the limiter
itself — just do not read it as database capacity.

When `REQUIRE_AUTH_FOR_BOOKING=true`, pass `-e TOKEN=<jwt>`; the guest identity is
otherwise used.

## Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `BASE_URL` | `http://127.0.0.1:3000` | all |
| `ORIGIN` / `DESTINATION` | `ISB` / `DXB` (search), unset (smoke) | search, smoke |
| `DEPARTURE_DATE` | today + 30 days | all |
| `FLIGHT_ID` | required for booking | booking, smoke |
| `CABIN` | `ECONOMY` | booking, smoke |
| `TOKEN` | unset (guest) | booking, smoke |
| `RATE` | 25 search / 10 booking | search, booking |
| `DURATION` | `2m` | search, booking |
| `PRE_ALLOCATED_VUS` / `MAX_VUS` | 25/150 search, 20/200 booking | search, booking |
| `REPLAY_KEY` | unset | booking |
| `USE_EXPECTED_VERSION` | `false` | booking |

## Reading a failure

- **`http_req_failed` high on search, all 500s** — the read pool or projector's
  database is down; check `/api/health/ready`.
- **Search p95 rises while booking is flat** — read model contention or projector lag,
  not the write path.
- **Booking p99 above 1.5 s with 409s** — contention on one inventory row is the
  expected shape; check `airline_inventory_reservations_total` by result before
  suspecting the database.
- **Booking 5xx under load** — inspect `airline_db_errors_total`; serialization
  failures are retried by `transactionRetry`, so a surfaced 5xx means retries were
  exhausted (a real saturation signal).
