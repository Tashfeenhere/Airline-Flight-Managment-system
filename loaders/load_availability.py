#!/usr/bin/env python3
"""Project the loaded write model into ``airline_read.flight_availability``.

Search reads the read model (``src/routes/flightRoutes.js`` -> ``GET /api/flights/search``),
and that table is normally fed by the outbox projector. A bulk ``COPY`` load bypasses
the outbox entirely, so without this step the 50M flights exist and **search returns
nothing** -- the single most likely failure mode of a large load.

Why direct write instead of replaying 50M outbox events: the events would have to be
minted, queued and re-read to produce exactly these rows. For freshly generated data
the projection is the load.

``source_version = 0`` is deliberate. The projector's guarded upsert is

    WHERE flight_availability.source_version <= EXCLUDED.source_version

(``src/repositories/availabilityRepository.js``), so a real booking (version 1+) will
overwrite these rows and an older event can never overwrite a newer booking.

    python loaders/load_availability.py --month 2026-11 --resume
    python loaders/load_availability.py --start 2026-11-01 --end 2028-10-31
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

import psycopg

from common import (
    Checkpoint,
    Progress,
    clamp_window,
    connect,
    copy_lines,
    create_stage,
    days_between,
    ensure_month_partitions,
    parse_date,
    read_dsn,
    write_dsn,
)
from regions import CABIN_MULTIPLIER

DEFAULT_START = date(2026, 11, 1)
DEFAULT_END = date(2028, 10, 31)
DEFAULT_BATCH_SIZE = 50_000
CENT = Decimal("0.01")

STAGE = "flight_availability_stage"
COLUMNS = (
    "origin, destination, departure_date, flight_id, flight_number, airline_code, "
    "aircraft_type, departure_time, arrival_time, cabin, total_seats, available_seats, "
    "held_seats, price, currency, status, source_version"
)

SELECT_SQL = """
SELECT f.flight_id, f.origin, f.destination, f.departure_date, f.flight_number,
       f.airline_code, f.aircraft_type, f.departure_time, f.arrival_time,
       f.base_price, f.currency, f.status,
       i.cabin, i.total_seats, i.available_seats, i.held_seats
  FROM flights f
  JOIN flight_inventory i
    ON i.flight_id = f.flight_id AND i.departure_date = f.departure_date
 WHERE f.departure_date = %s
 ORDER BY f.flight_id, i.cabin
"""

INSERT_SQL = f"""
INSERT INTO flight_availability ({COLUMNS})
SELECT {COLUMNS} FROM {STAGE}
ON CONFLICT (origin, destination, departure_date, flight_id, cabin) DO NOTHING
"""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the CQRS search read model from the write model.")
    parser.add_argument("--start", default=DEFAULT_START.isoformat())
    parser.add_argument("--end", default=DEFAULT_END.isoformat())
    parser.add_argument("--month", help="Only project this YYYY-MM inside --start..--end.")
    parser.add_argument("--max-days", type=int, default=0, help="Stop after N days (smoke tests).")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--dsn", help="Write-model DSN (source).")
    parser.add_argument("--read-dsn", help="Read-model DSN (destination).")
    parser.add_argument("--resume", action="store_true", help="Resume from the checkpoint (default).")
    parser.add_argument("--restart", action="store_true", help="Discard the checkpoint and start over.")
    parser.add_argument("--dry-run", action="store_true", help="Report the plan; write nothing.")
    args = parser.parse_args(argv)

    if args.batch_size < 1:
        parser.error("--batch-size must be positive")
    if args.restart and args.resume:
        parser.error("--restart and --resume are mutually exclusive")
    args.start_date = parse_date(args.start)
    args.end_date = parse_date(args.end)
    if args.start_date > args.end_date:
        parser.error("--start must not be after --end")
    return args


def price_for(base_price: Decimal, cabin: str) -> Decimal:
    """Mirror ``priceForCabin``: round half-up to cents."""
    multiplier = Decimal(str(CABIN_MULTIPLIER.get(cabin, CABIN_MULTIPLIER["ECONOMY"])))
    return (base_price * multiplier).quantize(CENT, rounding=ROUND_HALF_UP)


def to_copy_line(row: tuple) -> str:
    (
        flight_id,
        origin,
        destination,
        departure_date,
        flight_number,
        airline_code,
        aircraft_type,
        departure_time,
        arrival_time,
        base_price,
        currency,
        status,
        cabin,
        total_seats,
        available_seats,
        held_seats,
    ) = row
    return "\t".join((
        origin,
        destination,
        departure_date.isoformat(),
        str(flight_id),
        flight_number,
        airline_code,
        aircraft_type,
        departure_time.isoformat(),
        arrival_time.isoformat() if arrival_time else "",
        cabin,
        str(total_seats),
        str(available_seats),
        str(held_seats),
        str(price_for(base_price, cabin)),
        currency,
        status,
        "0",  # source_version
    ))


class Projector:
    def __init__(self, read_conn: psycopg.Connection, batch_size: int) -> None:
        self.read_conn = read_conn
        self.batch_size = batch_size
        self.written = 0
        self._months: set[date] = set()
        create_stage(read_conn, STAGE, "flight_availability")

    def ensure_month(self, day: date) -> None:
        month = date(day.year, day.month, 1)
        if month in self._months:
            return
        ensure_month_partitions(self.read_conn, "flight_availability", month, month)
        self._months.add(month)

    def write(self, lines: list[str]) -> int:
        if not lines:
            return 0
        with self.read_conn.transaction():
            self.read_conn.execute(f"TRUNCATE {STAGE}")
            copy_lines(self.read_conn, f"COPY {STAGE} ({COLUMNS}) FROM STDIN", lines)
            inserted = self.read_conn.execute(INSERT_SQL).rowcount
        self.written += inserted
        return inserted


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    source_dsn = write_dsn(args.dsn)
    target_dsn = read_dsn(args.read_dsn)

    start, end = args.start_date, args.end_date
    run_start, run_end = clamp_window(start, end, args.month)
    run_days = [day for day in days_between(run_start, run_end)]
    if args.max_days:
        run_days = run_days[: args.max_days]

    if not run_days:
        print("availability: nothing to do", flush=True)
        return 0

    print(
        f"availability: {run_days[0]} .. {run_days[-1]} ({len(run_days)} days), "
        f"batch={args.batch_size:,}" + (" [dry run]" if args.dry_run else ""),
        flush=True,
    )
    if args.dry_run:
        return 0

    checkpoint = Checkpoint(
        f"load_availability_{start.isoformat()}_{end.isoformat()}",
        {"start": start.isoformat(), "end": end.isoformat()},
        resume=not args.restart,
        restart=args.restart,
    )

    with connect(source_dsn, "loader-availability-read") as source:
        with connect(target_dsn, "loader-availability-write", synchronous_commit_off=True) as target:
            exact = source.execute(
                """
                SELECT count(*)
                  FROM flights f
                  JOIN flight_inventory i
                    ON i.flight_id = f.flight_id AND i.departure_date = f.departure_date
                 WHERE f.departure_date BETWEEN %s AND %s
                """,
                (run_start, run_end),
            ).fetchone()[0]

            progress = Progress("availability", int(exact))
            projector = Projector(target, args.batch_size)

            for day in run_days:
                if checkpoint.is_complete(day):
                    continue

                projector.ensure_month(day)
                day_rows = 0
                # A server-side cursor keeps one day's ~146k joined rows out of
                # client memory while the batches are copied across.
                with source.transaction():
                    with source.cursor(name=f"avail_{day.strftime('%Y%m%d')}") as cursor:
                        cursor.itersize = args.batch_size
                        cursor.execute(SELECT_SQL, (day,))
                        while True:
                            rows = cursor.fetchmany(args.batch_size)
                            if not rows:
                                break
                            lines = [to_copy_line(row) for row in rows]
                            projector.write(lines)
                            day_rows += len(lines)
                            progress.advance(len(lines))

                checkpoint.add(rows=day_rows)
                checkpoint.mark_day(day)
                if day.day == 1 or day == run_days[-1]:
                    print(
                        f"  day {day} done — projected={projector.written:,}",
                        flush=True,
                    )

            progress.finish()
            row = target.execute(
                "SELECT count(*) FROM flight_availability WHERE departure_date BETWEEN %s AND %s",
                (run_start, run_end),
            ).fetchone()
            print(
                f"availability: inserted {projector.written:,} rows (this run); "
                f"{row[0]:,} rows now exist in {run_start}..{run_end}",
                flush=True,
            )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\ninterrupted — checkpoint saved; re-run with --resume", file=sys.stderr)
        sys.exit(130)
    except psycopg.Error as exc:
        print(f"availability load failed: {exc}", file=sys.stderr)
        sys.exit(1)
