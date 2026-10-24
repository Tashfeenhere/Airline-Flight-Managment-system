# Python bulk loaders

These scripts implement the volume path described in
[`docs/DATA_LOADING.md`](../docs/DATA_LOADING.md): **50,000,000 flights**,
**100,000 users**, five regions, two years of schedules. They write the write model
(`airline_inventory`) and then build the CQRS read model (`airline_read`) that search
depends on.

The in-repo Node loader (`scripts/backfill.js`) remains the right tool for fixtures
and re-imports; it is explicitly not a streaming 50M-row loader.

## Setup

```powershell
python --version                 # 3.10+
pip install -r loaders/requirements.txt

# .env must point both URLs at the server you are loading. At minimum:
#   CITUS_COORDINATOR_URL=postgres://user:pass@host:5432/airline_inventory
#   READMODEL_URL=postgres://user:pass@host:5432/airline_read
#   PARTITION_MONTHS_AHEAD=26
#   PARTITION_RETENTION_MONTHS=0
npm run db:migrate
npm run partitions:maintain -- --months-ahead 26 --no-retention
```

`npm run db:migrate` applies migration **012-regions**, which adds the `region`
columns, the `regions` lookup table and the East Asian reference data.

## Load order

1. **Users** (seconds)
   ```powershell
   python loaders/load_users.py
   ```
2. **Flights + inventory** (the long step). One month at a time keeps progress
   visible and makes a failure cost one month:
   ```powershell
   foreach ($m in 2026-11,2026-12,2027-01) {
     python loaders/load_flights.py --month $m --resume
   }
   ```
   Five parallel processes (one per region) are the faster path on a server with the
   I/O to sustain it; each gets its own checkpoint:
   ```powershell
   python loaders/load_flights.py --month 2026-11 --regions SOUTH_ASIA
   python loaders/load_flights.py --month 2026-11 --regions MIDDLE_EAST
   # ... one process per region
   ```
3. **Read model** (search returns nothing until this runs):
   ```powershell
   python loaders/load_availability.py --month 2026-11 --resume
   ```
4. **Verify**:
   ```powershell
   npm run validate:data -- --from 2026-11-01 --to 2028-10-31 --strict
   npm run audit:oversell
   ```

## Flags

All three loaders take `--dsn` (plus `--read-dsn` for availability), `--dry-run`,
`--resume` and `--restart`. Flights and availability also take `--start`, `--end`,
`--month` and `--max-days` (a smoke-test knob: stop after N days).

`load_flights.py` additionally takes `--regions` and `--target-per-region` (default
10,000,000, i.e. 50M total). The number is allocated evenly across the days in
`--start..--end`, so `--month` runs still receive their correct daily share.

## Guarantees

- **Day order.** Rows arrive in `departure_date` order, so writes stay inside one
  monthly partition at a time.
- **Deterministic.** `flight_id = uuid5("synthetic:<region>:<date>:<j>")` and every
  other field is arithmetic on `j`. No `random()`. A re-run reproduces the same rows.
- **Idempotent.** Flights upsert on `(flight_id, departure_date)`, inventory on
  `(flight_id, departure_date, cabin, shard_no)`, users on `id`, availability on its
  full primary key. `ON CONFLICT DO NOTHING` everywhere.
- **Resumable at day granularity.** `loaders/.state/*.json` records the last fully
  written day; the checkpoint is written only after that day's rows are committed.
- **Check constraints respected by construction.** `departure_date` is derived from
  the UTC departure timestamp, arrival is strictly later, origin and destination are
  chosen to differ, and counters start at `available = total`.
- **Users cannot log in.** `password_hash` is the `!imported-account-reset-required`
  sentinel that `src/auth/password.js` rejects by design (force a reset). If you want
  a working demo login, hash one password with `@node-rs/argon2` and update that row.

## Disk

The full dataset is large. Measured on this schema, plan for roughly **100 GB** of
database plus WAL/headroom (250 GB recommended):

| table | rows | rough footprint |
|---|---:|---:|
| `flights` (3 indexes + PK) | 50,000,000 | 13 GB |
| `flight_inventory` | ~107,000,000 | 20 GB |
| `airline_read.flight_availability` (PK + 3 indexes) | ~107,000,000 | 35 GB |
| WAL during the load / temp | — | 20+ GB |

If the server has less free space, lower `--target-per-region` (for example
`--target-per-region 2000000` produces 10M flights total) and adjust the verification
counts accordingly. Do not lower it by editing the constants in the scripts.

### Volume actually loaded here

This machine has one drive with ~40 GB free, so the deployment runs at
`--target-per-region 2000000`: **10,000,000 flights** and the unchanged **100,000
users**, across the same 731 days. Measured on 2026-10-20 after the load:

| table | rows | footprint |
|---|---:|---:|
| `flights` (with `idx_flights_region_date`) | 10,000,017 | 2.4 GB |
| `flight_inventory` | 22,064,378 | 3.6 GB |
| `airline_read.flight_availability` | 22,064,378 | 6.7 GB |
| `users` | 100,004 | 32 MB |

That is ~13 GB in total, about a fifth of the 50M build. The 17 flights and 34
inventory/availability rows above the round numbers pre-date this load and carry no
region; every region-tagged flight is exactly 2,000,000.

Note the API's `PG_STATEMENT_TIMEOUT_MS` (15 s by default) will cancel
`validate:data` over a 10M-row window. Run the sweep with it disabled:
`PG_STATEMENT_TIMEOUT_MS=0 npm run validate:data -- --from 2026-11-01 --to 2028-10-31 --strict`.
