/**
 * Hold reaper.
 *
 * A hold is a promise with a deadline. Without this worker, a customer who abandons
 * checkout — or a process that dies between reserving and paying — leaves seats
 * unavailable forever, and a flight quietly sells fewer seats than it has. The reaper
 * is what makes `BOOKING_HOLD_TTL_SECONDS` a real bound rather than a comment.
 *
 * Two subtleties decide whether this worker is safe or dangerous:
 *
 * 1. IT READS WIDELY BUT WRITES NARROWLY. Finding expired holds is a scatter across
 *    shards; expiring one is a conditional single-shard claim followed by single-shard
 *    counter updates. A multi-shard `UPDATE` would put a two-phase commit here, in the
 *    one place in the system designed to have none.
 *
 * 2. IT NEVER TAKES SEATS FROM A CAPTURED PAYMENT. If the process died *after* the
 *    gateway captured the money but before the booking was confirmed, the seats belong
 *    to a customer who has paid. Releasing them would take a seat from someone holding
 *    a receipt. That case is detected and skipped, and the saga reconciler rolls the
 *    booking forward instead.
 */
const env = require('../config/env');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const metrics = require('../observability/metrics');
const { OUTBOX_EVENT_TYPES, BOOKING_STATUS, PAYMENT_STATUS, LOG_OPERATIONS, LOG_RESULTS } = require('../config/constants');

const bookingRepository = require('../repositories/bookingRepository');
const paymentRepository = require('../repositories/paymentRepository');
const outboxRepository = require('../repositories/outboxRepository');
const flightRepository = require('../repositories/flightRepository');
const inventoryService = require('../services/inventoryService');
const { flightSnapshot } = require('../services/bookingService');
const { toIsoString } = require('../repositories/mappers');

/** The oldest departure date worth scanning, as YYYY-MM-DD. */
function scanHorizon() {
  const from = new Date(Date.now() - env.REAPER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return from.toISOString().slice(0, 10);
}

/**
 * Expires one hold.
 *
 * The claim is `PENDING -> EXPIRED` guarded on `hold_expires_at < now()`, so a booking
 * that was confirmed a microsecond earlier wins and this updates zero rows — which is
 * the whole mechanism by which the reaper and a completing payment cannot both act on
 * the same seats. Only after winning that claim are the seats returned.
 */
async function expireHold(hold) {
  const { flightId, departureDate, bookingId } = hold;

  const payment = await paymentRepository.findByBooking(pool.writePool, {
    flightId,
    departureDate,
    bookingId
  });

  if (payment && payment.status === PAYMENT_STATUS.CAPTURED) {
    // Paid for, not yet confirmed: the reconciler's job. Returning the seats here would
    // sell a seat that has already been paid for.
    logger.warn('Reaper skipping a hold whose payment was captured; leaving it to the reconciler', {
      bookingId,
      flightId,
      paymentStatus: payment.status
    });
    return { expired: false, skipped: true, reason: 'PAYMENT_CAPTURED' };
  }

  const flight = await flightRepository.findById(pool.writePool, { flightId, departureDate });

  const expired = await pool.withTransaction(async (client) => {
    const claimed = await bookingRepository.claimForExpire(client, { flightId, departureDate, bookingId });
    if (!claimed) {
      // Lost the race to a confirm or a cancel. Their path already dealt with the seats.
      return null;
    }

    await inventoryService.releaseSeat(client, {
      flightId,
      departureDate,
      cabin: claimed.cabin,
      shardNo: claimed.inventoryShard,
      count: 1
    });

    if (payment) {
      // An authorization that was never captured is voided, not refunded: nothing moved.
      await paymentRepository.markFailed(client, {
        flightId,
        departureDate,
        paymentId: payment.paymentId,
        failureReason: 'HOLD_EXPIRED'
      });
    }

    const snapshot = flight ? flightSnapshot(flight) : null;
    await outboxRepository.insert(client, {
      flightId,
      departureDate,
      eventType: OUTBOX_EVENT_TYPES.BOOKING_EXPIRED,
      aggregateId: claimed.bookingId,
      userId: claimed.userId,
      payload: {
        booking: {
          bookingId: claimed.bookingId,
          bookingReference: claimed.bookingReference,
          flightId: claimed.flightId,
          departureDate: claimed.departureDate,
          userId: claimed.userId,
          cabin: claimed.cabin,
          seatNumber: claimed.seatNumber,
          passengerName: claimed.passengerName,
          status: BOOKING_STATUS.EXPIRED,
          price: claimed.price,
          currency: claimed.currency,
          createdAt: toIsoString(claimed.createdAt)
        },
        flight: snapshot
      }
    });

    // The seats came back, so the read model's availability is stale until this lands.
    const counters = await inventoryService.getAvailability(client, { flightId, departureDate, cabin: claimed.cabin });
    const counter = counters[0];
    if (counter && snapshot) {
      await outboxRepository.insert(client, {
        flightId,
        departureDate,
        eventType: OUTBOX_EVENT_TYPES.INVENTORY_CHANGED,
        aggregateId: flightId,
        userId: null,
        payload: {
          flight: snapshot,
          cabin: counter.cabin,
          shardNo: claimed.inventoryShard,
          totalSeats: counter.totalSeats,
          availableSeats: counter.availableSeats,
          heldSeats: counter.heldSeats,
          version: counter.version,
          price: counter.price,
          currency: counter.currency
        }
      });
    }

    return claimed;
  });

  if (!expired) {
    return { expired: false, skipped: true, reason: 'CLAIM_LOST' };
  }

  metrics.reaperExpiredTotal.inc();
  metrics.recordBooking(BOOKING_STATUS.EXPIRED, LOG_RESULTS.EXPIRED);
  logger.logBookingEvent({
    nodeId: expired.nodeId,
    transactionId: expired.transactionId,
    flightId,
    seatNumber: expired.seatNumber,
    operation: LOG_OPERATIONS.BOOKING_REAPER_EXPIRE,
    result: LOG_RESULTS.EXPIRED,
    bookingId,
    bookingReference: expired.bookingReference,
    cabin: expired.cabin
  });

  return { expired: true, skipped: false, bookingId };
}

/** One pass. Returns counts rather than logging them, so tests can assert on them. */
async function runOnce({ limit = env.REAPER_BATCH_SIZE } = {}) {
  const asOf = new Date();
  const candidates = await bookingRepository.findExpiredHolds(pool.writePool, {
    asOf,
    departureDateFrom: scanHorizon(),
    limit
  });

  let expired = 0;
  let skipped = 0;
  let failed = 0;

  for (const hold of candidates) {
    try {
      const result = await expireHold(hold);
      if (result.expired) expired += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      // Left PENDING on purpose: the hold stays visible to the next tick, and if the
      // failure is permanent the reconciler will eventually compensate it. Losing the
      // seats is worse than being late to return them.
      logger.error('Hold reaper failed to expire a booking', {
        bookingId: hold.bookingId,
        flightId: hold.flightId,
        error: err.message
      });
    }
  }

  try {
    metrics.activeHoldsGauge.set(await bookingRepository.countOpenHolds(pool.writePool, { asOf }));
  } catch (err) {
    logger.warn('Could not refresh active holds gauge', { error: err.message });
  }

  return { candidates: candidates.length, expired, skipped, failed };
}

/** Interval loop. Returns a stop function; unref'd so it never holds the process open. */
function start({ intervalMs = env.REAPER_INTERVAL_MS } = {}) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runOnce();
      if (result.expired > 0 || result.failed > 0) {
        logger.info('Hold reaper pass complete', result);
      }
    } catch (err) {
      logger.error('Hold reaper pass failed', { error: err.message });
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
      if (timer.unref) timer.unref();
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

module.exports = { runOnce, expireHold, start, scanHorizon };
