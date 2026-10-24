#!/usr/bin/env node
'use strict';
/**
 * `npm run audit:oversell` — verify the inventory accounting invariant.
 *
 * THE INVARIANT (this is what is checked, and nothing looser):
 *
 *   held_seats                       == count(PENDING   bookings)
 *   total_seats - available_seats
 *              - held_seats          == count(CONFIRMED bookings)
 *
 * Both counters and both booking counts are summed per (flight_id, departure_date,
 * cabin). A row that violates either equality means a reserve, a confirm or a release
 * was applied without its counterpart — the shape a seat-counting bug takes in
 * production. The database CHECK constraints make a negative count impossible, but they
 * cannot see drift *between* `flight_inventory` and `bookings`, which is exactly what
 * this finds.
 *
 * The check itself lives in `inventoryRepository.audit`, and this script drives it. It
 * is READ-ONLY: it never repairs. A violation is a correctness alarm — capture the rows,
 * then investigate the migration or loader that produced them.
 *
 * OPERATIONAL USE
 *
 * Exit code is the contract: 0 when clean, 1 when any violation is found (or on a
 * database error), 2 on a usage error. That makes it usable directly as a cron probe or
 * a CI alarm.
 *
 * With no scope this is a cluster-wide scatter over every (flight, cabin) counter joined
 * to every booking — a full scan that at 50M flights is expensive. Prefer `--flight
 * <uuid> --date <YYYY-MM-DD>` for an interactive check, or bound the sweep with
 * `--max-rows <n>` / `OVERSEL_AUDIT_MAX_ROWS` to examine only a prefix of the counter
 * groups and the bookings of those groups. The bound is an arbitrary but deterministic
 * subset, not a sample: it is there to cap the cost of a heartbeat sweep, not to stand
 * in for a full one. (Both sides of the join honour it — bounding only the counters
 * would still aggregate the whole `bookings` table.)
 */
const pool = require('../src/db/pool');
const logger = require('../src/utils/logger');
const ids = require('../src/utils/ids');
const inventoryRepository = require('../src/repositories/inventoryRepository');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 100;

/** Only one violation kind is explained per row, in this order of severity. */
const VIOLATION_EXPLANATION = {
  NEGATIVE_COUNTER: 'a counter is negative — impossible through normal writes, so the row was written out of band',
  OVERCAPACITY: 'available + held exceeds total — the inv_capacity invariant is broken',
  HELD_MISMATCH: 'held_seats does not equal the number of PENDING bookings',
  CONFIRMED_MISMATCH: 'total - available - held does not equal the number of CONFIRMED bookings'
};

const HELP = `
oversell-audit — check the inventory accounting invariant.

Usage:
  node scripts/oversell-audit.js [options]

Options:
  --flight <uuid>         Scope the check to one flight. Requires --date.
  --date <YYYY-MM-DD>     Scope the check to one departure date. Requires --flight.
  --limit <n>             Maximum violations to print (default ${DEFAULT_LIMIT}); the
                          violation count is always the true total.
  --max-rows <n>          Bound the cluster-wide sweep to the first n counter groups.
                          Also read from OVERSEL_AUDIT_MAX_ROWS. 0 (default) = no bound.
  --json                  Emit the report as JSON on stdout.
  --help                  Show this help.

The invariant checked, per (flight_id, departure_date, cabin):
  held_seats                         == count(PENDING   bookings)
  total_seats - available_seats - held_seats == count(CONFIRMED bookings)

Exit codes: 0 clean, 1 violation(s) found or database error, 2 usage error.

Without --flight/--date this scans the whole cluster; at 50M flights that is a full
scan. Scope it, or bound it with --max-rows.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { flight: null, date: null, limit: null, maxRows: null, json: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);

    const readValue = () => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${name} requires a value`);
      }
      i += 1;
      return next;
    };

    const readPositiveInt = () => {
      const value = readValue();
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== String(value).trim() || parsed < 0) {
        throw new UsageError(`${name} must be a non-negative integer, received: ${value}`);
      }
      return parsed;
    };

    switch (name) {
      case '--flight':
        args.flight = readValue();
        break;
      case '--date':
        args.date = readValue();
        break;
      case '--limit': {
        const value = readPositiveInt();
        if (value <= 0) throw new UsageError('--limit must be a positive integer');
        args.limit = value;
        break;
      }
      case '--max-rows':
        args.maxRows = readPositiveInt();
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new UsageError(`Unknown option: ${name}`);
    }
  }

  return args;
}

function plan(args) {
  const hasFlight = Boolean(args.flight);
  const hasDate = Boolean(args.date);

  if (hasFlight !== hasDate) {
    throw new UsageError('--flight and --date must be given together: a flight id alone does not identify rows, because flights are partitioned by departure_date');
  }
  if (hasFlight && !ids.isValidUuid(args.flight)) {
    throw new UsageError(`--flight must be a UUID, received: ${args.flight}`);
  }
  if (hasDate) {
    if (!DATE_RE.test(args.date)) {
      throw new UsageError(`--date must be YYYY-MM-DD, received: ${args.date}`);
    }
    // Reject 2026-02-31, which matches the pattern but is not a real date.
    const [y, m, d] = args.date.split('-').map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
      throw new UsageError(`--date is not a real calendar date: ${args.date}`);
    }
  }

  const envBound = Number.parseInt(process.env.OVERSEL_AUDIT_MAX_ROWS || '0', 10);
  const maxRows = args.maxRows !== null ? args.maxRows : Number.isInteger(envBound) && envBound > 0 ? envBound : 0;

  return {
    flightId: hasFlight ? args.flight.trim().toLowerCase() : null,
    departureDate: hasDate ? args.date : null,
    scoped: hasFlight && hasDate,
    limit: args.limit !== null ? args.limit : DEFAULT_LIMIT,
    maxRows,
    json: args.json
  };
}

/**
 * Scoped / bounded restatement of `inventoryRepository.audit`.
 *
 * The repository function deliberately runs one cluster-wide query with no parameters.
 * That is the right shape for a full sweep, but it cannot answer "is THIS flight
 * correct?" without scanning every flight, and it cannot cap its own cost. Both are
 * operator requirements here, so this query mirrors `audit` exactly — same two
 * equalities, same two guard conditions, same violation labels — with an optional
 * (flight_id, departure_date) predicate and an optional LIMIT over the counter groups.
 * The LIMIT is a bound on the whole comparison, not just on the counter side: the
 * `live` CTE restricts its bookings aggregation to the same (flight_id, departure_date)
 * set, so a bounded run reads a bounded slice of `bookings` rather than aggregating the
 * whole table and discarding all but the prefix. That grouping is result-neutral — the
 * join drives from `inv`, so a group outside the bound could never have been reported —
 * but it is what makes `--max-rows` actually cap the cost it claims to.
 *
 * It is kept intentionally identical to the repository's CTEs; if the invariant changes
 * it must change in both places, and the full (unscoped) sweep still runs the
 * repository's own SQL so the two cannot drift unnoticed.
 */
const SCOPED_AUDIT_SQL = `
  WITH inv AS (
    SELECT flight_id, departure_date, cabin,
           SUM(total_seats)::int     AS total_seats,
           SUM(available_seats)::int AS available_seats,
           SUM(held_seats)::int      AS held_seats
      FROM flight_inventory
     WHERE ($1::uuid IS NULL OR flight_id = $1)
       AND ($2::date IS NULL OR departure_date = $2)
     GROUP BY flight_id, departure_date, cabin
     ORDER BY flight_id, departure_date, cabin
     LIMIT $3::bigint
  ), live AS (
    SELECT flight_id, departure_date, cabin,
           count(*) FILTER (WHERE status = 'PENDING')::int   AS pending_bookings,
           count(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed_bookings
      FROM bookings
     WHERE ($1::uuid IS NULL OR flight_id = $1)
       AND ($2::date IS NULL OR departure_date = $2)
       -- Keep the bookings side inside the same bound as the counter side. The LIMIT
       -- on inv alone bounds only the counters: without this predicate the GROUP BY
       -- below still aggregates every booking in the cluster, one LEFT JOIN away from
       -- being thrown out — which is exactly the cost --max-rows exists to cap. This
       -- drops no reported group and changes no count: the join drives from inv, so a
       -- live row whose (flight_id, departure_date) is outside the bounded set had no
       -- inv row to join to and contributed nothing. Counter groups with no bookings
       -- keep COALESCE-ing to 0, and every retained group still gets its full bookings
       -- count, because its whole (flight_id, departure_date) pair is in inv (or, for
       -- a scoped run, is the one pair the WHERE already selected).
       AND (flight_id, departure_date) IN (SELECT flight_id, departure_date FROM inv)
     GROUP BY flight_id, departure_date, cabin
  )
  SELECT inv.flight_id,
         inv.departure_date,
         inv.cabin,
         inv.total_seats,
         inv.available_seats,
         inv.held_seats,
         (inv.total_seats - inv.available_seats - inv.held_seats) AS confirmed_seats,
         COALESCE(live.pending_bookings, 0)   AS pending_bookings,
         COALESCE(live.confirmed_bookings, 0) AS confirmed_bookings,
         CASE
           WHEN inv.available_seats < 0 OR inv.held_seats < 0 THEN 'NEGATIVE_COUNTER'
           WHEN inv.available_seats + inv.held_seats > inv.total_seats THEN 'OVERCAPACITY'
           WHEN inv.held_seats <> COALESCE(live.pending_bookings, 0) THEN 'HELD_MISMATCH'
           WHEN (inv.total_seats - inv.available_seats - inv.held_seats)
                <> COALESCE(live.confirmed_bookings, 0) THEN 'CONFIRMED_MISMATCH'
           ELSE NULL
         END AS violation
    FROM inv
    LEFT JOIN live
      ON live.flight_id = inv.flight_id
     AND live.departure_date = inv.departure_date
     AND live.cabin = inv.cabin
   ORDER BY inv.departure_date, inv.flight_id, inv.cabin
`;

function mapViolation(row) {
  return {
    flightId: row.flight_id,
    departureDate: row.departure_date,
    cabin: row.cabin,
    violation: row.violation,
    totalSeats: Number(row.total_seats),
    availableSeats: Number(row.available_seats),
    heldSeats: Number(row.held_seats),
    confirmedSeats: Number(row.confirmed_seats),
    pendingBookings: Number(row.pending_bookings),
    confirmedBookings: Number(row.confirmed_bookings)
  };
}

/**
 * Runs the scoped/bounded query and shapes it like `inventoryRepository.audit`, so the
 * two paths print identically.
 */
async function auditScoped({ flightId, departureDate, maxRows, limit }) {
  const { rows } = await pool.writePool.query(SCOPED_AUDIT_SQL, [
    flightId,
    departureDate,
    maxRows > 0 ? maxRows : null
  ]);
  const violations = rows.filter((row) => row.violation !== null);
  return {
    checkedRows: rows.length,
    violations: violations.slice(0, limit).map(mapViolation),
    violationCount: violations.length
  };
}

function scopeLabel(options) {
  if (options.scoped) return `flight ${options.flightId} departing ${options.departureDate}`;
  if (options.maxRows > 0) return `first ${options.maxRows} counter group(s) (bounded sweep)`;
  return 'the whole cluster';
}

function describeViolation(v) {
  const lines = [];
  lines.push(`VIOLATION ${v.violation} — flight=${v.flightId} date=${v.departureDate} cabin=${v.cabin}`);
  lines.push(`  counters : total=${v.totalSeats} available=${v.availableSeats} held=${v.heldSeats} confirmed(derived)=${v.confirmedSeats}`);
  lines.push(`  bookings : PENDING=${v.pendingBookings} CONFIRMED=${v.confirmedBookings}`);
  lines.push(`  ${VIOLATION_EXPLANATION[v.violation] || 'accounting invariant violated'}`);
  return lines.join('\n');
}

function printReport(options, result, warnings) {
  const truncated = result.violations.length < result.violationCount;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scope: options.scoped
            ? { flightId: options.flightId, departureDate: options.departureDate }
            : { clusterWide: true, maxRows: options.maxRows || null },
          checkedRows: result.checkedRows,
          violationCount: result.violationCount,
          truncated,
          violations: result.violations,
          warnings
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const out = (line) => process.stdout.write(`${line}\n`);
  for (const warning of warnings) out(`warning: ${warning}`);
  out('');
  out(`oversell audit — scope: ${scopeLabel(options)}`);
  out(`counter groups checked: ${result.checkedRows}`);

  if (result.violationCount === 0) {
    out('OK — every counter agrees with its bookings (held == PENDING, confirmed == CONFIRMED).');
    return;
  }

  out(`VIOLATIONS: ${result.violationCount}${truncated ? ` (showing first ${result.violations.length})` : ''}`);
  out('');
  for (const v of result.violations) {
    out(describeViolation(v));
    out('');
  }
  out('A violation is a correctness alarm, not a warning: capture these rows and investigate the');
  out('migration or loader that produced them. This audit only reads; it never repairs.');
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${HELP}`);
      return 2;
    }
    throw err;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let options;
  try {
    options = plan(args);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${HELP}`);
      return 2;
    }
    throw err;
  }

  if (!options.scoped && options.maxRows === 0) {
    process.stderr.write(
      'warning: no scope — this is a cluster-wide scatter query. At 50M flights it scans\n' +
        '         every counter group and booking. Scope it with --flight/--date, or bound it\n' +
        '         with --max-rows / OVERSEL_AUDIT_MAX_ROWS.\n'
    );
  }

  let result;
  if (options.scoped || options.maxRows > 0) {
    result = await auditScoped(options);
  } else {
    // The full sweep runs the repository's own check, so the authoritative invariant
    // has exactly one implementation on this path.
    result = await inventoryRepository.audit(pool.writePool, { limit: options.limit });
  }

  const warnings = [];
  if (!options.scoped && options.maxRows === 0) warnings.push('cluster-wide scan (no scope)');
  if (!options.scoped && options.maxRows > 0) warnings.push('bounded sweep — a subset of counter groups was checked');

  printReport(options, result, warnings);

  // In --json mode stdout is the machine-readable document the help text promises
  // ("Emit the report as JSON on stdout"), and printReport() has just written it there.
  // logger.info emits through console.log, i.e. to stdout, so logging here would append
  // an unstructured JSON line and make JSON.parse(stdout) fail for the CI/cron consumer
  // the flag exists for. Suppress it under --json; every field it carries is already in
  // the report. In human mode the trailing log line is harmless and keeps its behaviour.
  if (!options.json) {
    logger.info('Oversell audit complete', {
      scope: options.scoped ? 'flight' : 'cluster',
      flightId: options.flightId,
      departureDate: options.departureDate,
      checkedRows: result.checkedRows,
      violationCount: result.violationCount
    });
  }

  // The contract for cron/CI: any violation is a non-zero exit.
  return result.violationCount > 0 ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    logger.error('Oversell audit failed', { error: err.message });
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close the pools on every exit path, including the failure ones, so an operator is
    // never left with a script that will not return.
    await pool.close();
  });
