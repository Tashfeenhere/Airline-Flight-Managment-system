#!/usr/bin/env node
'use strict';
/**
 * `npm run readmodel:reproject` — rebuild the CQRS read models from the write model.
 *
 * Two projections can drift, or need a deliberate rebuild:
 *
 *   flight_availability  (airline_read)  search. Rebuilt by *replaying the outbox*,
 *                                        because availability is a function of event
 *                                        order (versioned counter snapshots), not of a
 *                                        current-state table. `--availability`.
 *   user_bookings        (write model)   the passenger's own booking list. Rebuilt
 *                                        straight from the authoritative `bookings`
 *                                        table, one user at a time. `--user`,
 *                                        `--all-users`.
 *
 * OPERATIONAL STORY
 *
 * Rebuilding is a maintenance action run by an operator, or by the documented post-load
 * step after a bulk COPY. It is safe to run while the application is live, and safe to
 * run twice, for one reason: every projection write is a *guarded upsert*
 * (`... WHERE source_version <= EXCLUDED.source_version` for availability,
 * `... WHERE last_event_at <= EXCLUDED.last_event_at` for user_bookings). A replayed
 * event, a batch delivered out of order, or a second run of this script therefore either
 * writes the row it should have or is rejected as stale — it never walks a fresh row
 * backwards. That is why "run it again" is the correct first response to a suspect
 * projection, and why this script deletes nothing before it writes.
 *
 * The script owns NO projection logic. It pages the write model and calls
 * projectionService, which is the single place the guards live; a second copy of the
 * arithmetic here would be the copy that silently disagrees. Concurrent reprojections
 * are serialised with the `reproject-readmodel` advisory lock, so two operators starting
 * it by accident do not double the load for no extra effect.
 *
 * THE BULK-LOADER SEAM
 *
 * The ~50M-flight loader inserts `flights` and `flight_inventory` with COPY (see
 * docs/DATA_LOADING.md). COPY bypasses the API, and therefore the outbox: those rows
 * produce no events, and `--availability` can only replay events that exist. A loader
 * that wants search to see its flights must also seed `booking_outbox` with
 * FLIGHT_UPSERTED / INVENTORY_CHANGED rows (or write `flight_availability` itself);
 * this script is the documented step that turns those events into read-model rows
 * afterwards. `--all-users` needs no such precondition — user_bookings is rebuilt from
 * the authoritative `bookings` table.
 *
 * Exit codes: 0 success, 1 failure (including "another reprojection already holds the
 * lock" and any database error), 2 usage error.
 */
const pool = require('../src/db/pool');
const env = require('../src/config/env');
const logger = require('../src/utils/logger');
const ids = require('../src/utils/ids');
const { withAdvisoryLock } = require('../src/db/locks');
const { OUTBOX_EVENT_TYPES } = require('../src/config/constants');
const projectionService = require('../src/services/projectionService');
const outboxRepository = require('../src/repositories/outboxRepository');
const bookingRepository = require('../src/repositories/bookingRepository');

/** One lock name for every reprojection, so two invocations cannot overlap. */
const LOCK_NAME = 'reproject-readmodel';

/**
 * Default lower bound for the outbox replay. `listForReprojection` compares
 * `created_at >= $1`, and a NULL bound would make that predicate NULL and filter every
 * row out — so an omitted `--since` must become an explicit, very old timestamp rather
 * than NULL, or "replay everything" would silently replay nothing.
 */
const EPOCH = '1970-01-01T00:00:00.000Z';

/** The only event types the availability projection reads (see projectionService). */
const INVENTORY_EVENT_TYPES = [
  OUTBOX_EVENT_TYPES.INVENTORY_CHANGED,
  OUTBOX_EVENT_TYPES.FLIGHT_UPSERTED
];

/** Any invalid first id: UUID comparison starts above the nil uuid. */
const UNSET_USER_CURSOR = '00000000-0000-0000-0000-000000000000';

class UsageError extends Error {}

const HELP = `
reproject-readmodel — rebuild the CQRS read models from the write model.

Usage:
  node scripts/reproject-readmodel.js <selector> [options]

Selectors (at least one is required):
  --availability          Replay outbox inventory events into flight_availability
                          (the airline_read database). Precondition: the events exist
                          in booking_outbox.
  --user <uuid>           Rebuild user_bookings for one user, from the bookings table.
  --all-users             Rebuild user_bookings for every user, paged.

Options:
  --since <iso>           Lower bound (inclusive) on event created_at, for
                          --availability. Default: ${EPOCH}
  --until <iso>           Upper bound (inclusive) on event created_at, for
                          --availability. Default: now.
  --batch-size <n>        Outbox page size for --availability, and users per page for
                          --all-users. Default: ${env.OUTBOX_BATCH_SIZE}
  --dry-run               Report what would be processed; write nothing.
  --json                  Emit the final summary as JSON on stdout.
  --help                  Show this help.

Notes:
  - Safe to run on a live cluster and safe to run twice: the guarded upserts make a
    replayed event (or a second run) a no-op rather than a regression.
  - --availability scans the outbox once to size the run and once to replay it; scope
    it with --since/--until on a large history.
  - --user and --all-users are mutually exclusive.

Exit codes: 0 success, 1 failure, 2 usage error.
`;

/**
 * Parses argv, accepting both `--flag value` and `--flag=value`. Raises UsageError
 * (exit 2) on anything malformed so an operator typo is reported, never guessed at.
 */
function parseArgs(argv) {
  const args = {
    availability: false,
    user: null,
    allUsers: false,
    since: null,
    until: null,
    batchSize: null,
    dryRun: false,
    json: false,
    help: false
  };

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

    switch (name) {
      case '--availability':
        args.availability = true;
        break;
      case '--all-users':
        args.allUsers = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--user':
        args.user = readValue();
        break;
      case '--since':
        args.since = readValue();
        break;
      case '--until':
        args.until = readValue();
        break;
      case '--batch-size': {
        const value = readValue();
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || String(parsed) !== String(value).trim() || parsed <= 0) {
          throw new UsageError(`--batch-size must be a positive integer, received: ${value}`);
        }
        args.batchSize = parsed;
        break;
      }
      default:
        throw new UsageError(`Unknown option: ${name}`);
    }
  }

  return args;
}

function assertIsoInstant(flag, value) {
  if (Number.isNaN(Date.parse(value))) {
    throw new UsageError(`${flag} must be an ISO-8601 timestamp, received: ${value}`);
  }
}

/**
 * Turns parsed argv into a validated plan. Throws UsageError on an ambiguous or
 * unsatisfiable request rather than picking a default and doing the wrong thing — a
 * silent wrong selector is worse than a refusal.
 */
function plan(args) {
  const hasAvailability = args.availability;
  const hasUser = Boolean(args.user);
  const hasAllUsers = args.allUsers;

  if (!hasAvailability && !hasUser && !hasAllUsers) {
    throw new UsageError('a selector is required: --availability, --user <uuid>, or --all-users');
  }
  if (hasUser && hasAllUsers) {
    throw new UsageError('--user and --all-users are mutually exclusive');
  }
  if (hasUser && !ids.isValidUuid(args.user)) {
    throw new UsageError(`--user must be a UUID, received: ${args.user}`);
  }
  if ((args.since !== null || args.until !== null) && !hasAvailability) {
    throw new UsageError('--since/--until only apply to --availability');
  }
  if (args.since !== null) assertIsoInstant('--since', args.since);
  if (args.until !== null) assertIsoInstant('--until', args.until);

  return {
    availability: hasAvailability,
    user: hasUser ? args.user.trim().toLowerCase() : null,
    allUsers: hasAllUsers,
    since: args.since !== null ? args.since : EPOCH,
    until: args.until !== null ? args.until : new Date().toISOString(),
    batchSize: args.batchSize !== null ? args.batchSize : env.OUTBOX_BATCH_SIZE,
    dryRun: args.dryRun,
    json: args.json
  };
}

/**
 * Counts the outbox rows a `--availability` replay will read.
 *
 * The service returns only a row count, so the "events replayed" figure has to come
 * from somewhere; one event can describe every cabin of a flight, so rows cannot be
 * divided back into events. This pass is read-only and uses the same repository call
 * the service uses, so it cannot disagree with what the replay will see.
 */
async function countAvailabilityEvents({ since, until, batchSize }) {
  let offset = 0;
  let events = 0;

  for (;;) {
    const page = await outboxRepository.listForReprojection(pool.writePool, {
      since,
      until,
      limit: batchSize,
      offset,
      eventTypes: INVENTORY_EVENT_TYPES
    });
    if (page.length === 0) break;
    events += page.length;
    offset += page.length;
    if (page.length < batchSize) break;
  }

  return events;
}

/**
 * Enumerates users by keyset, never by loading them all.
 *
 * `users` is a small reference table today (~100k) but the job processes every user's
 * bookings one at a time; materialising the whole table to iterate it would scale the
 * memory footprint with the table, which is exactly what paging avoids. Keyset on `id`
 * rather than OFFSET because ids are UUIDv7 (time-ordered), so the walk stays correct
 * and cheap as the table grows under it.
 */
async function fetchUserPage(afterId, limit) {
  const { rows } = await pool.writePool.query(
    `SELECT id FROM users WHERE id > $1::uuid ORDER BY id LIMIT $2`,
    [afterId, limit]
  );
  return rows;
}

/** Rebuilds one user's projection; returns the service's own counters. */
async function reprojectOneUser(userId, { dryRun }) {
  if (dryRun) {
    // Count what would be written without writing: the authoritative source of truth
    // for the count is the same lookup the service performs internally.
    const bookings = await bookingRepository.listByUser(pool.writePool, { userId, limit: 10000 });
    return { scanned: bookings.length, written: 0 };
  }
  return projectionService.reprojectUser({ userId });
}

async function runAvailability(options, summary, report) {
  const { since, until, batchSize, dryRun } = options;

  report(`availability: counting outbox events in [${since}, ${until}]`);
  const events = await countAvailabilityEvents({ since, until, batchSize });

  summary.availability = { since, until, events, batches: 0, rowsUpserted: dryRun ? null : 0 };

  if (dryRun) {
    report(`availability: dry run — would replay ${events} event(s) into flight_availability`);
    return;
  }

  report(`availability: replaying ${events} event(s) into flight_availability`);

  const result = await projectionService.reprojectAvailability({
    since,
    until,
    limit: batchSize,
    onProgress: ({ batches, projected }) => {
      // A 50M-event history is thousands of batches; printing each one would bury the
      // summary, so report only every 25th and let the final line carry the truth.
      if (batches % 25 === 0) {
        report(`availability: ${batches} batch(es), ${projected} row(s) upserted so far`);
      }
    }
  });

  summary.availability.batches = result.batches;
  summary.availability.rowsUpserted = result.projected;
}

async function runOneUser(options, summary, report) {
  const { user, dryRun } = options;

  if (dryRun) {
    const { scanned } = await reprojectOneUser(user, { dryRun: true });
    summary.users = { mode: 'single', userId: user, processed: 1, rowsScanned: scanned, rowsWritten: 0 };
    report(`user ${user}: dry run — would examine ${scanned} booking(s)`);
    return;
  }

  const result = await projectionService.reprojectUser({ userId: user });
  summary.users = {
    mode: 'single',
    userId: user,
    processed: 1,
    rowsScanned: result.scanned,
    rowsWritten: result.written
  };
  report(
    `user ${user}: ${result.scanned} booking(s) examined, ${result.written} row(s) written, ` +
      `${result.scanned - result.written} skipped (already current)`
  );
}

async function runAllUsers(options, summary, report) {
  const { batchSize, dryRun } = options;
  summary.users = { mode: 'all', processed: 0, rowsScanned: 0, rowsWritten: 0 };

  let cursor = UNSET_USER_CURSOR;
  let pageNumber = 0;

  for (;;) {
    const page = await fetchUserPage(cursor, batchSize);
    if (page.length === 0) break;

    pageNumber += 1;
    for (const row of page) {
      const result = await reprojectOneUser(row.id, { dryRun });
      summary.users.processed += 1;
      summary.users.rowsScanned += result.scanned;
      summary.users.rowsWritten += result.written;
      cursor = row.id;
    }

    // One line per page, not per user: 100k users must not mean 100k lines.
    report(
      `all-users: page ${pageNumber} — ${summary.users.processed} user(s) processed, ` +
        `${summary.users.rowsScanned} booking(s) examined, ${summary.users.rowsWritten} row(s) written`
    );
  }

  if (summary.users.processed === 0) {
    report('all-users: no users found');
  }
}

/** Human line for a run, plus the machine summary in --json mode. */
function printSummary(options, summary, report) {
  const rowsWritten =
    (summary.availability && summary.availability.rowsUpserted ? summary.availability.rowsUpserted : 0) +
    (summary.users ? summary.users.rowsWritten : 0);

  // The availability guard collapses "written" and "rejected-stale" into one upsert
  // call, so the split is only knowable for the projections rebuilt from a table.
  const rowsSkippedStale = summary.users && !summary.availability
    ? summary.users.rowsScanned - summary.users.rowsWritten
    : null;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: options.dryRun,
          selectors: {
            availability: options.availability,
            user: options.user,
            allUsers: options.allUsers
          },
          availability: summary.availability,
          users: summary.users,
          rowsWritten,
          rowsSkippedStale,
          durationMs: summary.durationMs
        },
        null,
        2
      )}\n`
    );
    return;
  }

  report('');
  report(options.dryRun ? 'summary (DRY RUN — nothing was written)' : 'summary');
  if (summary.availability) {
    const a = summary.availability;
    report(`  availability events replayed : ${a.events}`);
    report(
      `  availability rows upserted    : ${
        a.rowsUpserted === null ? 'n/a (dry run)' : a.rowsUpserted
      } (guarded upserts; a replayed or already-current row is a no-op)`
    );
  }
  if (summary.users) {
    const u = summary.users;
    report(`  users processed               : ${u.processed}`);
    report(`  bookings examined             : ${u.rowsScanned}`);
    report(`  user_bookings rows written    : ${u.rowsWritten}`);
  }
  report(`  total rows written            : ${rowsWritten}`);
  report(
    `  rows skipped-because-stale    : ${
      rowsSkippedStale === null
        ? 'n/a (folded into the guarded availability upsert)'
        : rowsSkippedStale
    }`
  );
  report(`  duration                      : ${(summary.durationMs / 1000).toFixed(2)}s`);
  if (!options.dryRun) {
    report('');
    report('Replaying is idempotent: running this again is safe and changes nothing already current.');
  }
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

  const summary = { durationMs: 0 };
  const report = (line) => process.stderr.write(`${line}\n`);
  const startedAt = Date.now();

  const work = async () => {
    if (options.availability) await runAvailability(options, summary, report);
    if (options.user) await runOneUser(options, summary, report);
    if (options.allUsers) await runAllUsers(options, summary, report);
  };

  if (options.dryRun) {
    // Nothing is written, so there is nothing to serialise: a dry run must not block a
    // real one, and a real one must not make a dry run wait.
    await work();
  } else {
    const lock = await withAdvisoryLock(LOCK_NAME, work);
    if (!lock.acquired) {
      const message =
        'another reprojection already holds the advisory lock; refusing to run a second one.';
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ acquired: false, reason: lock.reason }, null, 2)}\n`);
      } else {
        report(`error: ${message} (${lock.reason})`);
      }
      return 1;
    }
  }

  summary.durationMs = Date.now() - startedAt;
  printSummary(options, summary, report);
  // In --json mode printSummary has just written the summary document to stdout, and
  // logger.info emits through console.log (also stdout) — so logging here would append a
  // second JSON record and leave stdout as two documents, breaking the documented
  // '--json: Emit the final summary as JSON on stdout' contract. The human-facing success
  // line is therefore suppressed under --json; the progress `report` lines go to stderr and
  // are unaffected. The failure log below stays unconditional: it goes to stderr.
  if (!options.json) {
    logger.info('Read-model reprojection complete', {
      dryRun: options.dryRun,
      availability: options.availability,
      user: options.user,
      allUsers: options.allUsers,
      durationMs: summary.durationMs
    });
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    logger.error('Read-model reprojection failed', { error: err.message });
    process.exitCode = 1;
  })
  .finally(async () => {
    // A hung operator script is an operator's worst morning, so the pools are closed on
    // every path — success, refusal, usage error and thrown failure alike.
    await pool.close();
  });
