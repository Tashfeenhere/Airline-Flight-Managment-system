# Loading your own data (users and flights)

This is the contract for loading **~50M flights and ~100k users** into the write model. It is
written for two audiences:

- the in-repo Node loader (`scripts/backfill.js`) used for development fixtures, smaller imports
  and legacy MongoDB exports. It implements every rule below, is idempotent, and checkpoints.
- an external bulk loader (a Python `COPY` pipeline, for example) that must produce rows this
  schema accepts. The rules below are the contract; the SQL and the data-quality queries are
  deliberately copy-pasteable.

`npm run seed:dev` inserts a *tiny* development fixture and is **not** the way to load production
data. `scripts/backfill.js` is the supported loader in this repo; at 50M rows an external `COPY`
pipeline is still the right tool (see §6), and `scripts/validate-data.js` verifies either one.

---

## 0. TL;DR checklist

1. Create month partitions for **every** departure month you will load, before inserting any row.
2. Load in this order: reference tables → `users` → `flights` → `flight_inventory` → historical
   `bookings`/`payments` (if migrating).
3. Generate UUIDv7 ids yourself (a snippet is below). For migrated legacy ids, use UUIDv5 so a
   re-run maps the same ObjectId to the same UUID.
4. Make every write idempotent with `ON CONFLICT` on the right target.
5. `flight_inventory` must have one row per `(flight, cabin)` with counters that match the capacity
   you intend to sell. If you import historical bookings, reconcile the counters afterwards (§7.3).
6. Run the data-quality checks in section 8 before trusting the load — `npm run validate:data`
   runs them all.

---

## 0.1 The in-repo loader

```bash
# Synthetic fixture (deterministic; resumable through tmp/backfill.checkpoint.json).
npm run backfill -- --source synthetic --start 2027-01-01 --days 30 --flights-per-day 50 \
  --outbox --reproject

# Or import a legacy NDJSON export (see docs/MIGRATION_FROM_MONGODB.md for the shapes).
npm run backfill -- --source ndjson --input ./export --outbox --reproject

# Inspect without writing.
npm run backfill:dry -- --source synthetic --start 2027-01-01 --days 1

# Verify. Non-zero exit on any violation; --strict also fails on warnings.
npm run validate:data -- --from 2027-01-01 --to 2027-01-31 --strict
```

Both scripts document their full option set with `--help`. Three properties are worth knowing:

- **Partition preconditions are enforced up front.** The loader derives the months from the input
  and calls `app_ensure_month_partitions` before the first batch; a month outside the horizon is a
  startup error, not a row-by-row failure.
- **Ids are deterministic.** Legacy ObjectIds are mapped through UUIDv5 with a fixed namespace, so
  importing the same export twice cannot duplicate users, flights or bookings. Synthetic flight ids
  are a pure function of their global index, which is what makes resume exact.
- **Counters are reconciled for historical bookings.** A legacy CONFIRMED booking decrements
  `available_seats`; the loader recomputes it from the imported booking count rather than trusting
  the source counter, which may have drifted.

`validate:data` checks the invariants in §8 plus partition coverage, outbox backlog, read-model
consistency for a window, and the accounting equalities
(`total - available - held = confirmed`) that the booking path depends on. It never writes.

Everything below is derived from `db/migrations/002-reference-tables.js`,
`003-flights-and-inventory.js`, `001-extensions-and-helpers.js` and `007-initial-partitions.js`.
Where the schema enforces something, the constraint is named so you can find it.

---

## 1. Target schema

### 1.1 Reference tables (`db/migrations/002`)

These are small and shared; load them first. In a Citus cluster they are **reference tables**
(replicated to every worker), so joins stay local.

**`airlines`**

| Column | Type | Nullable | Default | Constraint |
|---|---|---|---|---|
| `code` | `text` | no | — | PRIMARY KEY |
| `name` | `text` | no | — | |
| `country` | `text` | yes | — | |
| `is_active` | `boolean` | no | `true` | |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | |

**`airports`**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `code` | `text` | no | — (PRIMARY KEY) |
| `name` | `text` | no | — |
| `city` | `text` | yes | — |
| `country` | `text` | yes | — |
| `tz` | `text` | yes | — (IANA name, e.g. `Asia/Karachi`) |
| `created_at` | `timestamptz` | no | `now()` |
| `updated_at` | `timestamptz` | no | `now()` |

**`cabins`**

| Column | Type | Nullable | Default | Constraint |
|---|---|---|---|---|
| `code` | `text` | no | — | PRIMARY KEY |
| `name` | `text` | no | — | |
| `rank` | `smallint` | no | `0` | |
| `created_at` | `timestamptz` | no | `now()` | |

The seeded cabin codes are `ECONOMY`, `PREMIUM_ECONOMY`, `BUSINESS`, `FIRST`. `flight_inventory.cabin`
has **no foreign key** to this table, so an orphan cabin code is a data-quality bug you must check
for yourself (section 8).

**`aircraft_types`**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `code` | `text` | no | — (PRIMARY KEY) |
| `name` | `text` | no | — |
| `manufacturer` | `text` | yes | — |
| `created_at` | `timestamptz` | no | `now()` |

**`seat_map_templates`** — the seat map lives here (per aircraft type), not per flight.

| Column | Type | Nullable | Default | Constraint |
|---|---|---|---|---|
| `aircraft_type` | `text` | no | — | FK → `aircraft_types(code)`; part of PK |
| `cabin` | `text` | no | — | FK → `cabins(code)`; part of PK |
| `seat_number` | `text` | no | — | part of PK |
| `seat_position` | `text` | yes | — | CHECK in (`WINDOW`,`MIDDLE`,`AISLE`) or NULL |
| `is_exit_row` | `boolean` | no | `false` | |

Primary key: `(aircraft_type, cabin, seat_number)`.

### 1.2 `users` (`db/migrations/002`)

| Column | Type | Nullable | Default | Constraint |
|---|---|---|---|---|
| `id` | `uuid` | no | `app_uuidv7()` | PRIMARY KEY |
| `email` | `text` | no | — | `uq_users_email` UNIQUE; `ck_users_email_lowercase` CHECK `email = lower(email)` |
| `password_hash` | `text` | no | — | |
| `role` | `text` | no | `'PASSENGER'` | CHECK in (`PASSENGER`,`AGENT`,`ADMIN`) |
| `full_name` | `text` | yes | — | |
| `phone` | `text` | yes | — | |
| `is_active` | `boolean` | no | `true` | |
| `last_login_at` | `timestamptz` | yes | — | |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | |

Two things bite loaders: **`email` must already be lower-case** (the CHECK rejects `A@b.com`), and
`password_hash` is **not** a plain password — the application hashes with Argon2 when
`@node-rs/argon2` is available. If your loader supplies a password, it must supply the same hash
format the app verifies, or the account cannot log in; for imported accounts it is usually better to
insert an unusable placeholder hash and force a password reset.

### 1.3 `flights` (`db/migrations/003`) — PARTITIONED BY RANGE (`departure_date`)

| Column | Type | Nullable | Default | Constraint |
|---|---|---|---|---|
| `flight_id` | `uuid` | no | `app_uuidv7()` | part of PK; the **distribution column** |
| `flight_number` | `text` | no | — | |
| `airline_code` | `text` | no | — | *(no FK — validate yourself)* |
| `origin` | `text` | no | — | *ck_flights_route*: `origin <> destination` |
| `destination` | `text` | no | — | |
| `departure_date` | `date` | no | — | part of PK; **partition key** |
| `departure_time` | `timestamptz` | no | — | |
| `arrival_time` | `timestamptz` | no | — | *ck_flights_time_order*: `arrival_time > departure_time` |
| `aircraft_type` | `text` | no | — | *(no FK — validate yourself)* |
| `base_price` | `numeric(10,2)` | no | — | CHECK `>= 0` |
| `currency` | `text` | no | `'USD'` | |
| `status` | `text` | no | `'SCHEDULED'` | CHECK in (`SCHEDULED`,`ACTIVE`,`DEPARTED`,`COMPLETED`,`CANCELLED`) |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | |

Constraints:

- PRIMARY KEY `(flight_id, departure_date)` — includes the distribution column (Citus requires it)
  and the partition key (PostgreSQL requires it).
- `ck_flights_departure_date`: `departure_date = (departure_time AT TIME ZONE 'UTC')::date`.
  **`departure_date` is derived, not free.** If you set them inconsistently, the whole row is
  rejected. Compute `departure_date` from `departure_time` in UTC; never send an independent value.

### 1.4 `flight_inventory` (`db/migrations/003`) — PARTITIONED BY RANGE (`departure_date`)

| Column | Type | Nullable | Default | Constraint |
|---|---|---|---|---|
| `flight_id` | `uuid` | no | — | part of PK; distribution column |
| `departure_date` | `date` | no | — | part of PK; partition key |
| `cabin` | `text` | no | — | part of PK; *(no FK to cabins)* |
| `shard_no` | `smallint` | no | `0` | part of PK; `ck_inventory_shard_non_negative` `>= 0` |
| `total_seats` | `integer` | no | — | CHECK `>= 0` |
| `available_seats` | `integer` | no | — | CHECK `>= 0` |
| `held_seats` | `integer` | no | `0` | CHECK `>= 0` |
| `version` | `bigint` | no | `0` | |
| `updated_at` | `timestamptz` | no | `now()` | |

Constraints:

- PRIMARY KEY `(flight_id, departure_date, cabin, shard_no)`.
- `inv_capacity`: `available_seats + held_seats <= total_seats`.
- The default `INVENTORY_STRATEGY=single` uses exactly one row per `(flight, cabin)` with
  `shard_no = 0`. **Write `shard_no = 0`.** Leave the `sharded` strategy to the application; a loader
  should never split a counter.

**The counters must equal the capacity you intend to sell:** set `total_seats` to the cabin's
capacity and set `available_seats = total_seats` with `held_seats = 0`. If you set
`available_seats < total_seats`, you have already "sold" seats that were never sold.

---

## 2. Generating ids (UUIDv7)

Primary keys are UUIDv7: the leading 48 bits are a big-endian millisecond timestamp, byte 6's high
nibble is the version (`7`), and byte 8's high bits are the RFC 4122 variant (`10`). Time-ordering
keeps inserts at the right edge of the B-tree. **Generate ids in the loader** so you can reference
them across batches; PostgreSQL's `app_uuidv7()` is a server-side fallback for ad-hoc SQL only.

```python
import os
import time
import uuid


def uuid7() -> uuid.UUID:
    """A real RFC 9562 UUIDv7: 48-bit ms timestamp, version nibble 7, variant 10."""
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = os.urandom(10)
    b = bytearray(16)
    b[0:6] = ts_ms.to_bytes(6, "big")     # 48-bit big-endian millisecond timestamp
    b[6:16] = rand                        # 80 bits of randomness
    b[6] = (b[6] & 0x0F) | 0x70          # version nibble -> 7
    b[8] = (b[8] & 0x3F) | 0x80          # RFC 4122 variant -> 10xxxxxx
    return uuid.UUID(bytes=bytes(b))
```

Libraries such as `uuid-utils` or `uuid6` also produce valid v7 values if you prefer a dependency.

**Server-side fallback.** PostgreSQL 18 has a native `uuidv7()`. On older servers the migrations
define `app_uuidv7()`, which uses the native function when present and otherwise falls back to a
plpgsql implementation of the same byte layout (`app_uuidv7_fallback()`, migration `001`). So
`SELECT app_uuidv7()` is a valid id generator in ad-hoc SQL anywhere — but a bulk loader should still
generate its own so it does not depend on a round trip per row.

---

## 3. Partitioning is the #1 footgun

These relations are `PARTITION BY RANGE (departure_date)` with **monthly** partitions named
`<parent>_p<YYYYMM>`:

- write model: `flights`, `flight_inventory`, `bookings`, `payments`, `booking_outbox`
- read model: `flight_availability`

**Before you insert any row with a `departure_date` in month M, the partition for M must exist.**
Otherwise the entire statement fails with:

```
ERROR: no partition of relation "flights" found for row
```

There is no partial success and no silently dropped row — the insert fails loudly. That is the good
news: you will notice immediately. The bad news is that a single missing month makes a 50M-row load
fail.

### Pre-create partitions (recommended)

`app_ensure_month_partitions(parent, months_behind, months_ahead)` creates every monthly partition
from `months_behind` months ago through `months_ahead` months from now, and returns how many it
created. It is idempotent (existing partitions are skipped). The function signature is
`app_ensure_month_partitions(p_parent text, p_months_behind int DEFAULT 1, p_months_ahead int DEFAULT 6)`.

```sql
-- Create 24 months ahead and 1 month behind (the default maintenance window):
SELECT app_ensure_month_partitions('flights',          1, 24);
SELECT app_ensure_month_partitions('flight_inventory', 1, 24);
SELECT app_ensure_month_partitions('bookings',         1, 24);
SELECT app_ensure_month_partitions('payments',         1, 24);
SELECT app_ensure_month_partitions('booking_outbox',   1, 24);

-- Read model (separate database):
SELECT app_ensure_month_partitions('flight_availability', 1, 24);
```

**For a bulk load spanning the past, you must widen `months_behind` too.** The window starts
`months_behind` months *before today* and covers `months_behind + months_ahead + 1` months total. If
you are loading flights from 2019-01 to 2030-12 and today is 2026-10, set `months_behind` to the
number of months from today back to 2019-01 (about 93) and `months_ahead` to the number forward to
2030-12 (about 50):

```sql
SELECT app_ensure_month_partitions('flights',          100, 60);
SELECT app_ensure_month_partitions('flight_inventory', 100, 60);
SELECT app_ensure_month_partitions('bookings',         100, 60);
SELECT app_ensure_month_partitions('payments',         100, 60);
SELECT app_ensure_month_partitions('booking_outbox',   100, 60);
```

Run this on the **coordinator**. On a Citus cluster, creating a partition of a distributed parent
automatically creates the distributed child on the right workers; do not create partitions directly
on a worker.

### The equivalent raw DDL

If you prefer explicit control (looping in the loader), the helper does exactly this per month:

```sql
CREATE TABLE IF NOT EXISTS flights_p202611
  PARTITION OF flights
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE TABLE IF NOT EXISTS flight_inventory_p202611
  PARTITION OF flight_inventory
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
```

The naming convention is `<parent>_p<YYYYMM>`, and the range is always
`[first-of-month, first-of-next-month)`. Use `CREATE TABLE IF NOT EXISTS` so the loop is re-runnable.

### Verify before loading

```sql
SELECT c.relname AS partition
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
 WHERE p.relname = 'flights'
 ORDER BY c.relname;
```

---

## 4. Required loading order

Load in this order; each step assumes the previous one is done:

1. **Reference tables** — `airlines`, `airports`, `cabins`, `aircraft_types`, then
   `seat_map_templates` (which has foreign keys to `aircraft_types` and `cabins`).
2. **`users`** — ~100k rows; the API needs them for auth, and bookings reference a `user_id`.
3. **`flights`** — the flight instances.
4. **`flight_inventory`** — one row per `(flight, cabin)`.

**`flight_inventory` must exist before any booking can succeed.** The reserve statement is a
conditional `UPDATE ... WHERE available_seats >= n`; for a flight with no inventory row it updates
**zero rows**, and the API correctly answers `SOLD_OUT`. A flight with no inventory row is therefore
not "unlimited" — it is unbookable. Create inventory for every flight you intend to sell.

Reference data (airlines, airports, cabins, aircraft types, and their seat-map templates) is already
seeded by migration `009`; extend it rather than replacing it (`ON CONFLICT DO NOTHING`).

---

## 5. Idempotent loading

Loaders get re-run — after a crash, after a fix, after a partial month. Every write must be
idempotent. Use these exact `ON CONFLICT` targets (each is the table's key that the database can
enforce):

| Table | Conflict target |
|---|---|
| `airlines` | `(code)` |
| `airports` | `(code)` |
| `cabins` | `(code)` |
| `aircraft_types` | `(code)` |
| `seat_map_templates` | `(aircraft_type, cabin, seat_number)` |
| `users` | `(id)` — or `(email)` via `uq_users_email` if you key on email |
| `flights` | `(flight_id, departure_date)` |
| `flight_inventory` | `(flight_id, departure_date, cabin, shard_no)` |

Use `DO NOTHING` for immutable dimensions. For `flights`, `DO UPDATE` is usually what you want
(schedules are re-imported and revised), matching the application's own upsert:

```sql
INSERT INTO flights (
  flight_id, flight_number, airline_code, origin, destination, departure_date,
  departure_time, arrival_time, aircraft_type, base_price, currency, status
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (flight_id, departure_date) DO UPDATE SET
  flight_number  = EXCLUDED.flight_number,
  airline_code   = EXCLUDED.airline_code,
  origin         = EXCLUDED.origin,
  destination    = EXCLUDED.destination,
  departure_time = EXCLUDED.departure_time,
  arrival_time   = EXCLUDED.arrival_time,
  aircraft_type  = EXCLUDED.aircraft_type,
  base_price     = EXCLUDED.base_price,
  currency       = EXCLUDED.currency,
  status         = EXCLUDED.status,
  updated_at     = now();
```

For `flight_inventory`, never update the counters on re-run — `DO NOTHING` protects the live counts:

```sql
INSERT INTO flight_inventory
  (flight_id, departure_date, cabin, shard_no, total_seats, available_seats, held_seats)
VALUES ($1, $2, $3, 0, $4, $4, 0)
ON CONFLICT (flight_id, departure_date, cabin, shard_no) DO NOTHING;
```

`ON CONFLICT ... DO UPDATE` on a distributed table requires the conflict target to include the
distribution column; every target above does (`flight_id`, `user_id`, `code`, or the composite key
containing it).

### COPY vs row-by-row INSERT

- **`COPY` into a partitioned parent works and is the fastest path.** PostgreSQL routes each row to
  the correct partition; on Citus the coordinator routes to the correct shard. Do not insert into
  partitions directly.
- **`COPY` does not support `ON CONFLICT`.** For idempotent bulk loads, COPY into a `TEMP`/`UNLOGGED`
  staging table (on the coordinator) and then `INSERT ... SELECT ... ON CONFLICT` from it:

  ```sql
  CREATE TEMP TABLE flights_stage (LIKE flights INCLUDING DEFAULTS);
  -- COPY flights_stage FROM STDIN ...
  INSERT INTO flights SELECT * FROM flights_stage
  ON CONFLICT (flight_id, departure_date) DO NOTHING;
  TRUNCATE flights_stage;
  ```

- **A per-row `INSERT` loop over the coordinator is not viable at 50M rows.** Each statement is a
  network round trip *and* a routing decision; even at 5k rows/s that is hours of overhead. Use
  batched `executemany` only as a fallback when COPY is unavailable, in batches of a few thousand.

---

## 6. Throughput guidance

- **Batch size.** 10,000–50,000 rows per `COPY`/batch. Larger batches amortize round trips; too
  large and a single failure costs more to retry and holds a lock longer.
- **Driver settings.**
  - *psycopg 3*: `cursor.copy("COPY ... FROM STDIN WITH (FORMAT binary)")` — binary COPY is fastest.
    Set `autocommit=True` for the COPY phase, or commit per batch.
  - *asyncpg*: `await conn.copy_records_to_table(...)` for simple shapes, or
    `copy_from_query` for a `SELECT`. Use a pool sized to a small multiple of your workers, not
    thousands of connections.
  - Keep `PG_STATEMENT_TIMEOUT_MS` in mind if you use the app's connection settings; raw loaders
    should set their own, longer, `statement_timeout` for bulk statements.
- **Load in `departure_date` order.** Partitions are ordered by `departure_date`, so loading in date
  order means each batch touches one or two partitions, keeps the working set in cache, and — for a
  resumable loader — gives you a natural checkpoint. Loading in random order touches every partition
  in every batch and is much slower.
- **50M flights through the coordinator?** Only if the coordinator is sized for it (CPU, memory,
  and network). Coordinators route and merge; a bulk load makes them a bottleneck. If it is not
  sized for 50M rows, **connect directly to the worker that owns the target shard** and load the
  shard's partitions there (see the caveat below). A middle path that keeps the schema authoritative:
  `COPY` into a local staging table on the worker and use Citus's load helpers, or stage on a
  standalone PostgreSQL and attach.

> **Caveat for direct worker loads (advanced, and easy to get wrong).** Shards are physically named
> tables on the workers (e.g. `flights_102008`), and every row belongs on the shard chosen by
> `hash(flight_id)`. If you bypass the coordinator you must **respect the distribution column**:
> a row written to a shard it does not hash to is **invisible to the coordinator** — queries will
> never see it, joins will miss it, and no error is raised. It also bypasses coordinator-enforced
> shard consistency and any row-level policy. Use direct worker loads only if you have verified the
> shard mapping (`SELECT * FROM citus_shards;` on the coordinator) and you load each `flight_id`
> into its own shard. For most users the coordinator path is the right one.

---

## 7. A ready Python skeleton

A starting point you will adapt and own. psycopg 3, COPY-based with an `executemany` fallback,
batched, and resumable via a checkpoint on `departure_date`. Marked clearly: **adapt, do not ship
unchanged.**

```python
"""
load_flights.py — STARTER for the flights + inventory bulk loader.

You own this. Read docs/DATA_LOADING.md first. It is deliberately minimal:
it shows the shape (partitions -> COPY -> ON CONFLICT -> inventory), not
your business rules for fares, capacities or routes.

Install: pip install "psycopg[binary]"
Run:     COORDINATOR_DSN=postgres://airline:airline@host:5432/airline_inventory python load_flights.py
"""
from __future__ import annotations

import io
import os
import sys
import time
import uuid
from datetime import date, datetime, timezone
from typing import Iterable, Iterator

import psycopg

DSN = os.environ.get(
    "COORDINATOR_DSN", "postgres://airline:airline@127.0.0.1:5432/airline_inventory"
)
BATCH_SIZE = 20_000


# --- id generation ----------------------------------------------------------
def uuid7() -> uuid.UUID:
    """RFC 9562 UUIDv7 (48-bit ms timestamp, version 7, variant 10)."""
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    b = bytearray(16)
    b[0:6] = ts_ms.to_bytes(6, "big")
    b[6:16] = os.urandom(10)
    b[6] = (b[6] & 0x0F) | 0x70
    b[8] = (b[8] & 0x3F) | 0x80
    return uuid.UUID(bytes=bytes(b))


# --- partitioning -----------------------------------------------------------
PARENTS = ["flights", "flight_inventory", "bookings", "payments", "booking_outbox"]


def ensure_partitions(conn: psycopg.Connection, months_behind: int, months_ahead: int) -> None:
    """Create monthly partitions BEFORE any insert. Safe to re-run."""
    with conn.cursor() as cur:
        for parent in PARENTS:
            cur.execute(
                "SELECT app_ensure_month_partitions(%s, %s, %s)",
                (parent, months_behind, months_ahead),
            )
    conn.commit()


# --- source rows ------------------------------------------------------------
def iter_flights() -> Iterator[dict]:
    """
    Yield flight dicts. Replace this with YOUR source (CSV, API, generated).

    Required keys: flight_number, airline_code, origin, destination,
    departure_time (datetime, tz-aware, UTC), arrival_time, aircraft_type,
    base_price, currency, status.
    """
    raise NotImplementedError("wire this to your data source")


def to_departure_date(departure_time: datetime) -> date:
    """departure_date is derived, not independent (ck_flights_departure_date)."""
    return departure_time.astimezone(timezone.utc).date()


# --- loading ----------------------------------------------------------------
FLIGHT_COPY = (
    "COPY flights_stage (flight_id, flight_number, airline_code, origin, destination, "
    "departure_date, departure_time, arrival_time, aircraft_type, base_price, currency, status) "
    "FROM STDIN WITH (FORMAT binary)"
)


def load_flight_batch(conn: psycopg.Connection, rows: list[dict]) -> None:
    """COPY a batch into a staging table, then idempotently merge into flights."""
    with conn.cursor() as cur:
        cur.execute("CREATE TEMP TABLE IF NOT EXISTS flights_stage (LIKE flights INCLUDING DEFAULTS)")
        cur.execute("TRUNCATE flights_stage")
        with cur.copy(FLIGHT_COPY) as copy:
            for r in rows:
                copy.write_row(
                    (
                        r.get("flight_id") or uuid7(),
                        r["flight_number"],
                        r["airline_code"],
                        r["origin"],
                        r["destination"],
                        to_departure_date(r["departure_time"]),
                        r["departure_time"],
                        r["arrival_time"],
                        r["aircraft_type"],
                        r["base_price"],
                        r.get("currency", "USD"),
                        r.get("status", "SCHEDULED"),
                    )
                )
        cur.execute(
            """
            INSERT INTO flights SELECT * FROM flights_stage
            ON CONFLICT (flight_id, departure_date) DO NOTHING
            """
        )
    conn.commit()


def load_inventory(conn: psycopg.Connection, flights: Iterable[dict]) -> None:
    """
    One row per (flight, cabin). available_seats starts EQUAL to total_seats;
    held_seats starts at 0. DO NOTHING so a re-run never resets live counts.
    """
    sql = (
        "INSERT INTO flight_inventory "
        "(flight_id, departure_date, cabin, shard_no, total_seats, available_seats, held_seats) "
        "VALUES (%s, %s, %s, 0, %s, %s, 0) "
        "ON CONFLICT (flight_id, departure_date, cabin, shard_no) DO NOTHING"
    )
    with conn.cursor() as cur:
        cur.executemany(
            sql,
            [
                (
                    f["flight_id"],
                    to_departure_date(f["departure_time"]),
                    cabin,
                    capacity,     # total_seats
                    capacity,     # available_seats == total_seats
                )
                for f in flights
                for cabin, capacity in cabin_capacities(f).items()
            ],
        )
    conn.commit()


def cabin_capacities(flight: dict) -> dict[str, int]:
    """YOUR rule: how many seats each cabin of this flight sells."""
    raise NotImplementedError("map aircraft_type -> per-cabin capacity")


# --- resumability -----------------------------------------------------------
def last_loaded_departure(conn: psycopg.Connection) -> date | None:
    with conn.cursor() as cur:
        cur.execute("SELECT max(departure_date) FROM flights")
        return cur.fetchone()[0]


# --- main -------------------------------------------------------------------
def main() -> None:
    with psycopg.connect(DSN, autocommit=False) as conn:
        ensure_partitions(conn, months_behind=100, months_ahead=60)

        resume_after = last_loaded_departure(conn)
        batch: list[dict] = []
        total = 0

        for flight in iter_flights():  # iterate in departure_date order
            depart = to_departure_date(flight["departure_time"])
            if resume_after is not None and depart <= resume_after:
                continue  # already loaded
            batch.append(flight)
            if len(batch) >= BATCH_SIZE:
                load_flight_batch(conn, batch)
                load_inventory(conn, batch)
                total += len(batch)
                print(f"loaded {total} flights (through {depart})", file=sys.stderr)
                batch = []
                resume_after = depart

        if batch:
            load_flight_batch(conn, batch)
            load_inventory(conn, batch)
            total += len(batch)
        print(f"done: {total} flights", file=sys.stderr)


if __name__ == "__main__":
    main()
```

---

## 8. Data-quality checks after loading

Run these after a load (and periodically). The API's oversell audit
(`scripts/oversell-audit.js`, `npm run audit:oversell`) covers the **booking side**; these cover the
**loaded data**.

`npm run validate:data` implements every check in this section (plus partition coverage, outbox
backlog and read-model consistency) and exits non-zero on a violation. The SQL below remains here
because it is what an external loader's author should read, and because a check that fails is
easier to investigate by hand than through a report.

**Counts per month partition** — confirms rows landed in the partitions you created:

```sql
SELECT tableoid::regclass AS partition, count(*) AS rows
  FROM flights
 GROUP BY 1
 ORDER BY 1;
```

**Flights with no inventory row** — these flights cannot be booked at all:

```sql
SELECT f.flight_id, f.departure_date, f.aircraft_type
  FROM flights f
  LEFT JOIN flight_inventory i
    ON i.flight_id = f.flight_id AND i.departure_date = f.departure_date
 WHERE i.flight_id IS NULL
 LIMIT 100;
```

**Inventory rows whose counters are wrong** — `available_seats > capacity` or `< 0`. The CHECK
constraints make these impossible *through normal writes*, so a non-empty result means constraints
were bypassed (direct worker load, `session_replication_role=replica`, or a restore):

```sql
SELECT flight_id, departure_date, cabin, total_seats, available_seats, held_seats
  FROM flight_inventory
 WHERE available_seats < 0
    OR available_seats > total_seats
    OR held_seats < 0
 LIMIT 100;
```

**Duplicate flight numbers on the same date and route** — a load-ordering or source bug:

```sql
SELECT flight_number, departure_date, origin, destination, count(*) AS n
  FROM flights
 GROUP BY flight_number, departure_date, origin, destination
HAVING count(*) > 1
 ORDER BY n DESC
 LIMIT 100;
```

**Orphan cabin codes** — `flight_inventory.cabin` with no matching `cabins` row (there is no FK, so
this is not caught for you):

```sql
SELECT DISTINCT i.cabin
  FROM flight_inventory i
  LEFT JOIN cabins c ON c.code = i.cabin
 WHERE c.code IS NULL;
```

**Orphan airline / aircraft codes on flights** — same reason (`flights` has no FKs):

```sql
SELECT DISTINCT f.airline_code
  FROM flights f
  LEFT JOIN airlines a ON a.code = f.airline_code
 WHERE a.code IS NULL;

SELECT DISTINCT f.aircraft_type
  FROM flights f
  LEFT JOIN aircraft_types t ON t.code = f.aircraft_type
 WHERE t.code IS NULL;
```

**Wrong `departure_date`** — should always be empty (the CHECK enforces it, but confirm after a
direct-worker load that bypassed checks):

```sql
SELECT count(*) AS mismatched
  FROM flights
 WHERE departure_date <> (departure_time AT TIME ZONE 'UTC')::date;
```

**Upper-case user emails** — `ck_users_email_lowercase` rejects them at insert; this confirms none
slipped in another way:

```sql
SELECT count(*) AS bad_emails FROM users WHERE email <> lower(email);
```

If any check returns rows, fix the loader and re-run — every load above is idempotent. Then run
`npm run validate:data -- --strict` over the loaded window; it runs the same queries and fails the
build (or the load) rather than leaving the verification to whoever remembers to look.
