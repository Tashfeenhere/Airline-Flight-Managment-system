#!/usr/bin/env python3
"""Load 100,000 users (20,000 per region) into the write model.

Usage
-----
    python loaders/load_users.py                     # uses .env / environment
    python loaders/load_users.py --dsn postgres://...
    python loaders/load_users.py --dry-run

The accounts cannot log in: ``password_hash`` is the ``!imported-account-reset-required``
sentinel that ``src/auth/password.js`` rejects, which is the documented
"force a password reset" behaviour. To create one working demo login, hash a password
with ``@node-rs/argon2`` and update that single row afterwards.

Every id is UUIDv5 over the email, so a re-run inserts nothing new.
"""

from __future__ import annotations

import argparse
import sys

import psycopg

from common import (
    Checkpoint,
    Progress,
    connect,
    copy_lines,
    create_stage,
    load_dotenv,
    uuid5,
    write_dsn,
)
from regions import DIAL_CODES, FIRST_NAMES, LAST_NAMES, REGIONS, TARGETS

IMPORTED_PASSWORD_HASH = "!imported-account-reset-required"
DEFAULT_BATCH_SIZE = 20_000

STAGE = "users_stage"
STAGE_COLUMNS = "id, email, password_hash, role, full_name, phone, is_active, region"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load synthetic users into the write model.")
    parser.add_argument("--dsn", help="Write-model DSN (default: COORDINATOR_DSN / CITUS_COORDINATOR_URL).")
    parser.add_argument("--per-region", type=int, default=TARGETS["per_region_users"],
                        help=f"Users per region (default {TARGETS['per_region_users']:,}).")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--dry-run", action="store_true", help="Report the plan; write nothing.")
    return parser.parse_args(argv)


def user_row(region: str, i: int) -> tuple[str, str, str, str, str, str, bool, str]:
    email = f"{region.lower()}.user{i:06d}@example.test"
    full_name = f"{FIRST_NAMES[i % len(FIRST_NAMES)]} {LAST_NAMES[i % len(LAST_NAMES)]}"
    phone = f"+{DIAL_CODES[region]}{i:09d}"
    return (
        uuid5(f"user:{email}"),
        email,
        IMPORTED_PASSWORD_HASH,
        "PASSENGER",
        full_name,
        phone,
        True,
        region,
    )


def to_copy_line(row: tuple) -> str:
    # No field can contain a tab, newline or backslash: emails are lower-case ASCII,
    # names come from the fixed table, phone numbers are digits and '+'.
    fields = []
    for value in row:
        if value is True:
            fields.append("t")
        elif value is False:
            fields.append("f")
        else:
            fields.append(str(value))
    return "\t".join(fields)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    load_dotenv()
    dsn = write_dsn(args.dsn)
    total = args.per_region * len(REGIONS)

    print(
        f"users: {total:,} rows ({args.per_region:,} per region x {len(REGIONS)} regions)"
        + (" [dry run]" if args.dry_run else ""),
        flush=True,
    )

    checkpoint = Checkpoint(
        "load_users",
        {"per_region": args.per_region, "regions": list(REGIONS)},
        restart=False,
    )

    if args.dry_run:
        for region in REGIONS:
            print(f"  {region:14s} {args.per_region:>9,}  e.g. {user_row(region, 0)[1]}", flush=True)
        return 0

    progress = Progress("users", total)
    with connect(dsn, "loader-users") as conn:
        create_stage(conn, STAGE, "users")
        copy_sql = f"COPY {STAGE} ({STAGE_COLUMNS}) FROM STDIN"

        for region in REGIONS:
            batch: list[tuple] = []

            def flush() -> int:
                if not batch:
                    return 0
                conn.execute(f"TRUNCATE {STAGE}")
                copy_lines(conn, copy_sql, (to_copy_line(row) for row in batch))
                inserted = conn.execute(
                    f"""
                    INSERT INTO users (id, email, password_hash, role, full_name, phone, is_active, region)
                    SELECT id, email, password_hash, role, full_name, phone, is_active, region
                      FROM {STAGE}
                    ON CONFLICT (id) DO NOTHING
                    """
                ).rowcount
                batch.clear()
                return inserted

            for i in range(args.per_region):
                batch.append(user_row(region, i))
                if len(batch) >= args.batch_size:
                    pending = len(batch)
                    inserted = flush()
                    progress.advance(pending)
                    checkpoint.add(users=inserted)
            pending = len(batch)
            inserted = flush()
            checkpoint.add(users=inserted)
            progress.advance(pending)
            print(f"[users] {region}: done", flush=True)

        checkpoint.state["complete"] = True
        checkpoint.save()

        row = conn.execute("SELECT count(*) FROM users").fetchone()
        print(f"users: {row[0]:,} rows in users", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
    except psycopg.Error as exc:
        print(f"users load failed: {exc}", file=sys.stderr)
        sys.exit(1)
