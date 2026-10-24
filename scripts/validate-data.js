#!/usr/bin/env node
'use strict';
/**
 * `npm run validate:data` — post-load / periodic data-quality checks for the Citus
 * write model and the CQRS read model.
 *
 * This is the validator the P9 backfill pipeline is verified with. It implements every
 * check documented in `docs/DATA_LOADING.md` section 8, plus the accounting invariant
 * the booking path depends on and a coverage check for the partition horizon. It NEVER
 * repairs anything: a violation is a correctness signal, and an automatic fix would
 * erase the evidence needed to find the loader or migration that produced it.
 *
 * SEVERITY
 *
 *   error    the data is wrong in a way the application will trip over: unbookable
 *            flights, counter drift, orphan codes, missing partitions.
 *   warning  suspicious but not immediately wrong: the projection backlog, duplicate
 *            flight numbers on one route/date, a flight id reused across dates.
 *
 * Exit code: 0 when there are no errors, 1 when any check fails (warnings count only
 * with `--strict`), 2 on a usage error. That makes the script usable as a CI gate or a
 * cron probe without parsing its output.
 *
 * COST
 *
 * Most checks are full scans of the tables they name. At 50M flights, run the full
 * sweep on a schedule (after loads, nightly) and use `--from/--to` to scope it to the
 * window a load touched. `--max-examples` only limits how many offending rows are
 * printed; the reported count is always the true one.
 *
 * USAGE
 *
 *   node scripts/validate-data.js
 *   node scripts/validate-data.js --from 2026-11-01 --to 2026-11-30 --json
 *   node scripts/validate-data.js --horizon-months 6 --max-outbox-lag-seconds 300
 */
const pool = require('../src/db/pool');
const env = require('../src/config/env');
const partitions = require('../src/db/partitions');

const DEFAULT_EXAMPLES = 20;
const DEFAULT_HORIZON_MONTHS = 3;
const DEFAULT_MAX_OUTBOX_LAG_SECONDS = 900;

const USAGE = `
validate-data — check the loaded data against the documented invariants.

Usage:
  node scripts/validate-data.js [options]

Options:
  --from <YYYY-MM-DD>              Only check rows with this departure_date or later.
  --to <YYYY-MM-DD>                Only check rows with this departure_date or earlier.
  --horizon-months <n>             Require partitions through n months ahead (default ${DEFAULT_HORIZON_MONTHS}).
  --max-outbox-lag-seconds <n>     Fail when the oldest unpublished event is older
                                   (default ${DEFAULT_MAX_OUTBOX_LAG_SECONDS}).
  --max-examples <n>               Offending rows printed per check (default ${DEFAULT_EXAMPLES}).
  --skip-outbox                    Skip the outbox backlog check (e.g. while a loader runs).
  --skip-read-model                Skip read-model checks.
  --strict                         Treat warnings as errors.
  --json                           Print the report as JSON.
  -h, --help                       Show this help.

Exit codes: 0 clean (or warnings without --strict), 1 violations, 2 usage error.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    from: null,
    to: null,
    horizonMonths: DEFAULT_HORIZON_MONTHS,
    maxOutboxLagSeconds: DEFAULT_MAX_OUTBOX_LAG_SECONDS,
    maxExamples: DEFAULT_EXAMPLES,
    skipOutbox: false,
    skipReadModel: false,
    strict: false,
    json: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--') && raw !== '-h') throw new UsageError(`Unexpected argument: ${raw}`);
    const [flag, inline] = raw.split('=', 2);
    const next = inline !== undefined ? inline : argv[i + 1];
    const take = () => {
      if (inline !== undefined) return inline;
      if (next === undefined || String(next).startsWith('--')) throw new UsageError(`${flag} requires a value`);
      i += 1;
      return next;
    };

    switch (flag) {
      case '--from': opts.from = dateArg(flag, take()); break;
      case '--to': opts.to = dateArg(flag, take()); break;
      case '--horizon-months': opts.horizonMonths = intArg(flag, take(), 0, 120); break;
      case '--max-outbox-lag-seconds': opts.maxOutboxLagSeconds = intArg(flag, take(), 0, 86400 * 30); break;
      case '--max-examples': opts.maxExamples = intArg(flag, take(), 0, 1000); break;
      case '--skip-outbox': opts.skipOutbox = true; break;
      case '--skip-read-model': opts.skipReadModel = true; break;
      case '--strict': opts.strict = true; break;
      case '--json': opts.json = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default: throw new UsageError(`Unknown option: ${flag}`);
    }
  }

  if (opts.from && opts.to && opts.from > opts.to) throw new UsageError('--from must not be after --to');
  return opts;
}

function intArg(flag, raw, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`${flag} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

function dateArg(flag, raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new UsageError(`${flag} must be YYYY-MM-DD, got "${raw}"`);
  return raw;
}

/** `AND column BETWEEN $1 AND $2`, assembled only from fixed column names. */
function windowClause(column, opts, params) {
  const filters = [];
  if (opts.from) {
    params.push(opts.from);
    filters.push(`${column} >= $${params.length}::date`);
  }
  if (opts.to) {
    params.push(opts.to);
    filters.push(`${column} <= $${params.length}::date`);
  }
  return filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
}

/**
 * Runs a count plus an example query and packages them as one check result.
 * `sql` must return the offending rows; the count is derived in SQL rather than from
 * the sample so a truncated example list never understates the problem.
 */
async function checkQuery({ name, severity = 'error', description, sql, params = [], opts }) {
  const { rows: countRows } = await pool.writePool.query(
    `SELECT count(*)::int AS n FROM (${sql}) bad`,
    params
  );
  const count = Number(countRows[0] ? countRows[0].n : 0);

  let examples = [];
  if (count > 0 && opts.maxExamples > 0) {
    const { rows } = await pool.writePool.query(`${sql} LIMIT ${opts.maxExamples}`, params);
    examples = rows;
  }

  return { name, severity, description, count, examples };
}

const CHECKS = [
  {
    name: 'flights_without_inventory',
    description: 'Every flight needs at least one inventory counter or it can never be sold.',
    sql: (opts, params) => `
      SELECT f.flight_id, f.departure_date, f.aircraft_type
        FROM flights f
        LEFT JOIN flight_inventory i
          ON i.flight_id = f.flight_id AND i.departure_date = f.departure_date
       WHERE i.flight_id IS NULL${windowClause('f.departure_date', opts, params)}
    `
  },
  {
    name: 'inventory_counter_violations',
    description: 'Counters must be non-negative and available + held must not exceed capacity.',
    sql: (opts, params) => `
      SELECT flight_id, departure_date, cabin, total_seats, available_seats, held_seats
        FROM flight_inventory
       WHERE (available_seats < 0 OR held_seats < 0 OR available_seats > total_seats
              OR available_seats + held_seats > total_seats)
         ${windowClause('departure_date', opts, params)}
    `
  },
  {
    name: 'inventory_accounting_mismatch',
    description:
      'held_seats must equal PENDING bookings and total - available - held must equal CONFIRMED bookings.',
    sql: (opts, params) => `
      WITH inv AS (
        SELECT flight_id, departure_date, cabin,
               SUM(total_seats)::int AS total_seats,
               SUM(available_seats)::int AS available_seats,
               SUM(held_seats)::int AS held_seats
          FROM flight_inventory
         WHERE true${windowClause('departure_date', opts, params)}
         GROUP BY 1, 2, 3
      ), bk AS (
        SELECT flight_id, departure_date, cabin,
               count(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
               count(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed
          FROM bookings
         WHERE true${windowClause('departure_date', opts, params)}
         GROUP BY 1, 2, 3
      )
      SELECT inv.flight_id, inv.departure_date, inv.cabin,
             inv.total_seats, inv.available_seats, inv.held_seats,
             COALESCE(bk.pending, 0) AS pending_bookings,
             COALESCE(bk.confirmed, 0) AS confirmed_bookings,
             (inv.total_seats - inv.available_seats - inv.held_seats) AS accounted_confirmed
        FROM inv LEFT JOIN bk USING (flight_id, departure_date, cabin)
       WHERE inv.held_seats <> COALESCE(bk.pending, 0)
          OR (inv.total_seats - inv.available_seats - inv.held_seats) <> COALESCE(bk.confirmed, 0)
    `
  },
  {
    name: 'orphan_inventory',
    description: 'Inventory rows must reference an existing flight instance.',
    sql: (opts, params) => `
      SELECT i.flight_id, i.departure_date, i.cabin
        FROM flight_inventory i
       WHERE NOT EXISTS (
         SELECT 1 FROM flights f
          WHERE f.flight_id = i.flight_id AND f.departure_date = i.departure_date
       )${windowClause('i.departure_date', opts, params)}
    `
  },
  {
    name: 'orphan_cabin_codes',
    description: 'flight_inventory.cabin has no foreign key, so orphan codes must be checked here.',
    sql: (opts, params) => `
      SELECT DISTINCT i.cabin
        FROM flight_inventory i
        LEFT JOIN cabins c ON c.code = i.cabin
       WHERE c.code IS NULL${windowClause('i.departure_date', opts, params)}
    `
  },
  {
    name: 'orphan_airline_codes',
    description: 'flights.airline_code has no foreign key; every code must exist in airlines.',
    sql: (opts, params) => `
      SELECT DISTINCT f.airline_code
        FROM flights f
        LEFT JOIN airlines a ON a.code = f.airline_code
       WHERE a.code IS NULL${windowClause('f.departure_date', opts, params)}
    `
  },
  {
    name: 'orphan_aircraft_types',
    description: 'flights.aircraft_type has no foreign key; every type must exist in aircraft_types.',
    sql: (opts, params) => `
      SELECT DISTINCT f.aircraft_type
        FROM flights f
        LEFT JOIN aircraft_types t ON t.code = f.aircraft_type
       WHERE t.code IS NULL${windowClause('f.departure_date', opts, params)}
    `
  },
  {
    name: 'duplicate_flight_numbers',
    description: 'The same flight number on one date and route is a source/load-ordering bug.',
    sql: (opts, params) => `
      SELECT flight_number, departure_date, origin, destination, count(*)::int AS n
        FROM flights
       WHERE true${windowClause('departure_date', opts, params)}
       GROUP BY flight_number, departure_date, origin, destination
      HAVING count(*) > 1
    `
  },
  {
    name: 'flight_id_reused_across_dates',
    severity: 'warning',
    description: 'A flight id identifies one instance; reuse across dates usually means a bad id mapping.',
    sql: (opts, params) => `
      SELECT flight_id, count(DISTINCT departure_date)::int AS dates
        FROM flights
       WHERE true${windowClause('departure_date', opts, params)}
       GROUP BY flight_id
      HAVING count(DISTINCT departure_date) > 1
    `
  },
  {
    name: 'departure_date_mismatch',
    description: 'departure_date is derived from departure_time in UTC; a mismatch means checks were bypassed.',
    sql: (opts, params) => `
      SELECT flight_id, departure_date, departure_time,
             (departure_time AT TIME ZONE 'UTC')::date AS expected_date
        FROM flights
       WHERE departure_date <> (departure_time AT TIME ZONE 'UTC')::date
         ${windowClause('departure_date', opts, params)}
    `
  },
  {
    name: 'uppercase_user_emails',
    description: 'User emails are stored lower-case; an upper-case email cannot log in consistently.',
    sql: () => 'SELECT id, email FROM users WHERE email <> lower(email)'
  },
  {
    name: 'duplicate_live_seats',
    description: 'At most one live booking may hold a seat number (backstop: uq_live_seat).',
    sql: (opts, params) => `
      SELECT flight_id, departure_date, seat_number, count(*)::int AS n
        FROM bookings
       WHERE seat_number IS NOT NULL AND status IN ('PENDING', 'CONFIRMED')
         ${windowClause('departure_date', opts, params)}
       GROUP BY flight_id, departure_date, seat_number
      HAVING count(*) > 1
    `
  },
  {
    name: 'confirmed_booking_without_capture',
    description: 'Every CONFIRMED booking must have a CAPTURED payment (saga reconciliation invariant).',
    sql: (opts, params) => `
      SELECT b.flight_id, b.departure_date, b.booking_id, b.booking_reference
        FROM bookings b
       WHERE b.status = 'CONFIRMED'
         AND NOT EXISTS (
           SELECT 1 FROM payments p
            WHERE p.flight_id = b.flight_id
              AND p.departure_date = b.departure_date
              AND p.booking_id = b.booking_id
              AND p.status = 'CAPTURED'
         )${windowClause('b.departure_date', opts, params)}
    `
  },
  {
    name: 'bookings_with_unknown_user',
    description:
      'A booking must reference a real account or the configured guest identity (users is a replicated reference table).',
    sql: (opts, params) => {
      params.push(env.GUEST_USER_ID);
      return `
        SELECT b.flight_id, b.departure_date, b.booking_id, b.user_id
          FROM bookings b
         WHERE b.user_id <> $${params.length}::uuid
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = b.user_id)
           ${windowClause('b.departure_date', opts, params)}
      `;
    }
  }
];

/**
 * Partition horizon. Unlike an internal-gap check, this one fails when the horizon ends
 * too soon: a flight loaded for a month with no partition cannot be inserted, and a
 * booking for it cannot be sold.
 */
async function checkPartitionHorizon(opts) {
  const now = new Date();
  const nowMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const results = [];

  const expected = (parent) => {
    const names = [];
    for (let offset = 0; offset <= opts.horizonMonths; offset += 1) {
      const month = new Date(Date.UTC(nowMonth.getUTCFullYear(), nowMonth.getUTCMonth() + offset, 1));
      names.push(partitions.partitionNameFor(parent, month));
    }
    return names;
  };

  const writeHorizon = await partitions.partitionHorizon(pool.writePool, partitions.WRITE_PARENTS);
  for (const parent of partitions.WRITE_PARENTS) {
    const present = new Set(writeHorizon[parent].partitions);
    const missing = expected(parent).filter((name) => !present.has(name));
    results.push({
      name: `partition_horizon:${parent}`,
      severity: 'error',
      description: `Partitions must exist from this month through +${opts.horizonMonths} months.`,
      count: missing.length,
      examples: missing.map((name) => ({ parent, missing_partition: name }))
    });
  }

  if (!opts.skipReadModel) {
    const readHorizon = await partitions.partitionHorizon(pool.readPool, partitions.READ_PARENTS);
    for (const parent of partitions.READ_PARENTS) {
      const present = new Set(readHorizon[parent].partitions);
      const missing = expected(parent).filter((name) => !present.has(name));
      results.push({
        name: `partition_horizon:${parent}`,
        severity: 'error',
        description: `Read-model partitions must exist from this month through +${opts.horizonMonths} months.`,
        count: missing.length,
        examples: missing.map((name) => ({ parent, missing_partition: name }))
      });

      // A read-model partition with no write-model counterpart means search can hold
      // rows the loader's partitions cannot explain; report it as a warning.
      const writeMonths = new Set(
        Object.values(writeHorizon).flatMap((entry) => entry.partitions.map((name) => name.slice(-6)))
      );
      const readOnly = readHorizon[parent].partitions
        .filter((name) => !writeMonths.has(name.slice(-6)))
        .map((name) => ({ partition: name }));
      results.push({
        name: 'read_model_partition_without_write_partition',
        severity: 'warning',
        description: 'The read model has a month the write model does not.',
        count: readOnly.length,
        examples: readOnly
      });
    }
  }

  return results;
}

/** Outbox backlog is expected during a load; age is what tells the projector is stuck. */
async function checkOutbox(opts) {
  const { rows } = await pool.writePool.query(`
    SELECT count(*) FILTER (WHERE published = false)::int AS pending,
           count(*) FILTER (WHERE published = false AND attempts > 0)::int AS retried,
           EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE published = false)))::float AS lag_seconds,
           min(created_at) FILTER (WHERE published = false) AS oldest_pending_at
      FROM booking_outbox
  `);
  const row = rows[0] || {};
  const lag = row.lag_seconds === null || row.lag_seconds === undefined ? 0 : Math.round(row.lag_seconds);
  const overBudget = lag > opts.maxOutboxLagSeconds;

  return [{
    name: 'outbox_backlog',
    severity: overBudget ? 'error' : 'warning',
    description: `Oldest unpublished event must be younger than ${opts.maxOutboxLagSeconds}s.`,
    count: overBudget ? 1 : 0,
    examples: Number(row.pending) > 0
      ? [{
          pending: Number(row.pending),
          retried: Number(row.retried),
          oldest_pending_at: row.oldest_pending_at,
          lag_seconds: lag,
          budget_seconds: opts.maxOutboxLagSeconds
        }]
      : []
  }];
}

async function run(opts) {
  const results = [];

  for (const check of CHECKS) {
    const params = [];
    results.push(
      await checkQuery({
        name: check.name,
        severity: check.severity || 'error',
        description: check.description,
        sql: check.sql(opts, params),
        params,
        opts
      })
    );
  }

  results.push(...(await checkPartitionHorizon(opts)));
  if (!opts.skipOutbox) results.push(...(await checkOutbox(opts)));

  const errors = results.filter((result) => result.severity === 'error' && result.count > 0);
  const warnings = results.filter((result) => result.severity === 'warning' && result.count > 0);
  const failed = errors.length + (opts.strict ? warnings.length : 0);

  return {
    ok: failed === 0,
    strict: opts.strict,
    window: { from: opts.from, to: opts.to },
    checks: results.map((result) => ({
      ...result,
      status: result.count === 0 ? 'ok' : result.severity === 'error' ? 'error' : 'warning'
    })),
    summary: {
      checks: results.length,
      errors: errors.length,
      warnings: warnings.length,
      failed
    },
    generatedAt: new Date().toISOString()
  };
}

function printHuman(report) {
  const lines = [`validate-data: ${report.summary.checks} checks`];
  for (const check of report.checks) {
    const marker = check.status === 'ok' ? 'OK  ' : check.status === 'error' ? 'FAIL' : 'WARN';
    lines.push(`[${marker}] ${check.name} — ${check.count === 0 ? 'clean' : `${check.count} row(s)`}`);
    if (check.count > 0) {
      lines.push(`       ${check.description}`);
      for (const row of check.examples.slice(0, 5)) lines.push(`       ${JSON.stringify(row)}`);
      if (check.count > check.examples.length) {
        lines.push(`       ... ${check.count - check.examples.length} more`);
      }
    }
  }
  lines.push(
    `\n${report.summary.errors} error(s), ${report.summary.warnings} warning(s)` +
      (report.ok ? ' — PASS' : ' — FAIL')
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const report = await run(opts);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHuman(report);

  return report.ok ? 0 : 1;
}

if (require.main === module) {
  main()
    .then(async (code) => {
      await pool.close();
      process.exit(code);
    })
    .catch(async (err) => {
      if (err instanceof UsageError) {
        process.stderr.write(`validate-data: ${err.message}\n\n${USAGE}\n`);
        await pool.close();
        process.exit(2);
      }
      process.stderr.write(`validate-data failed: ${err.message}\n`);
      await pool.close();
      process.exit(1);
    });
}

module.exports = { run, parseArgs, CHECKS, checkPartitionHorizon, checkOutbox };
