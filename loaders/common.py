"""Shared plumbing for the bulk loaders: DSNs, ids, checkpoints, partitions, progress.

The loaders are deliberately thin around PostgreSQL. Everything that could make a
re-run produce different rows lives here or in ``regions.py`` and is deterministic,
so a crash costs time rather than correctness: the load resumes at day granularity
and ``ON CONFLICT DO NOTHING`` makes replaying a partial day a no-op.
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

import psycopg

REPO_ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = Path(__file__).resolve().parent / ".state"

#: The same namespace literal as ``scripts/backfill.js`` (line 81). Sharing it means a
#: flight minted by either loader for the same logical row is the same id.
NAMESPACE = uuid.UUID("b4c6f1e2-0000-5000-8000-000000000001")

DEFAULT_START = "2026-11-01"
DEFAULT_END = "2028-10-31"


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------


def load_dotenv(path: Path | None = None) -> None:
    """Load ``.env`` without adding a dependency.

    Only the subset of dotenv syntax this repository uses is supported: ``KEY=value``,
    optional ``export``, surrounding single/double quotes, comments and blank lines.
    Values already present in the real environment win, so an operator can override
    any setting for one run with ``$env:KEY=...`` on PowerShell.
    """
    env_path = path or (REPO_ROOT / ".env")
    if not env_path.exists():
        return

    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _dsn(*names: str, explicit: str | None = None) -> str:
    if explicit:
        return explicit
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    raise SystemExit(
        f"No DSN found. Pass --dsn or set {' or '.join(names)} (and/or .env at {REPO_ROOT})."
    )


def write_dsn(explicit: str | None = None) -> str:
    load_dotenv()
    return _dsn("COORDINATOR_DSN", "CITUS_COORDINATOR_URL", explicit=explicit)


def read_dsn(explicit: str | None = None) -> str:
    load_dotenv()
    return _dsn("READMODEL_DSN", "READMODEL_URL", explicit=explicit)


def connect(dsn: str, application_name: str, *, synchronous_commit_off: bool = False) -> psycopg.Connection:
    """One connection with sensible bulk-load session settings.

    ``synchronous_commit = off`` is safe specifically because the data is
    regenerable: a crash can lose the last transaction, and ``--resume`` redoes it.
    It is not set for the small users load, where it buys nothing.
    """
    conn = psycopg.connect(dsn, application_name=application_name)
    conn.autocommit = True
    if synchronous_commit_off:
        conn.execute("SET synchronous_commit = off")
    return conn


# ---------------------------------------------------------------------------
# Deterministic ids and dates
# ---------------------------------------------------------------------------


def uuid5(name: str) -> str:
    """RFC 4122 UUIDv5 under the repository's shared namespace."""
    return str(uuid.uuid5(NAMESPACE, name))


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise SystemExit(f"Bad date '{value}' (expected YYYY-MM-DD)") from exc


def utc_midnight(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)


def days_between(start: date, end: date) -> Iterator[date]:
    """Inclusive date sequence."""
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def months_between(start_month: date, end_month: date) -> int:
    return (end_month.year - start_month.year) * 12 + (end_month.month - start_month.month)


def month_span(start: date, end: date) -> Iterator[tuple[date, date]]:
    """Yield ``(first_day, last_day)`` for each calendar month intersecting the range."""
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        next_month = date(cursor.year + (cursor.month // 12), (cursor.month % 12) + 1, 1)
        yield max(cursor, start), min(next_month - timedelta(days=1), end)
        cursor = next_month


def month_bounds(month: str) -> tuple[date, date]:
    try:
        year, month_no = (int(part) for part in month.split("-", 1))
        first = date(year, month_no, 1)
    except (ValueError, TypeError) as exc:
        raise SystemExit(f"Bad --month '{month}' (expected YYYY-MM)") from exc
    next_month = date(year + (month_no // 12), (month_no % 12) + 1, 1)
    return first, next_month - timedelta(days=1)


def clamp_window(start: date, end: date, month: str | None) -> tuple[date, date]:
    """Apply ``--month`` inside the global range, refusing an empty intersection."""
    if not month:
        return start, end
    first, last = month_bounds(month)
    start, end = max(start, first), min(end, last)
    if start > end:
        raise SystemExit(f"--month {month} does not overlap {start}..{end}")
    return start, end


# ---------------------------------------------------------------------------
# Partitions
# ---------------------------------------------------------------------------


def ensure_month_partitions(conn: psycopg.Connection, parent: str, start: date, end: date) -> int:
    """Create every ``parent_pYYYYMM`` covering ``start..end``.

    ``app_ensure_month_partitions`` (migration 001) takes its window relative to
    *today*, so the window is derived from the target range rather than passed as
    absolute dates. Creating a partition that already exists is a no-op.
    """
    today = date.today()
    now_month = date(today.year, today.month, 1)
    behind = max(0, months_between(now_month, date(start.year, start.month, 1)))
    ahead = max(0, months_between(now_month, date(end.year, end.month, 1)))
    row = conn.execute(
        "SELECT app_ensure_month_partitions(%s, %s, %s)", (parent, behind, ahead)
    ).fetchone()
    return int(row[0]) if row else 0


def create_stage(conn: psycopg.Connection, name: str, parent: str) -> None:
    """Session-local staging table, shaped exactly like ``parent``.

    TEMP rather than plain UNLOGGED: a temp table is unlogged, never visible to
    another session, and dropped when the connection closes. That is what lets the
    five-region parallel path run the same script five times without the staging
    tables colliding.
    """
    conn.execute(f"CREATE TEMP TABLE IF NOT EXISTS {name} (LIKE {parent} INCLUDING DEFAULTS)")


def copy_lines(conn: psycopg.Connection, sql: str, lines: Iterable[str], chunk: int = 10_000) -> int:
    """Text-format COPY from preformatted rows.

    Text rather than binary on purpose: our rows mix ``smallint``, ``integer``,
    ``bigint``, ``numeric``, ``uuid``, ``date`` and ``timestamptz``, and binary COPY
    requires every value to already be in the destination column's binary format.
    Text COPY lets PostgreSQL parse each value into the column type and still runs at
    well over 100k rows/s locally.
    """
    written = 0
    with conn.cursor().copy(sql) as copy:
        buffer: list[str] = []
        for line in lines:
            buffer.append(line)
            written += 1
            if len(buffer) >= chunk:
                copy.write("\n".join(buffer) + "\n")
                buffer.clear()
        if buffer:
            copy.write("\n".join(buffer) + "\n")
    return written


# ---------------------------------------------------------------------------
# Checkpoints
# ---------------------------------------------------------------------------


class Checkpoint:
    """``loaders/.state/<name>.json`` with a completed-day watermark.

    The checkpoint is an optimization, not the correctness mechanism: replaying a
    completed day inserts nothing because every write is ``ON CONFLICT DO NOTHING``.
    It is written atomically (temp file + replace) so a crash never leaves truncated
    JSON behind.
    """

    VERSION = 1

    def __init__(
        self,
        name: str,
        config: dict[str, Any],
        *,
        resume: bool = True,
        restart: bool = False,
        path: Path | None = None,
    ) -> None:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.path = path or (STATE_DIR / f"{name}.json")
        self.config = config

        if restart and self.path.exists():
            self.path.unlink()

        state: dict[str, Any] | None = None
        if resume and self.path.exists():
            try:
                state = json.loads(self.path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"Checkpoint {self.path} is not valid JSON: {exc}") from exc

        if state and state.get("version") == self.VERSION and state.get("config") != config:
            raise SystemExit(
                f"Checkpoint {self.path} belongs to a different run.\n"
                f"  checkpoint: {state.get('config')}\n  this run:   {config}\n"
                "Use --restart to discard it."
            )

        if not state or state.get("version") != self.VERSION:
            state = {"version": self.VERSION, "config": config, "last_completed_day": None, "counts": {}}

        self.state = state

    @property
    def last_completed_day(self) -> date | None:
        raw = self.state.get("last_completed_day")
        return date.fromisoformat(raw) if raw else None

    def is_complete(self, day: date) -> bool:
        last = self.last_completed_day
        return last is not None and day <= last

    def add(self, **counts: int) -> None:
        for key, value in counts.items():
            self.state["counts"][key] = self.state["counts"].get(key, 0) + int(value)

    def mark_day(self, day: date) -> None:
        self.state["last_completed_day"] = day.isoformat()
        self.save()

    def save(self) -> None:
        tmp = self.path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(self.state, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self.path)


# ---------------------------------------------------------------------------
# Progress
# ---------------------------------------------------------------------------


class Progress:
    """Prints rate and ETA often enough that silence always means "stuck"."""

    def __init__(self, label: str, total: int, *, unit: str = "rows", every_seconds: float = 5.0) -> None:
        self.label = label
        self.total = total
        self.unit = unit
        self.every = every_seconds
        self.started = time.monotonic()
        self._last_printed = 0.0
        self.done = 0

    def advance(self, n: int) -> None:
        self.done += n
        now = time.monotonic()
        if now - self._last_printed < self.every and self.done < self.total:
            return
        self._last_printed = now
        elapsed = max(now - self.started, 1e-9)
        rate = self.done / elapsed
        remaining = max(self.total - self.done, 0)
        eta = remaining / rate if rate > 0 else float("inf")
        pct = (self.done / self.total * 100.0) if self.total else 100.0
        print(
            f"[{self.label}] {self.done:,}/{self.total:,} {self.unit} ({pct:5.1f}%) "
            f"{rate:,.0f} {self.unit}/s ETA {format_seconds(eta)}",
            flush=True,
        )

    def finish(self) -> None:
        self._last_printed = 0.0
        self.advance(0)


def format_seconds(seconds: float) -> str:
    if seconds == float("inf"):
        return "--"
    seconds = int(max(seconds, 0))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr, flush=True)
