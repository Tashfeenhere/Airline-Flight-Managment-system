/**
 * Saga reconciler.
 *
 * The booking saga is normally driven inline, inside the request that created the
 * booking. That is the fast path and it is what most requests take. This worker exists
 * for every case where the inline path did not finish, and there are three of them:
 *
 *   1. `BOOKING_SAGA_INLINE=false` — the API returns 202 Accepted with the seats held
 *      and the payment still to be taken. This worker is then the *only* thing that
 *      completes bookings, so running it is not optional in that configuration.
 *   2. The process died mid-saga. The transaction that reserved the seats committed, so
 *      the booking and its payment row exist and say exactly which step was reached;
 *      nobody is left to continue from there.
 *   3. A gateway call timed out after the provider had already acted. The payment row
 *      is stuck in AUTHORIZING or CAPTURING with no process driving it.
 *
 * All three are the same operation — call `advanceSaga`, which re-reads the persisted
 * state and continues from wherever it is. Nothing here re-implements the saga; if it
 * did, the two implementations would drift and the recovery path would be the one that
 * was wrong.
 *
 * The division of labour with the hold reaper is exact and worth stating: this worker
 * finishes bookings whose hold is still alive, the reaper returns seats whose hold has
 * expired. A booking is never both, because the hold's deadline decides — and where
 * they could still collide (a payment captured in the instant a hold expires) the
 * conditional claims decide the winner, not the scheduling.
 */
const env = require('../config/env');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const metrics = require('../observability/metrics');
const { BOOKING_STATUS, LOG_RESULTS } = require('../config/constants');

const bookingRepository = require('../repositories/bookingRepository');
const paymentRepository = require('../repositories/paymentRepository');
const bookingService = require('../services/bookingService');

/** Bookings created before this are considered abandoned by their original request. */
function staleCutoff(staleSeconds = env.SAGA_STALE_SECONDS) {
  return new Date(Date.now() - staleSeconds * 1000);
}

/**
 * Advances one booking, translating the saga's error vocabulary into a count.
 *
 * A declined payment is *not* a failure here: `advanceSaga` compensates internally and
 * the booking ends CANCELLED, which is a completed piece of work. Counting it as an
 * error would make a healthy run look broken and hide the failures that matter.
 */
async function advanceOne(booking) {
  try {
    const result = await bookingService.advanceSaga({
      flightId: booking.flightId,
      departureDate: booking.departureDate,
      bookingId: booking.bookingId
    });

    const state = result.saga ? result.saga.state : null;
    metrics.recordSagaStep(state || 'UNKNOWN', LOG_RESULTS.SUCCESS);
    logger.info('Saga reconciled', {
      bookingId: booking.bookingId,
      flightId: booking.flightId,
      sagaState: state,
      bookingStatus: result.booking ? result.booking.status : null
    });
    return { bookingId: booking.bookingId, outcome: 'ADVANCED', sagaState: state };
  } catch (err) {
    // A declined payment already compensated the booking; that is a success, not a
    // failure, and the durableOutcome flag is how the saga tells us so.
    if (err.durableOutcome) {
      metrics.recordSagaStep('COMPENSATED', LOG_RESULTS.COMPENSATED);
      logger.info('Saga reconciled (compensated)', {
        bookingId: booking.bookingId,
        code: err.code,
        message: err.message
      });
      return { bookingId: booking.bookingId, outcome: 'COMPENSATED', code: err.code };
    }

    logger.error('Saga reconciler failed to advance a booking', {
      bookingId: booking.bookingId,
      flightId: booking.flightId,
      code: err.code,
      error: err.message
    });
    return { bookingId: booking.bookingId, outcome: 'FAILED', code: err.code, error: err.message };
  }
}

/** One pass over both sources of unfinished work. */
async function runOnce({ limit = env.SAGA_BATCH_SIZE, staleSeconds = env.SAGA_STALE_SECONDS } = {}) {
  const stale = await bookingRepository.findStalePending(pool.writePool, {
    olderThan: staleCutoff(staleSeconds),
    limit
  });

  const advanced = [];
  for (const booking of stale) {
    advanced.push(await advanceOne(booking));
  }

  // Payments left mid-flight by a dead process. Their bookings are PENDING, so the pass
  // above would usually have picked them up first — this catches the case where the
  // booking was already terminal and only the payment row is lying about its state.
  const stuck = await paymentRepository.listStuck(pool.writePool, {
    olderThan: staleCutoff(staleSeconds * 2),
    limit
  });

  const repaired = [];
  for (const payment of stuck) {
    const booking = await bookingRepository.findById(pool.writePool, {
      flightId: payment.flightId,
      departureDate: payment.departureDate,
      bookingId: payment.bookingId
    });
    if (!booking || booking.status !== BOOKING_STATUS.PENDING) {
      // The booking is NOT PENDING, so nothing will ever move this payment row. If its
      // saga state is COMPENSATING the money is owed back; otherwise it is a stale
      // marker on a settled booking, and the honest move is to record it as failed so
      // the reconciliation report stops flagging it forever.
      if (payment.sagaState === 'COMPENSATING') {
        repaired.push(
          await advanceOne({
            flightId: payment.flightId,
            departureDate: payment.departureDate,
            bookingId: payment.bookingId
          })
        );
      } else {
        await paymentRepository.markFailed(pool.writePool, {
          flightId: payment.flightId,
          departureDate: payment.departureDate,
          paymentId: payment.paymentId,
          failureReason: 'SAGA_STATE_STALE'
        });
        repaired.push({ bookingId: payment.bookingId, outcome: 'PAYMENT_MARKED_STALE' });
      }
      continue;
    }
    repaired.push(await advanceOne(booking));
  }

  return {
    scanned: stale.length + stuck.length,
    advanced: advanced.filter((entry) => entry.outcome === 'ADVANCED').length,
    compensated: advanced.concat(repaired).filter((entry) => entry.outcome === 'COMPENSATED').length,
    failed: advanced.concat(repaired).filter((entry) => entry.outcome === 'FAILED').length,
    results: advanced.concat(repaired)
  };
}

function start({ intervalMs = env.SAGA_INTERVAL_MS } = {}) {
  let stopped = false;
  let timer = null;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await runOnce();
      if (result.scanned > 0) logger.info('Saga reconciler pass complete', result);
    } catch (err) {
      logger.error('Saga reconciler pass failed', { error: err.message });
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        if (timer.unref) timer.unref();
      }
    }
  };

  timer = setTimeout(tick, intervalMs);
  if (timer.unref) timer.unref();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runOnce
  };
}

module.exports = { runOnce, advanceOne, start, staleCutoff };
