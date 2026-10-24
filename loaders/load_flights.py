#!/usr/bin/env python3
"""Load synthetic flights and their per-cabin inventory counters.

    python loaders/load_flights.py --month 2026-11
    python loaders/load_flights.py --start 2026-11-01 --end 2028-10-31 --resume
    python loaders/load_flights.py --month 2026-11 --regions SOUTH_ASIA --batch-size 40000

Why day order, interleaved by region
------------------------------------
``flights`` and ``flight_inventory`` are RANGE-partitioned by ``departure_date``.
Writing months out of order means random partition churn, index bloat and a much
slower load. The outer loop is therefore the calendar day and the inner loop is the
five regions, so rows arrive in ``departure_date`` order and every region still gets
exactly its share.

Determinism
-----------
Every field is a pure function of ``(region, departure_date, j)``. There is no
``random()``: a re-run reproduces byte-identical rows, resume is exact at day
granularity, and ``ON CONFLICT (flight_id, departure_date) DO NOTHING`` makes
replaying a partially written day insert nothing.

Write path
----------
``COPY`` cannot express ``ON CONFLICT``, so each batch is copied into a session-local
temp table shaped like the target and merged with an explicit named-column insert.
The column list is spelled out (never ``SELECT *``) for the same reason the
repositories spell it out: the table gains columns over time.

--regions is also the parallel path: five processes, one per region, each with its
own checkpoint, is roughly 5x faster on a server with the IOPS to sustain it.
"""

from __future__ import annotations

import argparse
import sys
import uuid
from datetime import date, timedelta

import psycopg

from common import (
    NAMESPACE,
    Checkpoint,
    Progress,
    clamp_window,
    connect,
    copy_lines,
    create_stage,
    days_between,
    ensure_month_partitions,
    parse_date,
    utc_midnight,
    write_dsn,
)
from regions import (
    HUBS,
    LONG_HAUL_AIRCRAFT,
    REGIONS,
    SHORT_HAUL_AIRCRAFT,
    TARGETS,
    region_index,
)

FLIGHT_STAGE = "flights_stage"
INVENTORY_STAGE = "flight_inventory_stage"
DEFAULT_START = date(2026, 11, 1)
DEFAULT_END = date(2028, 10, 31)
DEFAULT_BATCH_SIZE = 40_000

FLIGHT_COLUMNS = (
    "flight_id, flight_number, airline_code, origin, destination, departure_date, "
    "departure_time, arrival_time, aircraft_type, base_price, currency, status, region"
)
INVENTORY_COLUMNS = (
    "flight_id, departure_date, cabin, shard_no, total_seats, available_seats, "
    "held_seats, version, region"
)

FLIGHT_INSERT = f"""
INSERT INTO flights ({FLIGHT_COLUMNS})
SELECT {FLIGHT_COLUMNS} FROM {FLIGHT_STAGE}
ON CONFLICT (flight_id, departure_date) DO NOTHING
"""

INVENTORY_INSERT = f"""
INSERT INTO flight_inventory ({INVENTORY_COLUMNS})
SELECT {INVENTORY_COLUMNS} FROM {INVENTORY_STAGE}
ON CONFLICT (flight_id, departure_date, cabin, shard_no) DO NOTHING
"""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load synthetic flights and inventory.")
    parser.add_argument("--start", default=DEFAULT_START.isoformat(), help="First departure date (UTC).")
    parser.add_argument("--end", default=DEFAULT_END.isoformat(), help="Last departure date (UTC).")
    parser.add_argument("--month", help="Only load this YYYY-MM inside --start..--end.")
    parser.add_argument("--max-days", type=int, default=0, help="Stop after N days of the range (smoke tests).")
    parser.add_argument("--regions", default=",".join(REGIONS), help="Comma-separated region codes.")
    parser.add_argument(
        "--target-per-region",
        type=int,
        default=TARGETS["per_region_flights"],
        help=f"Flights per region over --start..--end (default {TARGETS['per_region_flights']:,}).",
    )
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Rows per COPY/merge batch.")
    parser.add_argument("--dsn", help="Write-model DSN (default: COORDINATOR_DSN / CITUS_COORDINATOR_URL).")
    parser.add_argument("--resume", action="store_true", help="Resume from the checkpoint (default behaviour).")
    parser.add_argument("--restart", action="store_true", help="Discard the checkpoint and start over.")
    parser.add_argument("--dry-run", action="store_true", help="Generate and count; write nothing.")
    args = parser.parse_args(argv)

    if args.batch_size < 1:
        parser.error("--batch-size must be positive")
    if args.target_per_region < 1:
        parser.error("--target-per-region must be positive")
    if args.max_days < 0:
        parser.error("--max-days cannot be negative")
    if args.restart and args.resume:
        parser.error("--restart and --resume are mutually exclusive")

    requested = [entry.strip().upper() for entry in args.regions.split(",") if entry.strip()]
    unknown = [entry for entry in requested if entry not in REGIONS]
    if unknown:
        parser.error(f"unknown region(s): {', '.join(unknown)} (known: {', '.join(REGIONS)})")
    # Canonical order, so two invocations with the same set behave identically.
    args.region_list = [region for region in REGIONS if region in requested]
    args.start_date = parse_date(args.start)
    args.end_date = parse_date(args.end)
    if args.start_date > args.end_date:
        parser.error("--start must not be after --end")
    return args


def load_pools(conn: psycopg.Connection, regions: list[str]) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    airports: dict[str, list[str]] = {}
    airlines: dict[str, list[str]] = {}
    for region in regions:
        airport_codes = [row[0] for row in conn.execute(
            "SELECT code FROM airports WHERE region = %s ORDER BY code", (region,)
        ).fetchall()]
        airline_codes = [row[0] for row in conn.execute(
            "SELECT code FROM airlines WHERE region = %s ORDER BY code", (region,)
        ).fetchall()]
        if not airport_codes:
            raise SystemExit(f"No airports with region = {region}; run migrations and check airports.region")
        if not airline_codes:
            raise SystemExit(f"No airlines with region = {region}; run migrations and check airlines.region")
        airports[region] = airport_codes
        airlines[region] = airline_codes
    return airports, airlines


def load_capacities(conn: psycopg.Connection) -> dict[str, list[tuple[str, int]]]:
    """Cabin capacities per aircraft type, straight from ``seat_map_templates``."""
    rows = conn.execute(
        """
        SELECT aircraft_type, cabin, count(*)::int AS total_seats
          FROM seat_map_templates
         GROUP BY aircraft_type, cabin
         ORDER BY aircraft_type, min(seat_number)
        """
    ).fetchall()
    capacities: dict[str, list[tuple[str, int]]] = {}
    for aircraft_type, cabin, total_seats in rows:
        capacities.setdefault(aircraft_type, []).append((cabin, int(total_seats)))
    return capacities


def usable(pool: tuple[str, ...], capacities: dict[str, list[tuple[str, int]]]) -> tuple[str, ...]:
    available = tuple(code for code in pool if capacities.get(code))
    if not available:
        raise SystemExit(f"None of {pool} have seat_map_templates; run db:migrate first")
    return available


def destination_for(region: str, ri: int, airports: list[str], j: int) -> tuple[str, str, bool]:
    """Return ``(origin, destination, is_cross_region)`` for global row ``j``.

    70% of rows stay inside the region, 30% fly to another region's hub. The
    invariants are structural, not post-hoc: same-region destinations are chosen
    *away* from the origin, and a hub of a different region is never the origin
    (regions own disjoint airport sets). North America currently has one airport
    (JFK), so its rows necessarily take the cross-region branch -- the rule is
    "same region when possible", not "70% even when it would be illegal".
    """
    origin = airports[j % len(airports)]
    same_region = (j % 10) < 7

    if same_region and len(airports) > 1:
        step = 1 + ((j // 10) % (len(airports) - 1))
        destination = airports[((j % len(airports)) + step) % len(airports)]
        return origin, destination, False

    # `1 + (j % (n-1))` walks 1..4, so the target is always a *different* region.
    # The plan's `(ri + 1 + j) % 5` cycles through all five and therefore sometimes
    # picks `ri` itself; when the origin happens to be that region's hub the route
    # becomes origin = destination. Skipping `ri` makes `destination == origin`
    # structurally impossible for a cross-region row (regions own disjoint airport
    # sets), which matters most for North America: it has one airport and no
    # same-region alternative to fall back to.
    target_ri = (ri + 1 + (j % (len(REGIONS) - 1))) % len(REGIONS)
    destination = HUBS[REGIONS[target_ri]]
    return origin, destination, True


def copy_flight_line(flight: tuple[str, ...]) -> str:
    return "\t".join(flight)


def generate_region_day(
    *,
    region: str,
    ri: int,
    day: date,
    count: int,
    airports: list[str],
    airlines: list[str],
    capacities: dict[str, list[tuple[str, int]]],
    short_haul: tuple[str, ...],
    long_haul: tuple[str, ...],
) -> tuple[list[str], list[str]]:
    """Rows for one (region, day): flight COPY lines and inventory COPY lines."""
    flights: list[str] = []
    inventory: list[str] = []
    day_iso = day.isoformat()
    base_dt = utc_midnight(day)
    per_day = max(count, 1)

    for j in range(count):
        origin, destination, is_cross = destination_for(region, ri, airports, j)

        # Monotonic inside the day: j=0 departs at 00:00, the last row at 23:59.
        departure = base_dt + timedelta(minutes=(j * 1440) // per_day)
        if is_cross:
            duration = 300 + ((j * 53) % 541)  # 300..840 minutes
        else:
            duration = 60 + ((j * 37) % 181)  # 60..240 minutes
        arrival = departure + timedelta(minutes=duration)

        airline = airlines[j % len(airlines)]
        aircraft_pool = long_haul if is_cross else short_haul
        aircraft_type = aircraft_pool[(j // 3) % len(aircraft_pool)]

        base_price = 80 + (j * 7) % 1120 + (250 if is_cross else 0)
        flight_id = str(uuid.uuid5(NAMESPACE, f"synthetic:{region}:{day_iso}:{j}"))

        flights.append("\t".join((
            flight_id,
            # Unique inside the region/day: j is unique, so no two rows share a
            # number. The plan's `j % 8900` would repeat during a 13,680-row day
            # and, for regions with an even airline/airport count, repeat the whole
            # route too -- which `validate-data.js` reports as a duplicate.
            f"{airline}{100 + j}",
            airline,
            origin,
            destination,
            day_iso,
            departure.isoformat(),
            arrival.isoformat(),
            aircraft_type,
            str(base_price),
            "USD",
            "SCHEDULED",
            region,
        )))

        for cabin, total_seats in capacities[aircraft_type]:
            inventory.append("\t".join((
                flight_id,
                day_iso,
                cabin,
                "0",
                str(total_seats),
                str(total_seats),
                "0",
                "0",
                region,
            )))

    return flights, inventory


class Writer:
    """Owns the temp staging tables and flushes buffers to the write model."""

    def __init__(self, conn: psycopg.Connection, batch_size: int) -> None:
        self.conn = conn
        self.batch_size = batch_size
        self.flight_buffer: list[str] = []
        self.inventory_buffer: list[str] = []
        self.flights_written = 0
        self.inventory_written = 0
        self._months: set[tuple[str, date]] = set()

        create_stage(conn, FLIGHT_STAGE, "flights")
        create_stage(conn, INVENTORY_STAGE, "flight_inventory")

    def ensure_month(self, parent: str, day: date) -> None:
        month = date(day.year, day.month, 1)
        key = (parent, month)
        if key in self._months:
            return
        ensure_month_partitions(self.conn, parent, month, month)
        self._months.add(key)

    def add(self, flights: list[str], inventory: list[str]) -> None:
        self.flight_buffer.extend(flights)
        self.inventory_buffer.extend(inventory)
        self._flush_if_full()

    def _flush_if_full(self) -> None:
        if len(self.flight_buffer) >= self.batch_size:
            self.flush_flights()
        if len(self.inventory_buffer) >= self.batch_size:
            self.flush_inventory()

    def flush_flights(self) -> int:
        if not self.flight_buffer:
            return 0
        rows, self.flight_buffer = self.flight_buffer, []
        self.ensure_month("flights", _day_from_line(rows[0]))
        with self.conn.transaction():
            self.conn.execute(f"TRUNCATE {FLIGHT_STAGE}")
            copy_lines(self.conn, f"COPY {FLIGHT_STAGE} ({FLIGHT_COLUMNS}) FROM STDIN", rows)
            inserted = self.conn.execute(FLIGHT_INSERT).rowcount
        self.flights_written += inserted
        return inserted

    def flush_inventory(self) -> int:
        if not self.inventory_buffer:
            return 0
        rows, self.inventory_buffer = self.inventory_buffer, []
        self.ensure_month("flight_inventory", _day_from_line(rows[0]))
        with self.conn.transaction():
            self.conn.execute(f"TRUNCATE {INVENTORY_STAGE}")
            copy_lines(self.conn, f"COPY {INVENTORY_STAGE} ({INVENTORY_COLUMNS}) FROM STDIN", rows)
            inserted = self.conn.execute(INVENTORY_INSERT).rowcount
        self.inventory_written += inserted
        return inserted

    def flush(self) -> tuple[int, int]:
        return self.flush_flights(), self.flush_inventory()


def _day_from_line(line: str) -> date:
    """The ``departure_date`` column (6th for flights, 2nd for inventory)."""
    fields = line.split("\t")
    raw = fields[5] if len(fields) == 13 else fields[1]
    return date.fromisoformat(raw)


def per_day_counts(days: list[date], target_per_region: int) -> dict[date, int]:
    base, extra = divmod(target_per_region, len(days))
    return {
        day: base + (1 if index < extra else 0)
        for index, day in enumerate(days)
    }


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    dsn = write_dsn(args.dsn)

    start, end = args.start_date, args.end_date
    run_start, run_end = clamp_window(start, end, args.month)
    all_days = list(days_between(start, end))
    counts = per_day_counts(all_days, args.target_per_region)

    run_days = [day for day in all_days if run_start <= day <= run_end]
    if args.max_days:
        run_days = run_days[: args.max_days]

    total_flights = sum(counts[day] for day in run_days) * len(args.region_list)
    scope = f"{run_days[0]} .. {run_days[-1]}" if run_days else "(empty)"

    print(
        f"flights: {total_flights:,} rows across {len(run_days)} days ({scope}), "
        f"regions={','.join(args.region_list)}, batch={args.batch_size:,}"
        + (" [dry run]" if args.dry_run else ""),
        flush=True,
    )
    print(
        f"  allocation: {min(counts.values()):,}..{max(counts.values()):,} flights/day/region "
        f"(target {args.target_per_region:,}/region over {len(all_days)} days)",
        flush=True,
    )

    if not run_days:
        print("flights: nothing to do", flush=True)
        return 0

    with connect(dsn, "loader-flights", synchronous_commit_off=True) as conn:
        airports, airlines = load_pools(conn, args.region_list)
        capacities = load_capacities(conn)
        short_haul = usable(SHORT_HAUL_AIRCRAFT, capacities)
        long_haul = usable(LONG_HAUL_AIRCRAFT, capacities)

        for region in args.region_list:
            print(
                f"  {region:14s} airports={','.join(airports[region])} "
                f"airlines={','.join(airlines[region])}",
                flush=True,
            )

        if args.dry_run:
            total = 0
            for day in run_days:
                total += counts[day] * len(args.region_list)
            print(f"flights: dry run would generate {total:,} flights", flush=True)
            return 0

        checkpoint = Checkpoint(
            f"load_flights_{start.isoformat()}_{end.isoformat()}",
            {
                "start": start.isoformat(),
                "end": end.isoformat(),
                "target_per_region": args.target_per_region,
                "regions": args.region_list,
            },
            resume=not args.restart,
            restart=args.restart,
        )
        if args.regions == ",".join(REGIONS) and checkpoint.last_completed_day:
            print(f"  resuming after {checkpoint.last_completed_day}", flush=True)

        writer = Writer(conn, args.batch_size)
        progress = Progress("flights", total_flights)
        # A resumed run should show real progress, not restart its ETA at zero.
        already = sum(counts[day] for day in run_days if checkpoint.is_complete(day))
        progress.done = already * len(args.region_list)

        try:
            for day in all_days:
                if day < run_start or day > run_end:
                    continue
                if day > run_days[-1]:
                    break
                if checkpoint.is_complete(day):
                    continue

                count = counts[day]
                for region in args.region_list:
                    flight_lines, inventory_lines = generate_region_day(
                        region=region,
                        ri=region_index(region),
                        day=day,
                        count=count,
                        airports=airports[region],
                        airlines=airlines[region],
                        capacities=capacities,
                        short_haul=short_haul,
                        long_haul=long_haul,
                    )
                    writer.add(flight_lines, inventory_lines)
                    progress.advance(len(flight_lines))

                inserted_flights, inserted_inventory = writer.flush()
                checkpoint.add(flights=inserted_flights, inventory=inserted_inventory)
                checkpoint.mark_day(day)
                if day.day == 1 or day == run_days[-1]:
                    print(
                        f"  day {day} done — flights={writer.flights_written:,} "
                        f"inventory={writer.inventory_written:,}",
                        flush=True,
                    )

            progress.finish()
        finally:
            # Flush whatever is left even if the run was interrupted, so the
            # checkpoint never claims a day whose rows are still only in memory.
            left_flights, left_inventory = writer.flush()
            checkpoint.add(flights=left_flights, inventory=left_inventory)
            checkpoint.save()

        print(
            f"flights: inserted {writer.flights_written:,} flights and "
            f"{writer.inventory_written:,} inventory rows (this run)",
            flush=True,
        )
        row = conn.execute(
            "SELECT count(*) FROM flights WHERE departure_date BETWEEN %s AND %s",
            (run_start, run_end),
        ).fetchone()
        print(f"flights: {row[0]:,} rows now exist in {run_start}..{run_end}", flush=True)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\ninterrupted — checkpoint saved; re-run with --resume", file=sys.stderr)
        sys.exit(130)
    except psycopg.Error as exc:
        print(f"flights load failed: {exc}", file=sys.stderr)
        sys.exit(1)
