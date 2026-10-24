#!/usr/bin/env node
/**
 * `npm run saga:reconcile` — drives booking sagas left mid-flight to a terminal state.
 *
 * The saga is normally driven inline by the request that created the booking. This
 * script is the operator's version of the reconciler worker for the three cases where
 * nothing drove it to the end: BOOKING_SAGA_INLINE=false (the API returned 202), a
 * process that died between the reserve commit and the payment steps, or a provider
 * call that timed out after the provider had already acted. In all three the booking
 * and its payment row exist and say exactly which step was reached — the work is to
 * continue from there.
 *
 * Nothing here re-implements the saga. `sagaWorker.runOnce` re-reads each persisted
 * state and advances it with the same `advanceSaga` the request path uses; this file
 * only discovers candidates, prints what it found, and reports the outcome. That is
 * deliberate: a second implementation of the saga would drift from the first, and the
 * recovery path would be the one that was wrong.
 *
 * Safe to run alongside the workers. The saga's transitions are conditional claims, so
 * two reconcilers racing over the same booking means one of them updates zero rows and
 * learns it lost — not that a seat is sold twice.
 *
 * `--dry-run` is the probe form: it reports what is stuck (booking state, payment
 * saga_state, inventory counters) and exits 1 when anything is, without touching it.
 * That makes it usable from a cron or a CI check, where "something is stuck" should be
 * a failure signal rather than something to discover by reading the output.
 *
 * Usage:
 *   node scripts/reconcile-sagas.js                       # reconcile a batch
 *   node scripts/reconcile-sagas.js --dry-run             # report only, exit 1 if stuck
 *   node scripts/reconcile-sagas.js --booking <uuid>      # one saga
 *   node scripts/reconcile-sagas.js --watch --interval 5000
 *   node scripts/reconcile-sagas.js --json
 *
 * Exit codes: 0 success / 1 a booking could not be advanced, or (--dry-run) something
 * is stuck / 2 usage error.
 */
'use strict';

const pool = require('../src/db/pool');
const env = require('../src/config/env');
const sagaWorker = require('../src/workers/sagaWorker');
const bookingRepository = require('../src/repositories/bookingRepository');
const paymentRepository = require('../src/repositories/paymentRepository');
const inventoryRepository = require('../src/repositories/inventoryRepository');
const { BOOKING_STATUS, SAGA_STATE } = require('../src/config/constants');

const STUCK_PAYMENT_STATES = [SAGA_STATE.AUTHORIZING, SAGA_STATE.CAPTURING];

/** Raised for bad argv; the caller maps it to exit 2 rather than a stack trace. */
class UsageError extends Error {}

const USAGE = `Usage: node scripts/reconcile-sagas.js [options]

Drives booking sagas left unfinished by a crash, by BOOKING_SAGA_INLINE=false, or by a
payment provider call that timed out, using the same saga worker the background
reconciler runs. Concurrent with the workers by design — the saga's conditional claims
decide the winner.

Options:
  --stale-seconds <n>  Age in seconds before a PENDING booking is treated as abandoned
                       by its original request. Default: SAGA_STALE_SECONDS (${env.SAGA_STALE_SECONDS}).
  --limit <n>          Max bookings/payments to examine per pass. Default: SAGA_BATCH_SIZE (${env.SAGA_BATCH_SIZE}).
  --booking <uuid>     Reconcile this one booking instead of scanning for stale work.
  --dry-run            Report what is stuck without advancing it. Prints each booking's
                       persisted state, its payment saga_state and the inventory
                       counters. Exits 1 when anything is stuck.
  --watch              Keep running, one pass every --interval, until Ctrl+C.
  --interval <n>       Milliseconds between passes under --watch. Default: SAGA_INTERVAL_MS (${env.SAGA_INTERVAL_MS}).
  --json               Emit JSON (one report, or one JSON line per pass under --watch).
  --help, -h           Show this help.

Exit codes: 0 success / 1 a booking could not be advanced (or, with --dry-run, work is
stuck) / 2 usage error.
`;

function parseInteger(name, raw, minimum) {
  const trimmed = raw === undefined || raw === null ? '' : String(raw).trim();
  // Reject the near-misses parseInt would happily accept ("5px", "1e3", "+5") so a
  // typo in an operator flag is a clear usage error rather than a silently wrong value.
  if (!/^\d+$/.test(trimmed)) {
    throw new UsageError(`${name} must be a non-negative integer, received: ${raw}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < minimum) {
    throw new UsageError(`${name} must be >= ${minimum}, received: ${parsed}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    staleSeconds: env.SAGA_STALE_SECONDS,
    limit: env.SAGA_BATCH_SIZE,
    intervalMs: env.SAGA_INTERVAL_MS,
    booking: null,
    dryRun: false,
    watch: false,
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const take = () => {
      if (inline !== null) return inline;
      index += 1;
      return argv[index];
    };

    switch (name) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--watch':
        args.watch = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--stale-seconds':
        args.staleSeconds = parseInteger(name, take(), 0);
        break;
      case '--limit':
        args.limit = parseInteger(name, take(), 1);
        break;
      case '--interval':
        args.intervalMs = parseInteger(name, take(), 1);
        break;
      case '--booking': {
        const value = take();
        if (!value || String(value).startsWith('--')) {
          throw new UsageError('--booking requires a booking id');
        }
        args.booking = String(value);
        break;
      }
      default:
        throw new UsageError(`Unknown option: ${raw}`);
    }
  }

  return args;
}

/**
 * Loads everything an operator needs to judge one candidate: the booking as persisted,
 * its payment's saga_state (the saga's durable memory of how far it got) and the
 * inventory counters the next step will move. The booking is passed in when the
 * discovery query already returned it, so the common path costs one payment read and
 * one counter read rather than three queries.
 */
async function inspect(candidate) {
  const booking =
    candidate.booking ||
    (await bookingRepository.findById(pool.writePool, {
      flightId: candidate.flightId,
      departureDate: candidate.departureDate,
      bookingId: candidate.bookingId
    }));

  const payment = await paymentRepository.findByBooking(pool.writePool, {
    flightId: candidate.flightId,
    departureDate: candidate.departureDate,
    bookingId: candidate.bookingId
  });

  const cabin = candidate.cabin || (booking ? booking.cabin : null);
  const inventory = cabin
    ? await inventoryRepository.getCabin(pool.writePool, {
        flightId: candidate.flightId,
        departureDate: candidate.departureDate,
        cabin
      })
    : null;

  return {
    flightId: candidate.flightId,
    departureDate: candidate.departureDate,
    bookingId: candidate.bookingId,
    cabin,
    source: candidate.source,
    booking,
    payment,
    inventory
  };
}

/**
 * What the reconciler would do with this booking, without doing it.
 *
 * Mirrors `sagaWorker.runOnce`'s decision exactly, including the branch that matters
 * most: a payment stuck in AUTHORIZING/CAPTURING whose booking is already terminal is
 * not something the saga can drive — nothing will ever revisit that row, so it is a
 * stale marker to record as failed, not work to roll forward.
 */
function classify(booking, payment) {
  const status = booking ? booking.status : null;
  const sagaState = payment ? payment.sagaState : null;

  if (status === BOOKING_STATUS.PENDING) return { disposition: 'ADVANCE', stuck: true };
  if (sagaState === SAGA_STATE.COMPENSATING) return { disposition: 'COMPENSATE', stuck: true };
  if (STUCK_PAYMENT_STATES.includes(sagaState)) return { disposition: 'MARK_STALE', stuck: true };
  return { disposition: 'SETTLED', stuck: false };
}

/** Flattens an inspected candidate into the report shape the printer and JSON share. */
function toView(item) {
  const booking = item.booking || null;
  const payment = item.payment || null;
  const { disposition, stuck } = classify(booking, payment);

  return {
    bookingId: item.bookingId,
    flightId: item.flightId,
    departureDate: item.departureDate,
    cabin: item.cabin || (booking ? booking.cabin : null),
    source: item.source,
    bookingStatus: booking ? booking.status : null,
    createdAt: booking ? booking.createdAt : null,
    holdExpiresAt: booking ? booking.holdExpiresAt : null,
    // `null` means the booking has no hold at all (already settled), which is not the
    // same as "hold is unexpired" — collapsing them would mislead the operator.
    holdExpired: booking && booking.holdExpiresAt ? Date.parse(booking.holdExpiresAt) < Date.now() : null,
    paymentId: payment ? payment.paymentId : null,
    paymentStatus: payment ? payment.status : null,
    sagaState: payment ? payment.sagaState : null,
    paymentFailureReason: payment ? payment.failureReason : null,
    inventory: item.inventory
      ? {
          totalSeats: item.inventory.totalSeats,
          availableSeats: item.inventory.availableSeats,
          heldSeats: item.inventory.heldSeats,
          confirmedSeats: item.inventory.confirmedSeats,
          version: item.inventory.version,
          shardCount: item.inventory.shardCount
        }
      : null,
    disposition,
    stuck,
    outcome: null,
    outcomeSagaState: null,
    outcomeCode: null,
    outcomeError: null
  };
}

/**
 * Merges what was found with what the worker reported, keyed by booking id.
 *
 * The two lists come from separate scans a moment apart, so they are not guaranteed to
 * be identical: a booking can settle between the discovery pass and the reconcile pass.
 * Taking the union and omitting nothing means the operator sees both, instead of a
 * booking silently vanishing from the report because it stopped being stuck.
 */
function assemble(args, { mode, explicitBookingId, discovered, inspected, results }) {
  const byId = new Map();
  for (const item of inspected) byId.set(item.bookingId, toView(item));

  for (const result of results) {
    const existing = byId.get(result.bookingId);
    if (existing) {
      existing.outcome = result.outcome;
      existing.outcomeSagaState = result.sagaState || null;
      existing.outcomeCode = result.code || null;
      existing.outcomeError = result.error || null;
      continue;
    }
    byId.set(result.bookingId, {
      bookingId: result.bookingId,
      flightId: null,
      departureDate: null,
      cabin: null,
      source: 'RUNTIME',
      bookingStatus: null,
      createdAt: null,
      holdExpiresAt: null,
      holdExpired: null,
      paymentId: null,
      paymentStatus: null,
      sagaState: null,
      paymentFailureReason: null,
      inventory: null,
      disposition: null,
      stuck: null,
      outcome: result.outcome,
      outcomeSagaState: result.sagaState || null,
      outcomeCode: result.code || null,
      outcomeError: result.error || null
    });
  }

  const bookings = [...byId.values()];
  const summary =
    mode === 'dry-run'
      ? {
          scanned: bookings.length,
          stuck: bookings.filter((entry) => entry.stuck).length,
          wouldAdvance: bookings.filter((entry) => entry.disposition === 'ADVANCE').length,
          wouldCompensate: bookings.filter((entry) => entry.disposition === 'COMPENSATE').length,
          wouldMarkStale: bookings.filter((entry) => entry.disposition === 'MARK_STALE').length,
          settled: bookings.filter((entry) => entry.disposition === 'SETTLED').length
        }
      : {
          scanned: bookings.length,
          advanced: bookings.filter((entry) => entry.outcome === 'ADVANCED').length,
          compensated: bookings.filter((entry) => entry.outcome === 'COMPENSATED').length,
          failed: bookings.filter((entry) => entry.outcome === 'FAILED').length,
          markedStale: bookings.filter((entry) => entry.outcome === 'PAYMENT_MARKED_STALE').length
        };

  return {
    mode,
    staleSeconds: args.staleSeconds,
    limit: args.limit,
    explicitBookingId,
    discovered,
    notFound: false,
    bookings,
    summary
  };
}

/** Single-booking mode: the caller named an id, so skip discovery entirely. */
async function runExplicit(args) {
  const found = await bookingRepository.findAnyById(pool.writePool, { bookingId: args.booking });
  if (!found) {
    return {
      mode: args.dryRun ? 'dry-run' : 'advance',
      staleSeconds: args.staleSeconds,
      limit: args.limit,
      explicitBookingId: args.booking,
      discovered: null,
      notFound: true,
      bookings: [],
      summary: { scanned: 0, advanced: 0, compensated: 0, failed: 0, markedStale: 0 }
    };
  }

  const item = await inspect({
    flightId: found.flightId,
    departureDate: found.departureDate,
    bookingId: found.bookingId,
    cabin: found.cabin,
    booking: found,
    source: 'EXPLICIT'
  });

  const results = [];
  if (!args.dryRun) {
    results.push(
      await sagaWorker.advanceOne({
        flightId: found.flightId,
        departureDate: found.departureDate,
        bookingId: found.bookingId
      })
    );
  }

  return assemble(args, {
    mode: args.dryRun ? 'dry-run' : 'advance',
    explicitBookingId: args.booking,
    discovered: null,
    inspected: [item],
    results
  });
}

/**
 * Batch mode. Discovery is done here (not left to `runOnce`) so the report can show the
 * state each booking was found in; the advancement itself is still `runOnce`, which is
 * the only place that knows how to treat a declined payment as a successful
 * compensation rather than a failure.
 */
async function runDiscovery(args) {
  const stale = await bookingRepository.findStalePending(pool.writePool, {
    olderThan: sagaWorker.staleCutoff(args.staleSeconds),
    limit: args.limit
  });

  // Payments are judged stale twice as slowly as bookings: a booking that is merely
  // old is expected, but a payment whose saga_state never moved for 2x the staleness
  // window is a process that is not coming back. This mirrors the worker exactly.
  const stuck = await paymentRepository.listStuck(pool.writePool, {
    olderThan: sagaWorker.staleCutoff(args.staleSeconds * 2),
    limit: args.limit
  });

  const candidates = [];
  const seen = new Set();
  for (const booking of stale) {
    if (seen.has(booking.bookingId)) continue;
    seen.add(booking.bookingId);
    candidates.push({
      flightId: booking.flightId,
      departureDate: booking.departureDate,
      bookingId: booking.bookingId,
      cabin: booking.cabin,
      booking,
      source: 'STALE_PENDING'
    });
  }
  for (const payment of stuck) {
    // A booking that is both stale and carries a stuck payment appears once, as its
    // booking, because advancing it moves both rows together.
    if (seen.has(payment.bookingId)) continue;
    seen.add(payment.bookingId);
    candidates.push({
      flightId: payment.flightId,
      departureDate: payment.departureDate,
      bookingId: payment.bookingId,
      cabin: null,
      booking: null,
      source: 'STUCK_PAYMENT'
    });
  }

  const inspected = [];
  for (const candidate of candidates) inspected.push(await inspect(candidate));

  let results = [];
  if (!args.dryRun) {
    const pass = await sagaWorker.runOnce({ limit: args.limit, staleSeconds: args.staleSeconds });
    results = pass.results || [];
  }

  return assemble(args, {
    mode: args.dryRun ? 'dry-run' : 'advance',
    explicitBookingId: null,
    discovered: { stalePending: stale.length, stuckPayments: stuck.length },
    inspected,
    results
  });
}

function runPass(args) {
  return args.booking ? runExplicit(args) : runDiscovery(args);
}

/** Exit 1 when the pass did not fully succeed, or (--dry-run) found work outstanding. */
function exitCodeFor(report, args) {
  if (report.notFound) return 1;
  if (args.dryRun) return report.bookings.some((entry) => entry.stuck) ? 1 : 0;
  return report.summary.failed > 0 ? 1 : 0;
}

function printBooking(booking, dryRun) {
  console.log('');
  console.log(`  ${booking.bookingId}  [${booking.source}]`);
  console.log(
    `    flight    ${booking.flightId || '-'} ${booking.departureDate || ''}${booking.cabin ? ` cabin=${booking.cabin}` : ''}`
  );
  if (booking.bookingStatus) {
    const hold =
      booking.holdExpired === null ? 'no-hold' : booking.holdExpired ? 'yes' : 'no';
    console.log(
      `    booking   status=${booking.bookingStatus} created=${booking.createdAt || '-'} holdExpires=${booking.holdExpiresAt || '-'} holdExpired=${hold}`
    );
  } else {
    console.log('    booking   NOT FOUND');
  }
  if (booking.sagaState || booking.paymentId) {
    console.log(
      `    payment   sagaState=${booking.sagaState || '-'} status=${booking.paymentStatus || '-'}` +
        `${booking.paymentFailureReason ? ` reason=${booking.paymentFailureReason}` : ''}`
    );
  } else {
    console.log('    payment   NOT FOUND');
  }
  if (booking.inventory) {
    console.log(
      `    inventory total=${booking.inventory.totalSeats} available=${booking.inventory.availableSeats} ` +
        `held=${booking.inventory.heldSeats} confirmed=${booking.inventory.confirmedSeats} ` +
        `version=${booking.inventory.version} shards=${booking.inventory.shardCount}`
    );
  } else {
    console.log('    inventory n/a');
  }

  if (dryRun) {
    console.log(`    -> ${booking.disposition}${booking.stuck ? ' (stuck)' : ''}`);
  } else if (booking.outcome) {
    console.log(
      `    -> ${booking.outcome}` +
        `${booking.outcomeSagaState ? ` sagaState=${booking.outcomeSagaState}` : ''}` +
        `${booking.outcomeCode ? ` code=${booking.outcomeCode}` : ''}` +
        `${booking.outcomeError ? ` error=${booking.outcomeError}` : ''}`
    );
  }
}

function printHuman(report, args, timestamp) {
  const prefix = timestamp ? `[${timestamp.toISOString()}] ` : '';
  console.log('');
  console.log(`${prefix}Saga reconciliation — ${report.mode}${args.booking ? ` (booking=${args.booking})` : ''}`);
  console.log(`  thresholds  stale-seconds=${report.staleSeconds} limit=${report.limit}`);
  if (report.discovered) {
    console.log(
      `  discovered  ${report.discovered.stalePending} stale PENDING booking(s), ` +
        `${report.discovered.stuckPayments} stuck payment(s)`
    );
  }

  if (report.notFound) {
    console.log(`  booking     ${report.explicitBookingId} not found`);
    return;
  }

  if (report.bookings.length === 0) {
    console.log('  nothing stuck — no bookings need reconciliation');
    return;
  }

  for (const booking of report.bookings) printBooking(booking, args.dryRun);

  const summary = Object.entries(report.summary)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.log('');
  console.log(`  summary     ${summary}`);
}

function emit(report, args, { compact = false, timestamp = null } = {}) {
  if (args.json) {
    const payload = timestamp ? { ts: timestamp.toISOString(), ...report } : report;
    console.log(JSON.stringify(payload, null, compact ? 0 : 2));
    return;
  }
  printHuman(report, args, timestamp);
}

/**
 * Loop one pass per interval until a signal arrives. Unlike a bare setInterval a pass
 * is never started while the previous one is still running, so a slow reconcile cannot
 * stack up; and the pending sleep is cleared on shutdown so the process actually exits
 * instead of waiting out an interval that no longer matters.
 */
async function watch(args) {
  let stopped = false;
  let exitCode = 0;
  let pendingTimer = null;
  let sleepResolve = null;

  const requestStop = () => {
    stopped = true;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (sleepResolve) {
      const resolve = sleepResolve;
      sleepResolve = null;
      resolve();
    }
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  if (!args.json) {
    console.log(
      `Watching sagas every ${args.intervalMs} ms (Ctrl+C to stop) — ` +
        `stale-seconds=${args.staleSeconds} limit=${args.limit}` +
        `${args.booking ? ` booking=${args.booking}` : ''}${args.dryRun ? ' (dry run)' : ''}`
    );
  }

  while (!stopped) {
    const startedAt = new Date();
    let report = null;
    try {
      report = await runPass(args);
    } catch (err) {
      exitCode = 1;
      if (args.json) {
        console.log(JSON.stringify({ ts: startedAt.toISOString(), error: err.message }));
      } else {
        console.error(`[${startedAt.toISOString()}] pass failed: ${err.message}`);
      }
    }

    if (report) {
      emit(report, args, { compact: args.json, timestamp: startedAt });
      const code = exitCodeFor(report, args);
      if (code !== 0) exitCode = code;
    }

    if (stopped) break;

    await new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      sleepResolve = resolve;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        sleepResolve = null;
        resolve();
      }, args.intervalMs);
    });
  }

  return exitCode;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`Error: ${err.message}`);
      process.stderr.write(`\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.watch) return watch(args);

  const report = await runPass(args);
  emit(report, args, { compact: false, timestamp: null });
  return exitCodeFor(report, args);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\nSaga reconciliation failed: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Every exit path above — usage error, help, an uncaught failure, a full pass —
    // lands here, so the pool is closed exactly once and an operator terminal is
    // never left holding a hung connection.
    await pool.close();
  });
