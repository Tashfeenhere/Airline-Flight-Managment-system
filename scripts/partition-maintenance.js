#!/usr/bin/env node
'use strict';
/**
 * `npm run partitions:maintain` — rolls the monthly RANGE partitions on the
 * date-partitioned tables forward, applies retention, and reports the resulting horizon.
 *
 * Operational story:
 *   These relations are `PARTITION BY RANGE (departure_date)` with one partition per
 *   calendar month, named `<parent>_p<YYYYMM>`. An insert whose `departure_date` has no
 *   partition **fails loudly** with `no partition of relation "<parent>" found for row`
 *   — there is never a silently dropped booking — so the horizon has to stay ahead of
 *   every departure month the API will accept. This script is the job that keeps it
 *   ahead. Run it from cron (monthly is enough) and from the RUNBOOK when a month is
 *   reported missing.
 *
 * One source of truth:
 *   The DDL, the parent lists, the naming convention, the row-count guard, the retention
 *   window and the advisory lock all live in `src/db/partitions.js`, and this CLI calls
 *   it rather than re-deriving any of them. That is deliberate: the SQL helper
 *   `app_drop_partitions_older_than` finds partitions by name pattern, so an
 *   independently written planner that drifts by one convention silently stops matching
 *   and retention stops firing while the cluster grows without bound. The same module
 *   backs `/api/admin/partitions/maintain`, so the cron job and the admin endpoint cannot
 *   disagree about which parents they manage or which lock they contend on.
 *
 * Scope — the whole partitioned set, not two tables:
 *   `partitions.maintain({ target: 'all' })` covers all five write-model parents
 *   (`flights`, `flight_inventory`, `bookings`, `payments`, `booking_outbox`) and the read
 *   model's `flight_availability`. Managing only `bookings`/`payments` left the other four
 *   to run off the end of the window migration 007 seeded, at which point their inserts
 *   fail loudly until someone rolls them forward by hand.
 *
 * Retention is ON by default:
 *   `PARTITION_RETENTION_MONTHS` (default 24) is the window, so a plain no-argument cron
 *   run creates upcoming months *and* retires months older than that window — the contract
 *   the RUNBOOK and ARCHITECTURE documents state. A retirement that would destroy a
 *   partition still holding rows is refused unless `--force`, so the destructive path is
 *   never the silent one. `--no-retention` disables retention for a run that must only
 *   extend the horizon; `--dry-run` reports what a run would do without changing anything;
 *   `--detach` retires a month by detaching it into a standalone table instead of dropping
 *   it. Note that `--detach` is *also* gated by `--force` on a month that still holds rows:
 *   the guard asks "is this month still being written to?", and that question does not
 *   depend on what happens to the table afterwards. Detaching preserves the data, so the
 *   refusal there is about an operator acknowledging that a live month is leaving the
 *   parent's hierarchy, not about data loss.
 *
 * Report shape:
 *   `--json` emits the per-table document (one section per parent, each with `created`,
 *   `dropped`, `refused` and `horizon`) plus a `summary`. It deliberately carries no
 *   `errors` key: the module does not swallow failures, so there is no partial-failure
 *   state to describe — a failed run reports on stderr and exits non-zero, and the exit
 *   code is the error channel. A row count appears on a `refused` entry (it is the reason
 *   for the refusal) but not on `dropped` ones: the module does not return the count it
 *   took for the guard, and recomputing it here would mean a second source of truth for
 *   the same DDL.
 *
 * Lock and transactions:
 *   `partitions.maintain()` takes the single `partition-maintenance` advisory lock for the
 *   whole pass, so two operators — or a cron and a human — starting together contend on one
 *   key instead of racing into a duplicate-partition error; the loser reports "already
 *   running" (exit 1) rather than throwing. Citus forbids DDL inside a distributed
 *   transaction, so every statement the module issues is autocommitted (the same choice
 *   migration 007 makes with `transactional: false`); a crash leaves a partially
 *   rolled-forward state that is safe because every create is idempotent.
 *
 * Failure behaviour — no per-statement tolerance:
 *   The module does not swallow errors. A catalog read, the create helper
 *   (`app_ensure_month_partitions`) or a DROP/DETACH that fails propagates out of
 *   `maintain()`, aborts the run and is reported here as exit 1 — the remaining parents are
 *   not attempted. That is stated plainly rather than advertised as "the run continues",
 *   because a pass that claims to have finished after a failed DDL is worse than one that
 *   stops and says so.
 *
 * Usage:
 *   node scripts/partition-maintenance.js [--months-ahead <n>] [--retention-months [<n>]]
 *                                         [--no-retention] [--dry-run] [--detach] [--force]
 *                                         [--json] [--help]
 *
 * Exit codes: 0 the run completed (a dry run never drops anything, and never fails on a
 * refusal); 1 the advisory lock was held by another run, a non-empty partition was refused
 * on a live run, or the run errored; 2 usage error.
 */
const pool = require('../src/db/pool');
const env = require('../src/config/env');
const logger = require('../src/utils/logger');
const partitions = require('../src/db/partitions');

/**
 * Months ahead default: the project already declares the horizon in `env`, and migration
 * 007 seeds the same window from it — reusing it keeps the cron job and the initial
 * migration from disagreeing about how far ahead partitions should exist. The module's own
 * default is the same value, so a caller that omits `--months-ahead` gets the documented
 * horizon either way.
 */
const DEFAULT_MONTHS_AHEAD = Number.isInteger(env.PARTITION_MONTHS_AHEAD)
  ? env.PARTITION_MONTHS_AHEAD
  : 6;

/**
 * Retention window default, from `PARTITION_RETENTION_MONTHS`. A non-positive value means
 * the operator intends "no retention", which is mapped to `null` — the module's "do not
 * retire anything" sentinel — rather than passed through as a `0` that would put the
 * cutoff at the current month and retire every closed one.
 */
const DEFAULT_RETENTION_MONTHS =
  Number.isInteger(env.PARTITION_RETENTION_MONTHS) && env.PARTITION_RETENTION_MONTHS >= 1
    ? env.PARTITION_RETENTION_MONTHS
    : null;

const USAGE = `partition-maintenance — roll monthly partitions forward, report the horizon, and retire months past the retention window.

Usage:
  node scripts/partition-maintenance.js [options]

Options:
  --months-ahead <n>      How many months past the current month to ensure exist.
                          Default: ${DEFAULT_MONTHS_AHEAD} (from PARTITION_MONTHS_AHEAD).
  --retention-months [n]  Months of history to KEEP; months older than the window are
                          retired. <n> is required unless PARTITION_RETENTION_MONTHS is a
                          positive integer, in which case omitting <n> uses it
                          (${env.PARTITION_RETENTION_MONTHS}).
  --no-retention          Do not retire anything this run; only extend the horizon.
  --detach                Retire by DETACH PARTITION (keep the month's data as a
                          standalone table) instead of DROP TABLE. Non-destructive to
                          the data, but still gated by --force: the guard asks whether
                          the month still holds rows, and that is the same question for
                          both modes.
  --force                 Allow retiring a partition that still holds rows, with either
                          --detach or the default drop. Without it a non-empty partition
                          is refused and the run exits 1.
  --dry-run               Plan and report without changing anything.
  --json                  Emit a single machine-readable JSON report on stdout.
  --help, -h              Show this help.

Environment:
  CITUS_COORDINATOR_URL / PGBOUNCER_URL   write model connection (run on the coordinator)
  READMODEL_URL                           read model connection (for flight_availability)
  PARTITION_MONTHS_AHEAD                  default for --months-ahead
  PARTITION_RETENTION_MONTHS              default for --retention-months

Retention is ON by default: the no-argument cron run creates upcoming months and drops
months past PARTITION_RETENTION_MONTHS. Pass --no-retention for create-only.

Exit codes:
  0  the run completed; a dry run never drops anything and never fails on a refusal
  1  the advisory lock was held by another run, a non-empty partition was refused on a live
     run, or the run errored
  2  usage error`;

/** Thrown for bad flags; main() maps this to exit code 2. */
function usageError(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}

function parseCount(raw, flag, min) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw usageError(`${flag} expects an integer, received: ${text === '' ? '(missing)' : raw}`);
  }
  const value = Number.parseInt(text, 10);
  if (value < min) throw usageError(`${flag} must be >= ${min}, received: ${value}`);
  return value;
}

/**
 * Flag parser. Both `--flag value` and `--flag=value` are accepted for the numeric
 * options, because operators type both and silently ignoring one is how a maintenance
 * job ends up running with the wrong horizon.
 *
 * `--retention-months` and `--no-retention` both decide whether retention runs, so
 * combining them is a usage error rather than a silent last-one-wins: an operator who
 * typed both does not know which they meant, and guessing could drop history they meant
 * to keep. Repeating the same one is harmless.
 */
function parseArgs(argv) {
  const args = {
    monthsAhead: DEFAULT_MONTHS_AHEAD,
    retentionMonths: DEFAULT_RETENTION_MONTHS,
    dryRun: false,
    detach: false,
    force: false,
    json: false,
    help: false
  };

  // null (unset) | 'on' (--retention-months) | 'off' (--no-retention).
  let retentionMode = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--detach') {
      args.detach = true;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--no-retention') {
      if (retentionMode === 'on') {
        throw usageError('--no-retention cannot be combined with --retention-months');
      }
      retentionMode = 'off';
      args.retentionMonths = null;
    } else if (arg === '--months-ahead' || arg.startsWith('--months-ahead=')) {
      const raw = arg === '--months-ahead' ? argv[(index += 1)] : arg.slice('--months-ahead='.length);
      args.monthsAhead = parseCount(raw, '--months-ahead', 0);
    } else if (arg === '--retention-months' || arg.startsWith('--retention-months=')) {
      if (retentionMode === 'off') {
        throw usageError('--retention-months cannot be combined with --no-retention');
      }
      retentionMode = 'on';
      if (arg !== '--retention-months') {
        args.retentionMonths = parseCount(arg.slice('--retention-months='.length), '--retention-months', 1);
      } else {
        // Bare flag: the operator opted into retention but named no window, so the
        // declared default is the sensible window rather than an error.
        const next = argv[index + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          index += 1;
          args.retentionMonths = parseCount(next, '--retention-months', 1);
        } else if (DEFAULT_RETENTION_MONTHS === null) {
          throw usageError(
            '--retention-months needs an explicit number: PARTITION_RETENTION_MONTHS is not a positive integer'
          );
        } else {
          args.retentionMonths = DEFAULT_RETENTION_MONTHS;
        }
      }
    } else {
      throw usageError(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

/** The first of the month after `YYYY-MM`, as `YYYY-MM`, using the module's own calendar. */
function nextMonthKey(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const firstOfMonth = new Date(Date.UTC(year, monthNumber - 1, 1));
  return partitions.monthKey(partitions.shiftMonth(firstOfMonth, 1));
}

/**
 * Reshapes the module's flat result into the per-table report this CLI has always
 * printed. The module returns one list per outcome (`ensured`, `dropped`, `blocked`) with
 * `parent` on each entry; grouping by parent here keeps the human output — and the JSON
 * document — in the section-per-table shape operators and any existing consumers expect,
 * without this file needing to know any partition DDL.
 */
function buildReport(result, args, now) {
  const horizon = result.horizon || {};

  const groupByParent = (entries) => {
    const grouped = new Map();
    for (const entry of entries || []) {
      if (!grouped.has(entry.parent)) grouped.set(entry.parent, []);
      grouped.get(entry.parent).push(entry);
    }
    return grouped;
  };

  const ensured = groupByParent(result.ensured);
  const dropped = groupByParent(result.dropped);
  const blocked = groupByParent(result.blocked);

  const parents = new Set(Object.keys(horizon));
  for (const group of [ensured, dropped, blocked]) {
    for (const parent of group.keys()) parents.add(parent);
  }

  const tables = {};
  let created = 0;
  let droppedCount = 0;
  let refused = 0;

  for (const parent of parents) {
    const createdNames = (ensured.get(parent) || []).map((entry) => entry.name).sort();
    const droppedEntries = (dropped.get(parent) || []).map((entry) => ({
      name: entry.name,
      month: entry.month,
      action: entry.mode === 'detach' ? 'DETACH' : 'DROP'
    }));
    const refusedEntries = (blocked.get(parent) || []).map((entry) => ({
      name: entry.name,
      month: entry.month,
      rows: entry.rows,
      action: 'REFUSED',
      reason: 'NON_EMPTY_WITHOUT_FORCE'
    }));

    const parentHorizon = horizon[parent];
    tables[parent] = {
      partition: parent,
      created: createdNames,
      dropped: droppedEntries,
      refused: refusedEntries,
      horizon:
        parentHorizon && parentHorizon.latest
          ? { month: parentHorizon.latest, end: `${nextMonthKey(parentHorizon.latest)}-01` }
          : null,
      retentionCutoff: result.retentionCutoff
    };

    created += createdNames.length;
    droppedCount += droppedEntries.length;
    refused += refusedEntries.length;
  }

  return {
    generatedAt: result.generatedAt,
    mode: {
      target: result.target,
      monthsAhead: result.monthsAhead,
      monthsBehind: result.monthsBehind,
      retentionMonths: result.retentionMonths,
      detach: args.detach,
      force: args.force,
      dryRun: result.dryRun
    },
    currentMonth: partitions.monthKey(now),
    retentionCutoff: result.retentionCutoff,
    tables,
    summary: { created, dropped: droppedCount, refused, dryRun: result.dryRun }
  };
}

/**
 * Runs one maintenance pass through the module, which owns the advisory lock, the parent
 * list, the create helper and the retention guard. `now` is passed in so the module's
 * window, cutoff and horizon are all derived from the same instant this CLI labels the
 * report with — there is no second clock read to disagree with.
 */
async function runMaintenance(args) {
  const now = new Date();
  const result = await partitions.maintain({
    monthsAhead: args.monthsAhead,
    retentionMonths: args.retentionMonths,
    target: 'all',
    dryRun: args.dryRun,
    force: args.force,
    mode: args.detach ? 'detach' : 'drop',
    // A cron tick must not queue behind a human's run: a pass that cannot take the lock
    // immediately reports "already running" instead of waiting.
    lockWait: false,
    now
  });
  return { result, now };
}

function printHumanReport(report) {
  const mode = report.mode;
  const retention =
    mode.retentionMonths === null
      ? 'disabled (create-only)'
      : `${mode.retentionMonths} month(s)${report.retentionCutoff ? `, before ${report.retentionCutoff.slice(0, 7)}` : ''}, ${mode.detach ? 'detach' : 'drop'}`;

  console.log(`Partition maintenance — ${report.generatedAt}`);
  console.log(
    `  current month: ${report.currentMonth}   months ahead: ${mode.monthsAhead}   ` +
      `retention: ${retention}   mode: ${mode.dryRun ? 'DRY RUN' : 'LIVE'}${mode.force ? ' + force' : ''}`
  );

  for (const [parent, result] of Object.entries(report.tables)) {
    console.log(`\n${parent}`);
    console.log(`  created: ${result.created.length ? result.created.join(', ') : '(none)'}`);
    console.log(
      `  horizon: ${result.horizon ? `${result.horizon.month} through ${result.horizon.end}` : '(none)'}`
    );

    for (const entry of result.dropped) {
      const executed = mode.dryRun ? 'would ' : '';
      console.log(`    ${executed}${entry.action.toLowerCase()}  ${entry.name}`);
    }
    for (const entry of result.refused) {
      console.log(`    refused  ${entry.name}  (${entry.rows} rows) — non-empty; use --force`);
    }
  }

  const summary = report.summary;
  console.log(
    `\nSummary: ${summary.created} created, ${summary.dropped} ` +
      `${mode.dryRun ? 'would drop' : 'dropped'}, ${summary.refused} refused`
  );
  if (mode.dryRun) console.log('Dry run — nothing was changed.');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const { result, now } = await runMaintenance(args);

  // The module returns `skipped` instead of throwing when another pass holds the lock —
  // losing that race is normal, and a second pass would only conflict. A skipped run
  // changed nothing, so it exits 1: the operator must not read it as "the horizon is now
  // rolled forward".
  if (result.skipped) {
    const message = `Another partition maintenance pass holds the '${partitions.LOCK_NAME}' lock (${result.reason}); nothing was changed.`;
    logger.warn('Partition maintenance skipped: advisory lock held', {
      lock: partitions.LOCK_NAME,
      reason: result.reason
    });
    if (args.json) {
      console.log(JSON.stringify({ ok: false, lockHeld: true, reason: result.reason, message }, null, 2));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }

  const report = buildReport(result, args, now);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  // A refused retirement is a check that failed: the operator asked for the month to go and
  // it is still there. A dry run is a report, so it never fails on that account — the same
  // refusal there is the finding, not an error. Any real error has already been thrown out
  // of the module and handled by the catch below.
  const failed = report.summary.refused > 0 && !args.dryRun;
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => {
    logger.error('Partition maintenance failed', { error: err });
    if (!env.isProduction && err.stack) console.error(err.stack);
    process.exitCode = typeof err.exitCode === 'number' ? err.exitCode : 1;
  })
  .finally(async () => {
    await pool.close();
  });
