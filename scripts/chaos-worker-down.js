#!/usr/bin/env node
/**
 * Chaos test: stop the background workers, keep selling seats, restart, verify recovery.
 *
 * The claim under test is the architectural one, not a code path: the booking transaction
 * writes the outbox row *inside* the same transaction, so losing the worker cannot lose a
 * booking. What it can do is make the read model stale until the worker returns. This
 * script proves both halves — the write path keeps succeeding while the worker is down,
 * and the read model catches up exactly once it is back, with no events stuck pending and
 * no seat oversold.
 *
 * It is destructive and therefore safe-by-default: without `--execute` it prints the plan
 * and exits. With `--execute` it:
 *
 *   1. takes a baseline of outbox stats,
 *   2. runs the down command (default: `docker compose --profile workers stop workers`),
 *   3. creates a fixture flight and books N seats — every booking must succeed,
 *   4. asserts the read model still has no row for that flight (the projector is down),
 *      while the outbox backlog grew by at least N+1 events,
 *   5. runs the up command and polls until the projection matches the write model,
 *   6. audits the counters and cleans up the fixture.
 *
 * Usage:
 *   node scripts/chaos-worker-down.js                       # dry run: print the plan
 *   node scripts/chaos-worker-down.js --execute
 *   node scripts/chaos-worker-down.js --execute --bookings 20 --keep
 *   node scripts/chaos-worker-down.js --execute --flight-id <uuid> --departure-date 2027-03-01
 *   node scripts/chaos-worker-down.js --execute --skip-worker-control
 *       # for an environment where the workers are stopped/started out of band
 *
 * Exit codes: 0 recovery verified (or dry run), 1 verification failed, 2 usage error.
 */
'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');

const pool = require('../src/db/pool');
const env = require('../src/config/env');
const ids = require('../src/utils/ids');
const partitions = require('../src/db/partitions');
const flightService = require('../src/services/flightService');
const bookingService = require('../src/services/bookingService');
const inventoryRepository = require('../src/repositories/inventoryRepository');

const DEFAULT_DOWN = 'docker compose --profile workers stop workers';
const DEFAULT_UP = 'docker compose --profile workers start workers';
const DEFAULT_BOOKINGS = 5;
const DEFAULT_TIMEOUT_SECONDS = 120;

function usage() {
  return `Usage: node scripts/chaos-worker-down.js [options]

Options:
  --execute                  Actually stop/start workers and write data. Without it,
                             the script prints what it would do and makes no changes.
  --bookings <n>             Seats to book while the worker is down (default ${DEFAULT_BOOKINGS}).
  --cabin <name>             Cabin to book (default ECONOMY).
  --flight-id <uuid>         Use an existing flight instead of creating a fixture.
  --departure-date <date>    Date for the fixture flight (default: today + 30 days).
  --down-cmd <command>       Command that stops the workers (default: "${DEFAULT_DOWN}").
  --up-cmd <command>         Command that starts them (default: "${DEFAULT_UP}").
  --skip-worker-control      Do not run either command; assume workers are already down
                             when the script starts and are restarted out of band.
  --timeout <seconds>        How long to wait for the projection to catch up (default ${DEFAULT_TIMEOUT_SECONDS}).
  --poll-ms <ms>             Poll interval while waiting (default 1000).
  --keep                     Leave the fixture flight and its bookings in place.
  --json                     Print a machine-readable report.
  --help, -h                 Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    execute: false,
    bookings: DEFAULT_BOOKINGS,
    cabin: 'ECONOMY',
    flightId: null,
    departureDate: null,
    downCmd: DEFAULT_DOWN,
    upCmd: DEFAULT_UP,
    skipWorkerControl: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    pollMs: 1000,
    keep: false,
    json: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--execute': options.execute = true; break;
      case '--bookings': options.bookings = positiveInt(value(), '--bookings'); break;
      case '--cabin': options.cabin = String(value()).toUpperCase(); break;
      case '--flight-id': options.flightId = value(); break;
      case '--departure-date': options.departureDate = value(); break;
      case '--down-cmd': options.downCmd = value(); break;
      case '--up-cmd': options.upCmd = value(); break;
      case '--skip-worker-control': options.skipWorkerControl = true; break;
      case '--timeout': options.timeoutSeconds = positiveInt(value(), '--timeout'); break;
      case '--poll-ms': options.pollMs = positiveInt(value(), '--poll-ms'); break;
      case '--keep': options.keep = true; break;
      case '--json': options.json = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function positiveInt(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function runShell(command, { dryRun }) {
  log(`$ ${command}`);
  if (dryRun) return { status: 0, skipped: true };

  // Captured rather than inherited so `--json` output stays parseable; the command's
  // own output still reaches the operator, on stderr, where a log belongs.
  const result = spawnSync(command, { shell: true, stdio: ['inherit', 'pipe', 'pipe'], env: process.env });
  if (result.error) throw result.error;
  if (result.stdout && result.stdout.length > 0) process.stderr.write(result.stdout);
  if (result.stderr && result.stderr.length > 0) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${command}`);
  }
  return { status: result.status, skipped: false };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function datePlus(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function outboxForFlight(flightId) {
  const { rows } = await pool.writePool.query(
    `SELECT count(*) FILTER (WHERE published = false)::int AS pending,
            count(*)::int AS total,
            max(attempts)::int AS max_attempts
       FROM booking_outbox WHERE flight_id = $1`,
    [flightId]
  );
  const row = rows[0] || {};
  return {
    pending: Number(row.pending || 0),
    total: Number(row.total || 0),
    maxAttempts: Number(row.max_attempts || 0)
  };
}

async function projectedRows(flightId) {
  const { rows } = await pool.readPool.query(
    `SELECT cabin, total_seats, available_seats, held_seats, source_version
       FROM flight_availability WHERE flight_id = $1 ORDER BY cabin`,
    [flightId]
  );
  return rows.map((row) => ({
    cabin: row.cabin,
    totalSeats: Number(row.total_seats),
    availableSeats: Number(row.available_seats),
    heldSeats: Number(row.held_seats),
    sourceVersion: Number(row.source_version)
  }));
}

async function deleteFixture(flightId) {
  await pool.writePool.query('DELETE FROM payments WHERE flight_id = $1', [flightId]);
  await pool.writePool.query('DELETE FROM user_bookings WHERE flight_id = $1', [flightId]);
  await pool.writePool.query('DELETE FROM bookings WHERE flight_id = $1', [flightId]);
  await pool.writePool.query('DELETE FROM booking_outbox WHERE flight_id = $1', [flightId]);
  await pool.writePool.query('DELETE FROM flight_inventory WHERE flight_id = $1', [flightId]);
  await pool.writePool.query('DELETE FROM flights WHERE flight_id = $1', [flightId]);
  await pool.readPool.query('DELETE FROM flight_availability WHERE flight_id = $1', [flightId]);
}

async function createFixture({ flightId, departureDate }) {
  const suffix = String(Math.floor(Math.random() * 900) + 100);
  const result = await flightService.upsertFlight({
    flightId,
    flightNumber: `CH-${suffix}`,
    airlineCode: 'CH',
    origin: 'ISB',
    destination: 'DXB',
    departureDate,
    departureTime: `${departureDate}T09:00:00.000Z`,
    arrivalTime: `${departureDate}T11:30:00.000Z`,
    aircraftType: 'A320',
    basePrice: 15000,
    currency: 'USD'
  });
  return result;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${usage()}`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const runId = crypto.randomBytes(4).toString('hex');
  const flightId = options.flightId || ids.newUuid();
  const createdFixture = !options.flightId;
  const dryRun = !options.execute;
  let departureDate = options.departureDate || datePlus(30);

  if (options.flightId && !options.departureDate) {
    // An existing flight's date cannot be guessed: the fixture default would target the
    // wrong partition and the audit would report an empty, misleading success.
    const { rows } = await pool.writePool.query(
      'SELECT departure_date::text AS date FROM flights WHERE flight_id = $1 LIMIT 1',
      [flightId]
    );
    if (rows.length === 0) {
      process.stderr.write(`Error: no flight found with id ${flightId}\n`);
      await pool.close();
      return 2;
    }
    departureDate = rows[0].date;
  }

  const report = {
    runId,
    dryRun,
    flightId,
    departureDate,
    bookingsRequested: options.bookings,
    steps: [],
    passed: null
  };
  const step = (name, detail = {}) => {
    report.steps.push({ name, ...detail });
    if (!options.json) log(`\n== ${name}\n${JSON.stringify(detail, null, 2)}`);
  };

  try {
    step('plan', {
      flightId,
      departureDate,
      createdFixture,
      bookings: options.bookings,
      downCommand: options.skipWorkerControl ? '(skipped)' : options.downCmd,
      upCommand: options.skipWorkerControl ? '(skipped)' : options.upCmd
    });

    if (!dryRun) {
      // Partitions are a precondition for writing at all; ensure them for the fixture
      // month before touching the workers so a partition miss is not mistaken for a
      // worker outage.
      const monthStart = new Date(`${departureDate.slice(0, 7)}-01T00:00:00.000Z`);
      const now = new Date();
      const nowMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const monthsBehind = Math.max(0, (nowMonth.getUTCFullYear() - monthStart.getUTCFullYear()) * 12 + nowMonth.getUTCMonth() - monthStart.getUTCMonth());
      await partitions.ensurePartitions(pool.writePool, {
        parents: partitions.WRITE_PARENTS,
        monthsBehind,
        monthsAhead: 2
      });
      await partitions.ensurePartitions(pool.readPool, {
        parents: partitions.READ_PARENTS,
        monthsBehind,
        monthsAhead: 2
      });
    }

    const baseline = await pool.writePool.query(
      `SELECT count(*) FILTER (WHERE published = false)::int AS pending FROM booking_outbox`
    );
    const baselinePending = Number(baseline.rows[0].pending || 0);
    step('baseline', { pendingOutboxEvents: baselinePending });

    // 1. Stop the worker. It is stopped before the fixture exists, so a row in the read
    //    model later can only have come from the restarted worker.
    if (!options.skipWorkerControl) runShell(options.downCmd, { dryRun });

    if (dryRun) {
      step('would-book', {
        seats: options.bookings,
        expectation: 'all bookings succeed, outbox backlog grows by at least bookings + 1'
      });
      step('would-wait', {
        for: 'flight_availability to match the write model after restart',
        timeoutSeconds: options.timeoutSeconds
      });
      report.passed = true;
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }

    // 2. Create the flight and sell seats while nothing is projecting. The projection
    //    is sampled immediately before the bookings so an existing flight (one projected
    //    by an earlier run) can be used as well: what must not change is its *state*,
    //    not its existence.
    if (createdFixture) {
      await createFixture({ flightId, departureDate });
    }
    step('flight', { flightId, departureDate, created: createdFixture });

    const projectedBefore = await projectedRows(flightId);

    let confirmed = 0;
    let failed = 0;
    const failures = [];
    for (let i = 0; i < options.bookings; i += 1) {
      try {
        await bookingService.createBooking({
          userId: env.GUEST_USER_ID,
          flightId,
          cabin: options.cabin,
          passengerName: `Chaos ${runId} #${i + 1}`,
          idempotencyKey: `chaos-${runId}-${i + 1}`
        });
        confirmed += 1;
      } catch (err) {
        failed += 1;
        failures.push({ index: i + 1, code: err.code || err.name, message: err.message });
      }
    }
    step('bookings-while-worker-down', { requested: options.bookings, confirmed, failed, failures });

    if (confirmed !== options.bookings) {
      throw new Error(
        `The write path must not depend on the worker, but only ${confirmed}/${options.bookings} bookings succeeded`
      );
    }

    // 3. The read model must not have advanced for this flight, and the events must be
    //    sitting in the outbox. Anything else means the worker was not actually down (or
    //    another replica is still running).
    const projectedWhileDown = await projectedRows(flightId);
    const outboxDown = await outboxForFlight(flightId);
    const backlogGrew = Number((await pool.writePool.query(
      `SELECT count(*) FILTER (WHERE published = false)::int AS pending FROM booking_outbox`
    )).rows[0].pending) - baselinePending;

    step('while-down', {
      projectedRowsBefore: projectedBefore.length,
      projectedRowsAfter: projectedWhileDown.length,
      outboxPendingForFlight: outboxDown.pending,
      outboxEventsForFlight: outboxDown.total,
      backlogDelta: backlogGrew
    });

    if (JSON.stringify(projectedBefore) !== JSON.stringify(projectedWhileDown)) {
      throw new Error(
        'The read model changed for this flight while the worker was supposed to be down; ' +
          'stop every worker replica or re-run with --skip-worker-control only after doing so'
      );
    }
    if (outboxDown.total < options.bookings + 1) {
      throw new Error(
        `Expected at least ${options.bookings + 1} outbox events (flight + bookings), found ${outboxDown.total}`
      );
    }
    if (backlogGrew < options.bookings + 1) {
      throw new Error(
        `Outbox backlog grew by ${backlogGrew}, expected at least ${options.bookings + 1}`
      );
    }

    // 4. Restart and wait for recovery.
    if (!options.skipWorkerControl) runShell(options.upCmd, { dryRun: false });
    else step('restart', { skipped: true, reason: '--skip-worker-control' });

    const writeModel = await flightService.getAvailability({ flightId, departureDate, cabin: options.cabin });
    const target = writeModel.cabins.find((entry) => entry.cabin === options.cabin);
    if (!target) throw new Error(`The write model has no ${options.cabin} counter for ${flightId}`);

    const deadline = Date.now() + options.timeoutSeconds * 1000;
    let projected = [];
    let outboxAfter = { pending: null, total: null };

    while (Date.now() < deadline) {
      projected = await projectedRows(flightId);
      outboxAfter = await outboxForFlight(flightId);
      const cabin = projected.find((row) => row.cabin === options.cabin);
      const caughtUp =
        cabin &&
        outboxAfter.pending === 0 &&
        cabin.availableSeats === target.availableSeats &&
        cabin.heldSeats === target.heldSeats;
      if (caughtUp) break;
      await sleep(options.pollMs);
    }

    const projectedCabin = projected.find((row) => row.cabin === options.cabin) || null;
    step('after-restart', {
      projected: projectedCabin,
      writeModel: {
        availableSeats: target.availableSeats,
        heldSeats: target.heldSeats,
        totalSeats: target.totalSeats
      },
      outboxPending: outboxAfter.pending,
      outboxTotal: outboxAfter.total
    });

    const audit = await inventoryRepository.audit(pool.writePool, {
      flightId,
      departureDate,
      cabin: options.cabin
    });
    step('audit', { violations: audit.violations });

    const recovered =
      projectedCabin !== null &&
      outboxAfter.pending === 0 &&
      projectedCabin.availableSeats === target.availableSeats &&
      projectedCabin.heldSeats === target.heldSeats &&
      audit.violations.length === 0;

    report.passed = recovered;
    report.summary = {
      confirmed,
      outboxEvents: outboxAfter.total,
      writeModelAvailable: target.availableSeats,
      projectedAvailable: projectedCabin ? projectedCabin.availableSeats : null,
      violations: audit.violations.length
    };

    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else log(`\n${recovered ? 'PASS' : 'FAIL'}: ${JSON.stringify(report.summary)}`);

    return recovered ? 0 : 1;
  } catch (err) {
    report.passed = false;
    report.error = err.message;
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else log(`\nFAIL: ${err.message}`);
    return 1;
  } finally {
    if (!dryRun && createdFixture && !options.keep) {
      try {
        await deleteFixture(flightId);
        log(`Cleaned up fixture flight ${flightId}`);
      } catch (err) {
        log(`Cleanup failed for ${flightId}: ${err.message}`);
      }
    }
    await pool.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`Unhandled failure: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
