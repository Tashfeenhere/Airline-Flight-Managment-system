#!/usr/bin/env node
/**
 * `npm run stress` — the live concurrency proof that the inventory counter cannot oversell.
 *
 * Every other test in this repo reads a static assertion out of a file. This one is the
 * operator's answer to the only question that matters when someone asks "but what happens
 * under load?": it fires N booking attempts at ONE cabin at the same instant and checks the
 * arithmetic of the result against the capacity that was there before it started.
 *
 * Why a barrier and not a loop of awaits
 * -------------------------------------
 * A sequential `for` loop would emit one booking at a time. That proves nothing about the
 * race: the whole guarantee lives in PostgreSQL's row lock on `flight_inventory`, and a
 * serialized caller never contends for it. So every attempt is parked on a shared barrier
 * (`Promise.all` over promises that all block on one gate), the gate is released once the
 * last one has arrived, and only then do they all enter the booking path together. That is
 * as close to "simultaneous" as one Node process gets; the database interleaves them from
 * there, which is exactly the interleaving under test.
 *
 * Why it drives the service layer rather than HTTP
 * ------------------------------------------------
 * The concurrency that can oversell is at the database, not at the socket: the row lock and
 * the `available_seats >= 1` predicate are what make the invariant true, and those are
 * reached identically by `bookingService.createBooking` and by the route that calls it. So
 * the script calls the service directly — no API instances, no rate limit, no bearer token
 * — and still exercises the real transaction. (When several instances ARE running, the same
 * guarantee holds across processes because none of it lives in process memory; see
 * docs/TESTING.md.)
 *
 * What it asserts
 * ---------------
 *   successes        == min(attempts, remaining capacity)   — every seat sold exactly once
 *   every failure    == SOLD_OUT                            — the losers were told the truth
 *   available_seats  >= 0 and available + held <= capacity  — the counter never went negative
 *   oversell audit   clean for this flight                  — counters agree with the bookings
 *
 * Anything else — an unexpected error code, a count that does not add up, a negative
 * counter — is a FAILURE, and failure is the point. A stress test that cannot fail is a
 * stress test that cannot find a bug.
 *
 * Pool sizing
 * -----------
 * Each in-flight booking holds a pool connection, so `--concurrency` above the write pool's
 * max does not add real parallelism — those attempts queue for a connection. The script
 * warns when that happens (the invariant still holds; only the latency numbers distort), and
 * the queueing is itself worth seeing before someone "optimises" the pool by shrinking it.
 *
 * Exit codes: 0 all invariants held, 1 a check failed or an oversell was detected,
 * 2 bad usage.
 */
'use strict';

const { performance } = require('node:perf_hooks');

const env = require('../src/config/env');
const pool = require('../src/db/pool');
const cache = require('../src/cache');
const { ERROR_CODES } = require('../src/config/constants');
const { newUuid, randomToken, isValidUuid } = require('../src/utils/ids');
const flightService = require('../src/services/flightService');
const bookingService = require('../src/services/bookingService');
const inventoryRepository = require('../src/repositories/inventoryRepository');

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({ concurrency: 50, capacity: 10 });
const VALUE_FLAGS = new Set(['concurrency', 'capacity', 'flight', 'date']);

/** Thrown for anything the operator can fix by reading --help. Maps to exit code 2. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const USAGE = `
Usage: node scripts/stress-test.js [options]

Drives N simultaneous bookings at one cabin of one flight and asserts the anti-oversell
invariant: successes == min(N, remaining seats), every loser is told SOLD_OUT, no counter
goes negative, and the oversell audit stays clean.

Options:
  --concurrency=N    Simultaneous booking attempts to fire. Default ${DEFAULTS.concurrency}.
  --capacity=N       Capacity of the test flight this script creates. Default ${DEFAULTS.capacity}.
                     Ignored (with a warning) when --flight points at an existing flight.
  --flight=UUID      Book against an existing flight instead of creating one. The cabin and
                     its remaining capacity are read from that flight.
  --date=YYYY-MM-DD  Departure date for the created flight. Default: 30 days ahead. Must be
                     in the future and inside the partition horizon.
  --replay           After the run, re-issue the winning idempotency keys and prove a replay
                     returns the original booking and consumes no second seat.
  --keep             Skip cleanup. Leaves the flight and its bookings in place for inspection.
  --json             Emit a machine-readable JSON report instead of human text.
  --help, -h         Show this help.

Exit codes:
  0  every invariant held
  1  a check failed, or an oversell was detected
  2  bad usage (unknown flag, bad value, impossible date)
`;

function parseArgs(argv) {
  const opts = {
    concurrency: DEFAULTS.concurrency,
    capacity: DEFAULTS.capacity,
    flight: null,
    date: null,
    replay: false,
    keep: false,
    json: false,
    help: false,
    // Which value flags were actually supplied, so "explicitly asked for the default" is
    // distinguishable from "left it alone" when deciding whether to warn.
    provided: new Set()
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--replay') {
      opts.replay = true;
      continue;
    }
    if (arg === '--keep') {
      opts.keep = true;
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new UsageError(`Unexpected argument: ${arg}`);
    }

    // Accept both `--flag=value` and `--flag value`; operators type both.
    const equals = arg.indexOf('=');
    let name;
    let raw;
    if (equals !== -1) {
      name = arg.slice(2, equals);
      raw = arg.slice(equals + 1);
    } else {
      name = arg.slice(2);
      raw = argv[index + 1];
      if (raw === undefined) throw new UsageError(`Option --${name} requires a value`);
      index += 1;
    }

    if (!VALUE_FLAGS.has(name)) throw new UsageError(`Unknown option: --${name}`);
    opts[name] = raw;
    opts.provided.add(name);
  }

  return opts;
}

function parsePositiveInt(raw, name) {
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < 1 || String(value) !== String(raw).trim()) {
    throw new UsageError(`--${name} must be a positive integer, received: ${raw}`);
  }
  return value;
}

/** Validates the calendar shape (rejects 2026-02-31) and returns the date string. */
function parseCalendarDate(raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new UsageError(`--date must be YYYY-MM-DD, received: ${raw}`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new UsageError(`--date is not a real calendar date: ${raw}`);
  }
  return raw;
}

function monthKey(date) {
  return date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);
}

/**
 * Rejects a date the flight table cannot hold, before any DDL is attempted.
 *
 * The partition set is created a bounded number of months ahead (migration 007); a flight
 * dated past the horizon would fail deep inside the insert with a vague "no partition of
 * relation found". Naming the horizon and the maintenance command turns that into an
 * operator instruction instead of a puzzle.
 */
function validateDepartureDate(dateStr) {
  const departureTime = new Date(`${dateStr}T10:00:00.000Z`);
  const now = Date.now();
  if (departureTime.getTime() <= now) {
    throw new UsageError(`--date ${dateStr} is in the past; a departed flight cannot be booked`);
  }

  const horizon = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + env.PARTITION_MONTHS_AHEAD, 1)
  );
  if (monthKey(departureTime) > monthKey(horizon)) {
    throw new UsageError(
      `--date ${dateStr} is beyond the partition horizon (${env.PARTITION_MONTHS_AHEAD} months ahead); ` +
        'run `npm run partitions:maintain` first'
    );
  }
  return dateStr;
}

function validateOptions(opts) {
  if (opts.help) return opts;

  opts.concurrency = parsePositiveInt(opts.concurrency, 'concurrency');
  opts.capacity = parsePositiveInt(opts.capacity, 'capacity');

  if (opts.concurrency > 1000) {
    throw new UsageError('--concurrency above 1000 is not what this tool is for; split the load instead');
  }

  if (opts.flight !== null) {
    if (!isValidUuid(opts.flight)) {
      throw new UsageError(`--flight must be a UUID, received: ${opts.flight}`);
    }
    opts.flight = String(opts.flight).toLowerCase();
    if (opts.provided.has('capacity')) {
      console.error(
        `warning: --capacity is ignored with --flight; capacity is read from the existing flight ` +
          `(${opts.capacity} given)`
      );
    }
  }

  if (opts.date !== null) {
    opts.date = validateDepartureDate(parseCalendarDate(opts.date));
  }

  return opts;
}

function defaultDepartureDate() {
  // Comfortably inside the 6-month partition horizon and unambiguously in the future, so a
  // run cannot fail because "today" happened to already be past the departure time.
  const target = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return target.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Concurrency primitives
// ---------------------------------------------------------------------------

/** A one-shot gate every attempt waits on; releases when the last attempt arrives. */
function makeBarrier(size) {
  if (size <= 0) return () => Promise.resolve();

  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  return () => {
    arrived += 1;
    if (arrived >= size) release();
    return gate;
  };
}

function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return null;
  if (sortedAscending.length === 1) return sortedAscending[0];

  // Linear interpolation between the two nearest ranks — the standard definition, and it
  // keeps p99 meaningful even when the sample is smaller than 100.
  const rank = (p / 100) * (sortedAscending.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAscending[lower];
  const weight = rank - lower;
  return sortedAscending[lower] * (1 - weight) + sortedAscending[upper] * weight;
}

function summariseLatencies(samplesMs) {
  if (samplesMs.length === 0) {
    return { count: 0, min: null, median: null, p95: null, p99: null, max: null };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const round = (value) => Math.round(value * 10) / 10;
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1])
  };
}

// ---------------------------------------------------------------------------
// Fixture: the flight and cabin under test
// ---------------------------------------------------------------------------

function pickCabin(cabins) {
  const wanted = String(env.DEFAULT_CABIN || 'ECONOMY').toUpperCase();
  return cabins.find((entry) => entry.cabin === wanted) || cabins[0] || null;
}

async function readCabin(flightId, departureDate, cabin) {
  const counter = await inventoryRepository.getCabin(pool.writePool, { flightId, departureDate, cabin });
  if (!counter) {
    throw new Error(`No inventory counter exists for cabin ${cabin} on flight ${flightId} (${departureDate})`);
  }
  return counter;
}

/**
 * Picks the cabin the run will hammer.
 *
 * The cabin must be one the counter knows about, so it is read from the flight's own
 * availability rather than assumed — a flight seeded without ECONOMY, or a `--flight` whose
 * DEFAULT_CABIN is absent, would otherwise fail at the first booking with a confusing
 * "unknown cabin" from deep in the saga.
 */
async function resolveFixture(opts) {
  if (opts.flight) {
    const flight = await flightService.getFlight(
      opts.date ? { flightId: opts.flight, departureDate: opts.date } : { flightId: opts.flight }
    );
    const cabin = pickCabin(flight.cabins || []);
    if (!cabin) {
      throw new Error(`Flight ${opts.flight} has no cabins with inventory to book against`);
    }
    return {
      created: false,
      flightId: flight.flightId,
      departureDate: flight.departureDate,
      cabin: cabin.cabin,
      origin: flight.origin,
      destination: flight.destination,
      aircraftType: flight.aircraftType
    };
  }

  const departureDate = opts.date || validateDepartureDate(defaultDepartureDate());
  const cabin = String(env.DEFAULT_CABIN || 'ECONOMY').toUpperCase();
  const departureTime = `${departureDate}T10:00:00.000Z`;
  const arrivalTime = `${departureDate}T12:00:00.000Z`;

  // ATR72 is the smallest template the reference data ships, and passing `cabins` explicitly
  // gives the flight exactly the capacity the operator asked for instead of the whole cabin
  // footprint — the point is a small, exhaustible number, not a realistic aircraft.
  const created = await flightService.upsertFlight({
    flightNumber: `ST${String(Date.now() % 100000).padStart(5, '0')}`,
    airlineCode: 'AA',
    origin: 'ISB',
    destination: 'DXB',
    departureDate,
    departureTime,
    arrivalTime,
    aircraftType: 'ATR72',
    basePrice: 100,
    currency: 'USD',
    cabins: [{ cabin, seats: opts.capacity }]
  });

  return {
    created: true,
    flightId: created.flightId,
    departureDate: created.departureDate,
    cabin,
    origin: created.origin,
    destination: created.destination,
    aircraftType: created.aircraftType
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Fires one booking and reports it as data rather than throwing.
 *
 * A thrown error is an expected outcome here — most attempts on a hot cabin will be refused
 * — so converting it to a result is what lets every attempt be awaited together without one
 * rejection aborting the batch before the rest have finished.
 */
async function attemptBooking(attempt, fixture, barrier) {
  await barrier();
  const startedAt = performance.now();
  const request = {
    userId: attempt.userId,
    flightId: fixture.flightId,
    cabin: fixture.cabin,
    passengerName: `Stress ${attempt.index}`,
    idempotencyKey: attempt.idempotencyKey
  };

  try {
    const result = await bookingService.createBooking(request);
    return {
      index: attempt.index,
      ok: true,
      replayed: Boolean(result.replayed),
      statusCode: result.statusCode,
      bookingId: result.booking ? result.booking.bookingId : null,
      durationMs: performance.now() - startedAt,
      request
    };
  } catch (err) {
    return {
      index: attempt.index,
      ok: false,
      code: err.code || err.name || 'UNKNOWN',
      message: err.message,
      statusCode: err.statusCode || null,
      durationMs: performance.now() - startedAt,
      request
    };
  }
}

function emptyHistogram() {
  return {};
}

async function runAttempts(opts, fixture, plan) {
  const inventoryBefore = await readCabin(fixture.flightId, fixture.departureDate, fixture.cabin);
  const capacity = inventoryBefore.availableSeats;
  const expectedSuccess = Math.min(opts.concurrency, capacity);

  // A nonzero payment-failure rate injects declines into the saga, which compensate the seat
  // they held. That makes "every attempt that got a seat kept it" false by design, so the
  // exact-count check becomes a SKIP rather than a lie — the safety invariants still apply.
  const strictCount = env.PAYMENT_FAILURE_RATE === 0;

  const runTag = randomToken(4);
  const attempts = Array.from({ length: opts.concurrency }, (_, index) => ({
    index,
    userId: newUuid(),
    idempotencyKey: `stress-${runTag}-${index}`
  }));
  for (const attempt of attempts) {
    plan.userIds.push(attempt.userId);
    plan.idempotencyKeys.push(attempt.idempotencyKey);
  }

  const barrier = makeBarrier(attempts.length);
  const startedAt = Date.now();
  const settled = await Promise.all(attempts.map((attempt) => attemptBooking(attempt, fixture, barrier)));
  const elapsedMs = Date.now() - startedAt;

  const successes = settled.filter((entry) => entry.ok);
  const failures = settled.filter((entry) => !entry.ok);
  const histogram = emptyHistogram();
  for (const failure of failures) {
    histogram[failure.code] = (histogram[failure.code] || 0) + 1;
  }

  for (const success of successes) {
    if (success.bookingId) plan.bookingIds.push(success.bookingId);
  }

  const inventoryAfter = await readCabin(fixture.flightId, fixture.departureDate, fixture.cabin);
  const audit = await auditFlight(fixture.flightId, fixture.departureDate, fixture.cabin);

  return {
    runTag,
    attempts: attempts.length,
    settled,
    successes,
    failures,
    histogram,
    latencies: summariseLatencies(settled.map((entry) => entry.durationMs)),
    elapsedMs,
    capacity,
    expectedSuccess,
    strictCount,
    inventoryBefore,
    inventoryAfter,
    audit
  };
}

/**
 * Re-issues the keys that WON, and only those.
 *
 * An idempotency replay is meaningful only for a key that reached a durable outcome: a key
 * that lost the counter race had its claim released (nothing durable happened, so the
 * client's retry must be free to actually retry), and re-issuing it is a fresh attempt, not a
 * replay. Replaying the winners is therefore the exact test of "a retry never double-sells":
 * each must come back as the same booking, and the counter must not move.
 */
async function runReplay(fixture, run) {
  const winners = run.successes;
  if (winners.length === 0) {
    return { attempted: 0, results: [], notes: 'no successful booking to replay' };
  }

  const inventoryBefore = await readCabin(fixture.flightId, fixture.departureDate, fixture.cabin);
  const barrier = makeBarrier(winners.length);

  const results = await Promise.all(
    winners.map(async (winner) => {
      await barrier();
      const startedAt = performance.now();
      try {
        const result = await bookingService.createBooking(winner.request);
        return {
          index: winner.index,
          ok: true,
          replayed: Boolean(result.replayed),
          sameBooking: Boolean(result.booking) && result.booking.bookingId === winner.bookingId,
          durationMs: performance.now() - startedAt
        };
      } catch (err) {
        return {
          index: winner.index,
          ok: false,
          code: err.code || err.name || 'UNKNOWN',
          message: err.message,
          durationMs: performance.now() - startedAt
        };
      }
    })
  );

  const inventoryAfter = await readCabin(fixture.flightId, fixture.departureDate, fixture.cabin);
  const audit = await auditFlight(fixture.flightId, fixture.departureDate, fixture.cabin);

  return {
    attempted: winners.length,
    results,
    replayLatency: summariseLatencies(results.map((entry) => entry.durationMs)),
    inventoryBefore,
    inventoryAfter,
    audit
  };
}

const AUDIT_LIMIT = 50;

/**
 * The oversell audit, scoped to the flight under test.
 *
 * This used to run the audit unscoped and then filter its result in JS. That is unsound:
 * `audit` returns `violations.slice(0, limit)` ordered by departure_date ascending while
 * `violationCount` is the true total, so a cluster-wide backlog of >= limit violations on
 * earlier-dated flights filled the returned slice and pushed this flight's own row out of
 * it. The JS filter then saw an empty list, the headline check PASSed, and the script
 * exited 0 with a genuine oversell on the flight under test. Scoping the audit to
 * (flight, date, cabin) moves the predicate into the audit's inventory WHERE — the driving
 * side of the join — so `violationCount` becomes this flight's count and no cap can hide
 * it.
 *
 * `globalViolationCount` is kept for the informational note: violations on other flights
 * are worth surfacing to the operator, but they are never part of this run's verdict.
 *
 * Belt-and-braces: if the scoped result ever reports more violations than it returned
 * (`violationCount > violations.length`, possible only if a future limit is smaller than a
 * flight's own findings), the per-flight view is still truncated, and the checks treat
 * that as a FAIL rather than trusting the empty-looking slice.
 */
async function auditFlight(flightId, departureDate, cabin) {
  const [scoped, global] = await Promise.all([
    inventoryRepository.audit(pool.writePool, { flightId, departureDate, cabin, limit: AUDIT_LIMIT }),
    // Count-only: none of this call's rows are rendered, only its `violationCount`, so the
    // limit is 0 and the returned list is deliberately empty.
    inventoryRepository.audit(pool.writePool, { limit: 0 })
  ]);

  return {
    checkedRows: scoped.checkedRows,
    forFlight: scoped.violations,
    forFlightViolationCount: scoped.violationCount,
    truncated: scoped.violationCount > scoped.violations.length,
    globalViolationCount: global.violationCount
  };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function check(name, status, detail) {
  return { name, status, detail };
}

function evaluateChecks(opts, run, replay) {
  const checks = [];
  const successCount = run.successes.length;
  const after = run.inventoryAfter;

  if (run.strictCount) {
    checks.push(
      check(
        'successes == min(attempts, capacity)',
        successCount === run.expectedSuccess ? 'PASS' : 'FAIL',
        `${successCount} == min(${run.attempts}, ${run.capacity}) = ${run.expectedSuccess}`
      )
    );
  } else {
    checks.push(
      check(
        'successes == min(attempts, capacity)',
        'SKIP',
        `PAYMENT_FAILURE_RATE=${env.PAYMENT_FAILURE_RATE} injects declines; safety checks still enforced`
      )
    );
  }

  const allowedFailureCodes = new Set([ERROR_CODES.SOLD_OUT]);
  if (!run.strictCount) allowedFailureCodes.add(ERROR_CODES.PAYMENT_FAILED);
  const unexpectedCodes = Object.keys(run.histogram).filter((code) => !allowedFailureCodes.has(code));
  checks.push(
    check(
      'every refused attempt was a sold-out conflict',
      unexpectedCodes.length === 0 ? 'PASS' : 'FAIL',
      unexpectedCodes.length === 0
        ? `${run.failures.length} refused, all ${ERROR_CODES.SOLD_OUT}`
        : `unexpected error codes: ${unexpectedCodes.join(', ')}`
    )
  );

  const nonNegative =
    after.availableSeats >= 0 &&
    after.heldSeats >= 0 &&
    after.availableSeats + after.heldSeats <= after.totalSeats;
  checks.push(
    check(
      'inventory counter never went negative or over capacity',
      nonNegative ? 'PASS' : 'FAIL',
      `available ${after.availableSeats}, held ${after.heldSeats}, total ${after.totalSeats}`
    )
  );

  const seatsAccounted = after.availableSeats === run.capacity - successCount;
  checks.push(
    check(
      'seats consumed equals successful bookings',
      seatsAccounted ? 'PASS' : 'FAIL',
      `capacity ${run.capacity} - wins ${successCount} = expected ${run.capacity - successCount}, available ${after.availableSeats}`
    )
  );

  const flightViolations = run.audit.forFlight;
  const auditClean = flightViolations.length === 0 && !run.audit.truncated;
  const auditDetail = run.audit.truncated
    ? `${run.audit.forFlightViolationCount} violation(s) reported, only ${flightViolations.length} returned (audit truncated)`
    : flightViolations.length === 0
      ? `no violations (${run.audit.checkedRows} counter row(s) audited for this flight)`
      : `${flightViolations.length} violation(s): ${flightViolations
          .map((row) => row.violation)
          .join(', ')}`;
  checks.push(check('oversell audit clean for this flight', auditClean ? 'PASS' : 'FAIL', auditDetail));

  if (opts.replay && replay) {
    const errored = replay.results.filter((entry) => !entry.ok);
    const notReplayed = replay.results.filter((entry) => entry.ok && !entry.replayed);
    const sameBooking = replay.results.filter((entry) => entry.ok && entry.replayed && entry.sameBooking);

    if (replay.attempted === 0) {
      checks.push(check('idempotent replay returned the original booking', 'SKIP', replay.notes));
    } else {
      checks.push(
        check(
          'idempotent replay returned the original booking',
          errored.length === 0 && notReplayed.length === 0 && sameBooking.length === replay.attempted
            ? 'PASS'
            : 'FAIL',
          `${sameBooking.length}/${replay.attempted} replayed to the same booking` +
            (errored.length ? `, ${errored.length} errored` : '') +
            (notReplayed.length ? `, ${notReplayed.length} created a new booking` : '')
        )
      );

      const unchanged =
        replay.inventoryBefore.availableSeats === replay.inventoryAfter.availableSeats &&
        replay.inventoryBefore.heldSeats === replay.inventoryAfter.heldSeats &&
        replay.inventoryBefore.confirmedSeats === replay.inventoryAfter.confirmedSeats;
      checks.push(
        check(
          'replay consumed no additional seats',
          unchanged ? 'PASS' : 'FAIL',
          `available ${replay.inventoryBefore.availableSeats} -> ${replay.inventoryAfter.availableSeats}, ` +
            `held ${replay.inventoryBefore.heldSeats} -> ${replay.inventoryAfter.heldSeats}`
        )
      );

      const replayViolations = replay.audit.forFlight;
      const replayAuditClean = replayViolations.length === 0 && !replay.audit.truncated;
      checks.push(
        check(
          'oversell audit still clean after replay',
          replayAuditClean ? 'PASS' : 'FAIL',
          replay.audit.truncated
            ? `${replay.audit.forFlightViolationCount} violation(s) reported, only ${replayViolations.length} returned (audit truncated)`
            : `${replayViolations.length} violation(s)`
        )
      );
    }
  }

  const exitCode = checks.some((entry) => entry.status === 'FAIL') ? 1 : 0;
  return { checks, exitCode };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Puts the database back the way the run found it: the write model exactly, and the derived
 * projection rows as far as an at-least-once consumer allows (see the ordering note below).
 *
 * Two different jobs, because "what this run created" differs:
 *
 *  - A flight this run created is its private sandbox, so the whole flight and everything
 *    written against it is deleted. All five write-model tables are co-located by
 *    `flight_id`, so this is one single-shard transaction — the same property the booking
 *    path relies on.
 *  - A `--flight` the operator pointed at is NOT ours to drop. Its bookings are cancelled
 *    through the service instead, which returns the seats and leaves the counter and the
 *    audit consistent; the cancelled rows are left as an honest record that the test ran.
 *
 * "Everything written against it" means the derived rows too, not only the write model.
 * `upsertFlight` emits a FLIGHT_UPSERTED event and each booking emits INVENTORY_CHANGED /
 * BOOKING_* events, and any API node with WORKERS_ENABLED=true runs the outbox consumer
 * that projects those into `flight_availability` (the read database) and `user_bookings`
 * (the write cluster). Clearing only the write-model rows would leave a permanent phantom
 * flight in search, so the created-flight branch clears both projection rows as well.
 *
 * The order is what makes the claim hold as far as it can. The outbox rows are deleted
 * inside the write-model transaction, so no consumer pass can newly claim this flight's
 * events after it commits; the derived rows are removed only once that has happened. This
 * is not a distributed lock, though: the consumer is at-least-once, so a pass that has
 * *already* claimed an event can still project it after these deletes and leave a single
 * derived row behind. The restoration below is therefore exact for every consumer pass
 * that has not already taken the events; the rows this run authored are gone either way.
 *
 * Never throws: a cleanup failure must not mask the verdict, and the caller still has the
 * report. Whatever fails is reported alongside what succeeded.
 */
async function safeCleanup(plan) {
  const summary = { performed: true, created: plan.created, deletedTracking: false, cancelledBookings: 0, errors: [] };

  try {
    if (plan.created) {
      await pool.withTransaction(async (client) => {
        await client.query('DELETE FROM bookings WHERE flight_id = $1 AND departure_date = $2', [
          plan.flightId,
          plan.departureDate
        ]);
        await client.query('DELETE FROM payments WHERE flight_id = $1 AND departure_date = $2', [
          plan.flightId,
          plan.departureDate
        ]);
        // The outbox rows go inside the write-model transaction so that, once it commits,
        // no consumer pass can newly claim this flight's events and re-project it.
        await client.query('DELETE FROM booking_outbox WHERE flight_id = $1 AND departure_date = $2', [
          plan.flightId,
          plan.departureDate
        ]);
        await client.query('DELETE FROM flight_inventory WHERE flight_id = $1 AND departure_date = $2', [
          plan.flightId,
          plan.departureDate
        ]);
        await client.query('DELETE FROM flights WHERE flight_id = $1 AND departure_date = $2', [
          plan.flightId,
          plan.departureDate
        ]);
      });

      // The derived rows are removed only after the events that feed them are gone. This
      // deletes the read-model projection of the fixture flight — without it, a run leaves
      // a phantom flight in search for as long as the read partitions live. The read model
      // is a separate database and may legitimately be down while a developer works on the
      // write path, so a failure here is reported but must not abort a cleanup that already
      // succeeded, hence its own catch rather than the one wrapping this branch.
      try {
        await pool.readQuery('DELETE FROM flight_availability WHERE flight_id = $1 AND departure_date = $2', [
          plan.flightId,
          plan.departureDate
        ]);
      } catch (err) {
        summary.errors.push(`read model flight_availability: ${err.message}`);
      }

      // user_bookings is distributed by user_id, not flight_id, so it cannot join the
      // co-located transaction above; it is deleted by its own statement, after the outbox
      // rows so a consumer that has not already claimed them cannot re-insert it.
      await pool.writePool.query('DELETE FROM user_bookings WHERE flight_id = $1 AND departure_date = $2', [
        plan.flightId,
        plan.departureDate
      ]);
      summary.deletedTracking = true;
    } else {
      for (const bookingId of plan.bookingIds) {
        try {
          await bookingService.cancelBooking({
            bookingId,
            isAdmin: true,
            reason: 'STRESS_TEST_CLEANUP'
          });
          summary.cancelledBookings += 1;
        } catch (err) {
          summary.errors.push(`cancel ${bookingId}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    summary.errors.push(err.message);
  }

  // Idempotency records are the one thing a rerun would otherwise inherit; clearing them
  // lets the same keys be reused and keeps the in-process (or Redis) cache tidy.
  const scope = bookingService.IDEMPOTENCY_SCOPE;
  for (const key of plan.idempotencyKeys) {
    try {
      await cache.del(cache.KEYS.IDEMPOTENCY(scope, key));
      await cache.del(`${cache.KEYS.IDEMPOTENCY(scope, key)}:record`);
    } catch (err) {
      summary.errors.push(`idempotency key ${key}: ${err.message}`);
    }
  }

  summary.message = plan.created
    ? `deleted test flight ${plan.flightId} and its bookings`
    : `cancelled ${summary.cancelledBookings} test booking(s) against flight ${plan.flightId}`;
  return summary;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmt(value) {
  return value === null || value === undefined ? '-' : Number(value).toFixed(1);
}

function buildReport(opts, fixture, run, replay, timings, evaluation, cleanup) {
  return {
    ok: evaluation.exitCode === 0,
    verdict: evaluation.exitCode === 0 ? 'PASS' : 'FAIL',
    flight: {
      flightId: fixture.flightId,
      created: fixture.created,
      origin: fixture.origin,
      destination: fixture.destination,
      departureDate: fixture.departureDate,
      aircraftType: fixture.aircraftType,
      cabin: fixture.cabin
    },
    config: {
      concurrency: opts.concurrency,
      requestedCapacity: opts.capacity,
      capacity: run.capacity,
      poolMax: env.PG_POOL_MAX,
      inventoryStrategy: env.INVENTORY_STRATEGY,
      sagaInline: env.BOOKING_SAGA_INLINE,
      paymentFailureRate: env.PAYMENT_FAILURE_RATE,
      replay: opts.replay,
      keep: opts.keep,
      nodeId: env.NODE_ID
    },
    results: {
      attempts: run.attempts,
      successes: run.successes.length,
      refusals: run.failures.length,
      errorHistogram: run.histogram,
      latencyMs: run.latencies,
      elapsedMs: run.elapsedMs
    },
    inventory: {
      before: run.inventoryBefore,
      after: run.inventoryAfter
    },
    audit: run.audit,
    checks: evaluation.checks,
    replay: replay || null,
    cleanup,
    durationMs: timings.totalMs
  };
}

function renderText(report) {
  const lines = [];
  const { config, results, flight, inventory } = report;

  lines.push('');
  lines.push('Anti-oversell concurrency stress test');
  lines.push('=====================================');
  lines.push('');
  lines.push('Target');
  lines.push(`  flight        ${flight.flightId} (${flight.created ? 'created by this run' : 'pre-existing'})`);
  lines.push(`  route         ${flight.origin} -> ${flight.destination} on ${flight.departureDate} (${flight.aircraftType})`);
  lines.push(`  cabin         ${flight.cabin}`);
  lines.push(
    `  capacity      ${inventory.before.availableSeats} available of ${inventory.before.totalSeats} total at start`
  );
  lines.push(`  strategy      ${config.inventoryStrategy}`);
  lines.push(
    `  saga          ${config.sagaInline ? 'inline (201 CONFIRMED)' : 'async (202 PENDING; reconciler drives it)'}`
  );
  lines.push('');
  lines.push('Load');
  lines.push(`  concurrency   ${config.concurrency}`);
  lines.push(`  write pool    max ${config.poolMax} connection(s)`);
  if (config.concurrency > config.poolMax) {
    lines.push(
      `  NOTE          concurrency exceeds the pool max by ${config.concurrency - config.poolMax}; those attempts`
    );
    lines.push('                queue for a connection. The invariant is unaffected; latency includes queueing.');
  }
  lines.push('');
  lines.push('Outcome');
  lines.push(`  attempts      ${results.attempts}`);
  lines.push(`  booked        ${results.successes}`);
  lines.push(`  refused       ${results.refusals}`);
  lines.push(
    `  latency (ms)  min ${fmt(results.latencyMs.min)}  median ${fmt(results.latencyMs.median)}  ` +
      `p95 ${fmt(results.latencyMs.p95)}  p99 ${fmt(results.latencyMs.p99)}  max ${fmt(results.latencyMs.max)}`
  );
  lines.push('');
  lines.push('Error histogram');
  const codes = Object.keys(results.errorHistogram).sort();
  if (codes.length === 0) {
    lines.push('  (no refusals)');
  } else {
    for (const code of codes) {
      lines.push(`  ${code.padEnd(28)} ${results.errorHistogram[code]}`);
    }
  }
  lines.push('');
  lines.push('Inventory after');
  lines.push(
    `  available ${inventory.after.availableSeats}  held ${inventory.after.heldSeats}  ` +
      `confirmed ${inventory.after.confirmedSeats}  total ${inventory.after.totalSeats}`
  );
  lines.push('');
  lines.push('Checks');
  for (const entry of report.checks) {
    lines.push(`  [${entry.status.padEnd(4)}] ${entry.name}  (${entry.detail})`);
  }

  if (report.replay && report.replay.attempted > 0) {
    const replayed = report.replay.results.filter((entry) => entry.ok && entry.replayed).length;
    const fresh = report.replay.results.filter((entry) => entry.ok && !entry.replayed).length;
    const errored = report.replay.results.filter((entry) => !entry.ok).length;
    lines.push('');
    lines.push('Replay (--replay)');
    lines.push(`  keys reissued ${report.replay.attempted}`);
    lines.push(`  replayed       ${replayed}`);
    lines.push(`  new bookings   ${fresh}`);
    lines.push(`  errors         ${errored}`);
  }

  lines.push('');
  lines.push(`Verdict:  ${report.verdict}`);
  lines.push(`Elapsed:  ${report.durationMs} ms`);
  lines.push(`Cleanup:  ${report.cleanup.message}`);
  if (report.cleanup.errors.length > 0) {
    lines.push(`  cleanup warnings: ${report.cleanup.errors.join('; ')}`);
  }
  if (report.audit.globalViolationCount > report.audit.forFlight.length) {
    lines.push(
      `  note: ${report.audit.globalViolationCount} cluster-wide audit violation(s); ` +
        `only this flight's ${report.audit.forFlight.length} affect the verdict`
    );
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function execute(opts) {
  const startedAt = Date.now();
  const fixture = await resolveFixture(opts);
  const plan = {
    created: fixture.created,
    flightId: fixture.flightId,
    departureDate: fixture.departureDate,
    bookingIds: [],
    userIds: [],
    idempotencyKeys: []
  };

  let cleaned = false;
  const runCleanup = async () => {
    if (cleaned) return { performed: false, message: 'already cleaned up', errors: [] };
    cleaned = true;
    if (opts.keep) {
      return {
        performed: false,
        message: `skipped (--keep); flight ${fixture.flightId} left in place`,
        errors: []
      };
    }
    return safeCleanup(plan);
  };

  try {
    const run = await runAttempts(opts, fixture, plan);
    const replay = opts.replay ? await runReplay(fixture, run) : null;
    const evaluation = evaluateChecks(opts, run, replay);
    const cleanup = await runCleanup();
    const report = buildReport(
      opts,
      fixture,
      run,
      replay,
      { totalMs: Date.now() - startedAt },
      evaluation,
      cleanup
    );

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderText(report));
    }
    return evaluation.exitCode;
  } catch (err) {
    // The run itself failed (bad flight, unreachable database). Clean up what was created so
    // a failed run does not leave a stray test flight behind, then surface the error.
    await runCleanup().catch(() => {});
    throw err;
  }
}

async function main(argv) {
  const opts = validateOptions(parseArgs(argv));

  if (opts.help) {
    console.log(USAGE.trim());
    return 0;
  }

  if (opts.concurrency > env.PG_POOL_MAX) {
    console.error(
      `warning: --concurrency ${opts.concurrency} exceeds the write pool max ${env.PG_POOL_MAX}; ` +
        'attempts will queue for connections (correctness unaffected, latency distorted)'
    );
  }

  return execute(opts);
}

(async () => {
  let exitCode = 0;
  try {
    exitCode = await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`\nerror: ${err.message}`);
      console.error('\nRun with --help for usage.');
      exitCode = 2;
    } else {
      console.error(`\nStress test failed: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
      exitCode = 1;
    }
  } finally {
    // Close on every path, including usage errors, so an operator is never left with a hang.
    // Modules this script pulls in (metrics, the cache sweeper) can hold timers of their own,
    // so an explicit exit after the pools are closed is what actually guarantees the process
    // ends; process.exitCode alone would let a stray handle keep it alive.
    await pool.close().catch(() => {});
    await cache.close().catch(() => {});
  }
  process.exit(exitCode);
})();
