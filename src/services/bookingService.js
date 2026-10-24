/**
 * Booking service — the saga that turns a request into a paid, seated booking.
 *
 * The sequence is
 *
 *     reserve inventory -> insert booking (PENDING) -> authorize -> capture -> confirm
 *
 * and every step that has an effect is written down before the next one starts. That
 * is what makes the whole thing recoverable: a process that dies mid-saga leaves a
 * PENDING booking and a payment row whose `saga_state` says exactly which step it got
 * to, so a different process can pick it up and either roll it forward or compensate.
 * `advanceSaga` is that resume path, and the inline request path calls the same
 * function — there is one implementation of the saga, not a request version and a
 * recovery version that can drift apart.
 *
 * Three rules are what keep this correct rather than merely plausible:
 *
 * 1. THE TRANSACTION HOLDS NO NETWORK CALL. Authorize and capture happen between
 *    transactions, never inside one. A third-party call inside the transaction would
 *    hold the inventory counter's row lock for the duration of someone else's
 *    timeout, serializing every buyer on that flight behind it.
 *
 * 2. EVERY STATE CHANGE IS A CONDITIONAL CLAIM. `UPDATE … WHERE status = 'PENDING'`
 *    means the reaper that expires a hold and the payment that confirms it cannot
 *    both win. The loser updates zero rows and learns it lost — instead of
 *    resurrecting an expired hold and selling a seat that was already returned.
 *
 * 3. COMPENSATION IS BEST EFFORT, AND THE HOLD TTL IS THE BACKSTOP. If compensation
 *    itself fails, the booking stays PENDING with an expiry, and the reaper returns
 *    those seats within one TTL. Nothing is lost — it is just late. That is why the
 *    hold expiry exists at all rather than being a nicety.
 */
const pool = require('../db/pool');
const env = require('../config/env');
const logger = require('../utils/logger');
const metrics = require('../observability/metrics');
const errors = require('../utils/errors');
const { executeWithRetry } = require('../concurrency/transactionRetry');
const { newUuid, generateBookingReference } = require('../utils/ids');
const {
  BOOKING_STATUS,
  PAYMENT_STATUS,
  SAGA_STATE,
  OUTBOX_EVENT_TYPES,
  CONSTRAINT_NAMES,
  CONSTRAINT_VIOLATION,
  LOG_OPERATIONS,
  LOG_RESULTS
} = require('../config/constants');

const bookingRepository = require('../repositories/bookingRepository');
const paymentRepository = require('../repositories/paymentRepository');
const outboxRepository = require('../repositories/outboxRepository');
const flightRepository = require('../repositories/flightRepository');
const referenceRepository = require('../repositories/referenceRepository');
const constraintNames = require('../db/constraintNames');
const inventoryService = require('./inventoryService');
const paymentService = require('./paymentService');
const pricing = require('./pricingService');
const idempotencyService = require('./idempotencyService');

const IDEMPOTENCY_SCOPE = 'booking';
const REFERENCE_ATTEMPTS = 5;

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** The flight facts a projection needs, so the consumer never has to join. */
function flightSnapshot(flight) {
  return {
    origin: flight.origin,
    destination: flight.destination,
    flightNumber: flight.flightNumber,
    airlineCode: flight.airlineCode,
    aircraftType: flight.aircraftType,
    departureTime: toIso(flight.departureTime),
    arrivalTime: toIso(flight.arrivalTime)
  };
}

/** The public shape of a booking. One definition, so the contract cannot drift. */
function serializeBooking(booking, { flight = null, payment = null } = {}) {
  if (!booking) return null;
  return {
    bookingId: booking.bookingId,
    bookingReference: booking.bookingReference,
    flightId: booking.flightId,
    departureDate: booking.departureDate,
    userId: booking.userId,
    cabin: booking.cabin,
    seatNumber: booking.seatNumber,
    passengerName: booking.passengerName,
    passengerRef: booking.passengerRef,
    status: booking.status,
    price: booking.price,
    currency: booking.currency,
    holdExpiresAt: toIso(booking.holdExpiresAt),
    confirmedAt: toIso(booking.confirmedAt),
    cancelledAt: toIso(booking.cancelledAt),
    cancellationReason: booking.cancellationReason,
    transactionId: booking.transactionId,
    nodeId: booking.nodeId,
    createdAt: toIso(booking.createdAt),
    updatedAt: toIso(booking.updatedAt),
    ...(payment
      ? {
          payment: {
            paymentId: payment.paymentId,
            status: payment.status,
            sagaState: payment.sagaState,
            providerReference: payment.providerReference,
            failureReason: payment.failureReason
          }
        }
      : {}),
    ...(flight ? { flight: flightSnapshot(flight) } : {})
  };
}

/**
 * A booking reference that is unique across the whole cluster.
 *
 * The database can only enforce uniqueness *within a flight* (`uq_booking_reference`
 * is scoped to (flight_id, departure_date), because a distributed table's unique index
 * must contain the distribution column). A customer quoting "BK-7F9A12K4QW" to a call
 * centre needs a reference that identifies one booking globally, so the generator
 * verifies against the whole cluster before the reference is handed out. 50 random bits
 * makes a collision vanishingly unlikely; the check makes it impossible to *hand out* a
 * duplicate, and the per-flight index still catches a race between two generators.
 */
async function generateUniqueReference(client) {
  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
    const reference = generateBookingReference();
    const existing = await bookingRepository.countByReference(client, { bookingReference: reference });
    if (existing === 0) return reference;
  }
  throw new errors.AppError(
    'Could not generate a unique booking reference',
    errors.AppError.prototype.statusCode,
    'REFERENCE_GENERATION_FAILED'
  );
}

/** Maps an inventory reservation failure onto the API's error contract. */
function reservationError(result, { flightId, cabin }) {
  switch (result.reason) {
    case 'SOLD_OUT':
      return new errors.SoldOutError('No seats remaining in the requested cabin', {
        flightId,
        cabin,
        availableSeats: result.inventory ? result.inventory.availableSeats : 0
      });
    case 'VERSION_CONFLICT':
      return new errors.VersionConflictError('Inventory changed since it was read', {
        flightId,
        cabin,
        currentVersion: result.inventory ? result.inventory.version : null
      });
    case 'NO_INVENTORY':
    default:
      // No counter row means the flight has no inventory for that cabin — either the
      // cabin does not exist on this aircraft or the flight was never provisioned.
      // From the customer's point of view both are "you cannot buy this".
      return new errors.SoldOutError('No inventory is configured for the requested cabin', {
        flightId,
        cabin,
        reason: result.reason
      });
  }
}

/** The event that feeds the read-model availability projection. */
async function emitInventoryChanged(client, { flight, cabin, shardNo }) {
  const counters = await inventoryService.getAvailability(client, {
    flightId: flight.flightId,
    departureDate: flight.departureDate,
    cabin
  });
  const snapshot = counters[0];
  if (!snapshot) return null;

  return outboxRepository.insert(client, {
    flightId: flight.flightId,
    departureDate: flight.departureDate,
    eventType: OUTBOX_EVENT_TYPES.INVENTORY_CHANGED,
    aggregateId: flight.flightId,
    userId: null,
    payload: {
      flight: flightSnapshot(flight),
      cabin: snapshot.cabin,
      shardNo,
      totalSeats: snapshot.totalSeats,
      availableSeats: snapshot.availableSeats,
      heldSeats: snapshot.heldSeats,
      version: snapshot.version,
      price: snapshot.price,
      currency: snapshot.currency
    }
  });
}

/** The event that feeds the per-user "my bookings" projection. */
async function emitBookingEvent(client, { flight, booking, eventType }) {
  return outboxRepository.insert(client, {
    flightId: booking.flightId,
    departureDate: booking.departureDate,
    eventType,
    aggregateId: booking.bookingId,
    userId: booking.userId,
    payload: {
      booking: {
        bookingId: booking.bookingId,
        bookingReference: booking.bookingReference,
        flightId: booking.flightId,
        departureDate: booking.departureDate,
        userId: booking.userId,
        cabin: booking.cabin,
        seatNumber: booking.seatNumber,
        passengerName: booking.passengerName,
        status: booking.status,
        price: booking.price,
        currency: booking.currency,
        createdAt: toIso(booking.createdAt)
      },
      flight: flightSnapshot(flight)
    }
  });
}

/**
 * Loads the context a booking needs. Reads only — deliberately outside any transaction
 * so the write transaction stays as short as the invariants allow.
 */
async function loadBookingContext({ flightId, cabin }) {
  const flight = await flightRepository.findAnyById(pool.writePool, { flightId });
  if (!flight) {
    throw new errors.NotFoundError('Flight not found', { flightId });
  }
  if (flight.status === 'CANCELLED') {
    throw new errors.ValidationError('Flight is cancelled and cannot be booked', {
      flightId,
      status: flight.status
    });
  }
  if (new Date(flight.departureTime).getTime() <= Date.now()) {
    throw new errors.ValidationError('Flight has already departed', {
      flightId,
      departureTime: flight.departureTime
    });
  }

  const cabinMeta = await referenceRepository.findCabin(pool.writePool, { code: cabin });
  if (!cabinMeta) {
    const available = await referenceRepository.listCabins(pool.writePool);
    throw new errors.ValidationError('Unknown cabin', {
      cabin,
      allowedCabins: available.map((entry) => entry.code)
    });
  }

  return { flight, cabinMeta };
}

/**
 * Creates a booking.
 *
 * @returns {{ booking: object, replayed: boolean, statusCode: number, saga: object|null }}
 *   `replayed` is true when an identical earlier request (same Idempotency-Key) is being
 *   answered with its original result, which the route reports as 200 rather than 201.
 */
async function createBooking({
  userId,
  flightId,
  cabin = null,
  passengerName,
  passengerRef = null,
  seatNumber = null,
  expectedVersion = null,
  idempotencyKey = null,
  nodeId = env.NODE_ID,
  injectPaymentFailure = false
}) {
  const startedAt = Date.now();
  const transactionId = newUuid();
  const requestedCabin = String(cabin || env.DEFAULT_CABIN).toUpperCase();
  const requestedSeat = seatNumber ? String(seatNumber).toUpperCase() : null;

  const requestHash = idempotencyService.hashRequest({
    userId,
    flightId,
    cabin: requestedCabin,
    passengerName,
    passengerRef,
    seatNumber: requestedSeat,
    expectedVersion
  });

  let claim = null;
  if (idempotencyKey) {
    const outcome = await idempotencyService.begin({
      scope: IDEMPOTENCY_SCOPE,
      key: idempotencyKey,
      requestHash
    });

    if (outcome.state === 'replay') {
      if (outcome.response && outcome.response.ok === false) {
        throw rehydrateError(outcome.response);
      }
      logger.logBookingEvent({
        nodeId,
        transactionId,
        flightId,
        seatNumber: requestedSeat,
        operation: LOG_OPERATIONS.BOOKING_IDEMPOTENT_CHECK,
        result: LOG_RESULTS.IDEMPOTENT_HIT,
        durationMs: Date.now() - startedAt,
        idempotencyKey
      });
      return {
        booking: outcome.response.booking,
        replayed: true,
        statusCode: 200,
        saga: outcome.response.saga || null
      };
    }

    if (outcome.state === 'in_flight') {
      throw new errors.IdempotencyConflictError(
        'An identical request with this Idempotency-Key is still being processed',
        { retryAfterMs: idempotencyService.DEFAULT_WAIT_MS }
      );
    }

    claim = outcome;
  }

  try {
    const result = await runCreateSaga({
      userId,
      flightId,
      cabin: requestedCabin,
      passengerName,
      passengerRef,
      seatNumber: requestedSeat,
      expectedVersion,
      idempotencyKey,
      nodeId,
      transactionId,
      startedAt,
      injectPaymentFailure
    });

    if (claim && idempotencyKey) {
      await idempotencyService.complete({
        scope: IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        requestHash,
        response: { ok: true, booking: result.booking, saga: result.saga }
      });
    }

    return result;
  } catch (err) {
    // The database's idempotency backstop rejected a duplicate the cache layer missed —
    // an eviction, a restart, or a request that was routed to a node whose in-process
    // cache never saw the first attempt. The original request succeeded, so this is a
    // replay and the correct answer is the booking that already exists, not an error.
    if (err.isReplay && err.booking) {
      const replayed = serializeBooking(err.booking);
      if (claim && idempotencyKey) {
        await idempotencyService.complete({
          scope: IDEMPOTENCY_SCOPE,
          key: idempotencyKey,
          requestHash,
          response: {
            ok: true,
            booking: replayed,
            saga: { state: err.booking.status, recoveredFromDatabaseBackstop: true }
          }
        });
      }
      logger.logBookingEvent({
        nodeId,
        transactionId,
        flightId,
        seatNumber: err.booking.seatNumber,
        operation: LOG_OPERATIONS.BOOKING_IDEMPOTENT_CHECK,
        result: LOG_RESULTS.IDEMPOTENT_HIT,
        durationMs: Date.now() - startedAt,
        idempotencyKey,
        recoveredFrom: 'database_backstop'
      });
      return {
        booking: replayed,
        replayed: true,
        statusCode: 200,
        saga: { state: err.booking.status, recoveredFromDatabaseBackstop: true }
      };
    }

    if (claim && idempotencyKey) {
      if (err.durableOutcome) {
        // The request failed, but it left a permanent record (a booking row, a
        // declined payment). A retry with the same key must see the same answer
        // rather than authorizing the card a second time.
        await idempotencyService.complete({
          scope: IDEMPOTENCY_SCOPE,
          key: idempotencyKey,
          requestHash,
          response: {
            ok: false,
            error: {
              code: err.code,
              message: err.message,
              details: err.details || null,
              // The status is part of the answer. Without it a replayed decline
              // rehydrated as a generic 500, which tells the client the server broke
              // instead of that its card was declined.
              statusCode: err.statusCode || 409
            },
            booking: err.booking ? serializeBooking(err.booking) : null
          }
        });
      } else {
        // Nothing durable happened: the transaction rolled back. Releasing the claim
        // lets the client's retry actually try again.
        await idempotencyService.release({
          claimKey: claim.claimKey,
          recordKey: claim.recordKey,
          token: claim.token
        });
      }
    }
    throw err;
  }
}

/**
 * The write half of the saga: reserve, then persist booking + payment + outbox in one
 * transaction.
 *
 * If the transaction rolls back, nothing happened at all — no seat is held, no booking
 * exists. If it commits, all four rows exist together. There is no intermediate state
 * for a crash to leave behind, which is the whole reason the outbox row is written here
 * rather than published after the commit.
 */
async function runCreateSaga(ctx) {
  const { userId, flightId, cabin, passengerName, passengerRef, seatNumber, expectedVersion, idempotencyKey, nodeId, transactionId } = ctx;

  const { flight } = await loadBookingContext({ flightId, cabin });
  const price = pricing.priceForCabin({ basePrice: flight.basePrice, cabin });
  const bookingId = newUuid();
  const paymentId = newUuid();
  const bookingReference = await generateUniqueReference(pool.writePool);
  const holdExpiresAt = new Date(Date.now() + env.BOOKING_HOLD_TTL_SECONDS * 1000);

  let booking;
  try {
    booking = await executeWithRetry(
      () =>
        pool.withTransaction(async (client) => {
          const reservation = await inventoryService.reserveSeat(client, {
            flightId,
            departureDate: flight.departureDate,
            cabin,
            count: 1,
            expectedVersion
          });

          if (!reservation.reserved) {
            throw reservationError(reservation, { flightId, cabin });
          }

          const created = await bookingRepository.insert(client, {
            bookingId,
            bookingReference,
            flightId,
            departureDate: flight.departureDate,
            userId,
            cabin,
            inventoryShard: reservation.shardNo,
            seatNumber,
            passengerName,
            passengerRef,
            status: BOOKING_STATUS.PENDING,
            price,
            currency: flight.currency,
            idempotencyKey,
            holdExpiresAt,
            nodeId,
            transactionId,
            paymentId
          });

          await paymentRepository.insert(client, {
            paymentId,
            flightId,
            departureDate: flight.departureDate,
            bookingId,
            amount: price,
            currency: flight.currency,
            provider: env.PAYMENT_PROVIDER,
            status: PAYMENT_STATUS.PENDING,
            sagaState: SAGA_STATE.RESERVED,
            idempotencyKey
          });

          await emitBookingEvent(client, {
            flight,
            booking: created,
            eventType: OUTBOX_EVENT_TYPES.BOOKING_RESERVED
          });
          await emitInventoryChanged(client, { flight, cabin, shardNo: reservation.shardNo });

          return created;
        }),
      {
        onRetry: (error, attempt, delayMs) => {
          logger.warn('Retrying booking transaction', {
            transactionId,
            flightId,
            attempt,
            delayMs,
            code: error.code
          });
        }
      }
    );
  } catch (err) {
    throw await translateConflict(err, {
      flightId,
      departureDate: flight.departureDate,
      idempotencyKey,
      seatNumber,
      cabin
    });
  }

  metrics.activeHoldsGauge.inc();
  logger.logBookingEvent({
    nodeId,
    transactionId,
    flightId,
    seatNumber: booking.seatNumber,
    operation: LOG_OPERATIONS.BOOKING_SAGA_RESERVE,
    result: LOG_RESULTS.SUCCESS,
    durationMs: Date.now() - ctx.startedAt,
    bookingId: booking.bookingId,
    bookingReference: booking.bookingReference,
    cabin
  });

  // --- Payment, outside the transaction -------------------------------------
  if (!env.BOOKING_SAGA_INLINE) {
    // The reconciler worker drives it forward from here. The hold expiry bounds how
    // long that may take before the seats are returned.
    metrics.recordBooking(BOOKING_STATUS.PENDING, LOG_RESULTS.SUCCESS);
    return {
      booking: serializeBooking(booking, { flight }),
      replayed: false,
      statusCode: 202,
      saga: { state: SAGA_STATE.RESERVED, async: true }
    };
  }

  const advanced = await advanceSaga({
    flightId,
    departureDate: booking.departureDate,
    bookingId: booking.bookingId,
    injectPaymentFailure: ctx.injectPaymentFailure
  });

  return {
    booking: advanced.booking,
    replayed: false,
    // A failed payment is reported as an error (409) by the route, so the success path
    // is only reached with a confirmed booking.
    statusCode: 201,
    saga: advanced.saga
  };
}

/**
 * Drives a booking from its persisted state to a terminal one.
 *
 * Safe to call repeatedly and from anywhere: every step re-reads the persisted state,
 * checks it against what it is about to do, and claims the transition conditionally.
 * That is what makes it usable as both the inline request path and the recovery path
 * for a crashed process — the same code, invoked later.
 */
async function advanceSaga({ flightId, departureDate, bookingId, injectPaymentFailure = false }) {
  const booking = await bookingRepository.findById(pool.writePool, { flightId, departureDate, bookingId });
  if (!booking) {
    throw new errors.NotFoundError('Booking not found', { bookingId });
  }
  const flight = await flightRepository.findById(pool.writePool, { flightId, departureDate });

  let payment = await paymentRepository.findByBooking(pool.writePool, { flightId, departureDate, bookingId });

  // Already terminal: nothing to do. This is the branch that makes a retry harmless.
  if (booking.status !== BOOKING_STATUS.PENDING) {
    return {
      booking: serializeBooking(booking, { flight, payment }),
      saga: { state: payment ? payment.sagaState : null, terminal: true }
    };
  }

  if (!payment) {
    // A PENDING booking with no payment row cannot be completed; compensate so the
    // held seats go back rather than waiting for the TTL.
    return compensate({
      flightId,
      departureDate,
      bookingId,
      reason: 'PAYMENT_RECORD_MISSING',
      flight,
      booking
    });
  }

  // --- Step 1: authorize ----------------------------------------------------
  if (payment.sagaState === SAGA_STATE.RESERVED || payment.sagaState === SAGA_STATE.AUTHORIZING) {
    await paymentRepository.markAuthorizing(pool.writePool, {
      flightId,
      departureDate,
      paymentId: payment.paymentId
    });
    metrics.recordSagaStep(SAGA_STATE.AUTHORIZING, LOG_RESULTS.SUCCESS);

    const authorization = await paymentService.authorize({
      amount: payment.amount,
      currency: payment.currency,
      bookingReference: booking.bookingReference,
      bookingId,
      idempotencyKey: payment.idempotencyKey,
      injectFailure: injectPaymentFailure
    });

    if (!authorization.approved) {
      const compensated = await compensate({
        flightId,
        departureDate,
        bookingId,
        reason: `PAYMENT_${authorization.failureReason}`,
        flight,
        booking,
        paymentFailureReason: authorization.failureReason,
        providerReference: authorization.providerReference
      });
      const err = new errors.PaymentFailedError('Payment was declined', {
        bookingId,
        bookingReference: booking.bookingReference,
        reason: authorization.failureReason,
        status: BOOKING_STATUS.CANCELLED
      });
      err.durableOutcome = true;
      err.booking = compensated.booking;
      throw err;
    }

    payment =
      (await paymentRepository.markAuthorized(pool.writePool, {
        flightId,
        departureDate,
        paymentId: payment.paymentId,
        providerReference: authorization.providerReference
      })) || payment;
    metrics.recordSagaStep(SAGA_STATE.AUTHORIZED, LOG_RESULTS.SUCCESS);
  }

  // --- Step 2: capture, then confirm ---------------------------------------
  if (payment.sagaState === SAGA_STATE.AUTHORIZED || payment.sagaState === SAGA_STATE.CAPTURING) {
    await paymentRepository.markCapturing(pool.writePool, {
      flightId,
      departureDate,
      paymentId: payment.paymentId
    });

    const capture = await paymentService.capture({
      providerReference: payment.providerReference,
      amount: payment.amount,
      bookingId
    });

    if (!capture.captured) {
      const compensated = await compensate({
        flightId,
        departureDate,
        bookingId,
        reason: 'PAYMENT_CAPTURE_FAILED',
        flight,
        booking
      });
      const err = new errors.PaymentFailedError('Payment capture failed', {
        bookingId,
        status: BOOKING_STATUS.CANCELLED
      });
      err.durableOutcome = true;
      err.booking = compensated.booking;
      throw err;
    }

    const confirmed = await executeWithRetry(() =>
      pool.withTransaction(async (client) => {
        // Claim the booking FIRST. If the reaper expired this hold while the payment
        // was in flight, this returns null and we must not confirm — the seats have
        // already gone back to the pool.
        const claimed = await bookingRepository.claimForConfirm(client, {
          flightId,
          departureDate,
          bookingId,
          paymentId: payment.paymentId
        });

        if (!claimed) {
          return null;
        }

        await inventoryService.confirmSeat(client, {
          flightId,
          departureDate,
          cabin: claimed.cabin,
          shardNo: claimed.inventoryShard,
          count: 1
        });

        await paymentRepository.markCaptured(client, {
          flightId,
          departureDate,
          paymentId: payment.paymentId,
          providerReference: capture.providerReference
        });

        await emitBookingEvent(client, {
          flight,
          booking: claimed,
          eventType: OUTBOX_EVENT_TYPES.BOOKING_CONFIRMED
        });
        await emitInventoryChanged(client, { flight, cabin: claimed.cabin, shardNo: claimed.inventoryShard });

        return claimed;
      })
    );

    if (!confirmed) {
      // The hold expired mid-payment. The money is captured but the seat is gone, so
      // the correct response is an immediate refund and a clear error — not a booking
      // the customer cannot fly on.
      logger.warn('Hold expired while payment was in flight; refunding', { bookingId, flightId });
      await paymentService.refund({
        providerReference: payment.providerReference,
        amount: payment.amount,
        reason: 'HOLD_EXPIRED',
        bookingId
      });
      await paymentRepository.markCompensated(pool.writePool, {
        flightId,
        departureDate,
        paymentId: payment.paymentId,
        failureReason: 'HOLD_EXPIRED'
      });

      const expired = await bookingRepository.findById(pool.writePool, { flightId, departureDate, bookingId });
      const err = new errors.HoldExpiredError('The hold expired before payment settled', {
        bookingId,
        bookingReference: booking.bookingReference
      });
      err.durableOutcome = true;
      err.booking = expired;
      throw err;
    }

    metrics.activeHoldsGauge.dec();
    metrics.recordBooking(BOOKING_STATUS.CONFIRMED, LOG_RESULTS.SUCCESS);
    metrics.recordSagaStep(SAGA_STATE.CONFIRMED, LOG_RESULTS.SUCCESS);

    const finalPayment = await paymentRepository.findByBooking(pool.writePool, {
      flightId,
      departureDate,
      bookingId
    });

    logger.logBookingEvent({
      nodeId: booking.nodeId,
      transactionId: booking.transactionId,
      flightId,
      seatNumber: confirmed.seatNumber,
      operation: LOG_OPERATIONS.BOOKING_SAGA_CONFIRM,
      result: LOG_RESULTS.SUCCESS,
      bookingId,
      bookingReference: booking.bookingReference
    });

    return {
      booking: serializeBooking(confirmed, { flight, payment: finalPayment }),
      saga: { state: SAGA_STATE.CONFIRMED, terminal: true }
    };
  }

  // CAPTURED but still PENDING (a crash between capture and confirm). Roll forward.
  if (payment.sagaState === SAGA_STATE.CAPTURED) {
    const confirmed = await bookingRepository.claimForConfirm(pool.writePool, {
      flightId,
      departureDate,
      bookingId,
      paymentId: payment.paymentId
    });
    if (confirmed) {
      await inventoryService.confirmSeat(pool.writePool, {
        flightId,
        departureDate,
        cabin: confirmed.cabin,
        shardNo: confirmed.inventoryShard,
        count: 1
      });
    }
    const settled = confirmed || (await bookingRepository.findById(pool.writePool, { flightId, departureDate, bookingId }));
    return {
      booking: serializeBooking(settled, { flight, payment }),
      saga: { state: SAGA_STATE.CONFIRMED, terminal: true }
    };
  }

  return {
    booking: serializeBooking(booking, { flight, payment }),
    saga: { state: payment.sagaState, terminal: false }
  };
}

/**
 * Undoes a booking: releases the seats, cancels the booking, refunds if money moved.
 *
 * Ordered so that the *seat* is always returned before the money is dealt with — a
 * refund that fails leaves the seat available, which is recoverable; a seat that stays
 * held because a refund threw is not.
 */
async function compensate({ flightId, departureDate, bookingId, reason, flight = null, booking = null, paymentFailureReason = null, providerReference = null }) {
  const resolvedFlight = flight || (await flightRepository.findById(pool.writePool, { flightId, departureDate }));
  const resolvedBooking = booking || (await bookingRepository.findById(pool.writePool, { flightId, departureDate, bookingId }));

  if (!resolvedBooking) {
    throw new errors.NotFoundError('Booking not found', { bookingId });
  }

  const payment = await paymentRepository.findByBooking(pool.writePool, { flightId, departureDate, bookingId });

  // Money already captured: refund it, outside the transaction.
  if (payment && payment.status === PAYMENT_STATUS.CAPTURED) {
    await paymentRepository.markCompensating(pool.writePool, {
      flightId,
      departureDate,
      paymentId: payment.paymentId,
      failureReason: paymentFailureReason
    });
    await paymentService.refund({
      providerReference: payment.providerReference,
      amount: payment.amount,
      reason,
      bookingId
    });
  } else if (payment && payment.providerReference) {
    // Authorized but not captured: voiding is enough, and cheaper than a refund.
    await paymentService.voidAuthorization({ providerReference: payment.providerReference, bookingId });
  }

  const compensated = await executeWithRetry(() =>
    pool.withTransaction(async (client) => {
      const cancelled = await bookingRepository.claimForCancel(client, {
        flightId,
        departureDate,
        bookingId,
        reason
      });

      if (!cancelled) {
        // Someone else already moved this booking (a user cancel, or the reaper).
        // Their path released the seats; doing it again would credit a seat twice.
        return null;
      }

      if (cancelled.wasConfirmed) {
        // Read off the row `claimForCancel` just updated, never off `resolvedBooking`:
        // between that read and this claim a payment can capture the booking, which would
        // leave the release below aiming at a seat that is no longer held. See the note
        // on claimForCancel.
        await inventoryService.reclaimSeat(client, {
          flightId,
          departureDate,
          cabin: cancelled.cabin,
          shardNo: cancelled.inventoryShard,
          count: 1
        });
      } else {
        await inventoryService.releaseSeat(client, {
          flightId,
          departureDate,
          cabin: cancelled.cabin,
          shardNo: cancelled.inventoryShard,
          count: 1
        });
      }

      if (payment) {
        if (payment.status === PAYMENT_STATUS.CAPTURED || payment.status === PAYMENT_STATUS.AUTHORIZED) {
          await paymentRepository.markCompensated(client, {
            flightId,
            departureDate,
            paymentId: payment.paymentId,
            failureReason: paymentFailureReason
          });
        } else {
          await paymentRepository.markFailed(client, {
            flightId,
            departureDate,
            paymentId: payment.paymentId,
            failureReason: paymentFailureReason || reason
          });
        }
      }

      await emitBookingEvent(client, {
        flight: resolvedFlight,
        booking: cancelled,
        eventType: OUTBOX_EVENT_TYPES.BOOKING_CANCELLED
      });
      await emitInventoryChanged(client, { flight: resolvedFlight, cabin: cancelled.cabin, shardNo: cancelled.inventoryShard });

      return cancelled;
    })
  );

  if (!compensated) {
    const current = await bookingRepository.findById(pool.writePool, { flightId, departureDate, bookingId });
    return { booking: serializeBooking(current, { flight: resolvedFlight, payment }), saga: { state: SAGA_STATE.COMPENSATED, terminal: true, alreadyMoved: true } };
  }

  metrics.recordSagaStep(SAGA_STATE.COMPENSATED, LOG_RESULTS.COMPENSATED);
  metrics.recordBooking(BOOKING_STATUS.CANCELLED, LOG_RESULTS.PAYMENT_FAILED);

  logger.logBookingEvent({
    nodeId: compensated.nodeId,
    transactionId: compensated.transactionId,
    flightId,
    seatNumber: compensated.seatNumber,
    operation: LOG_OPERATIONS.BOOKING_SAGA_COMPENSATE,
    result: LOG_RESULTS.COMPENSATED,
    bookingId,
    bookingReference: compensated.bookingReference,
    reason
  });

  const finalPayment = await paymentRepository.findByBooking(pool.writePool, { flightId, departureDate, bookingId });
  return {
    booking: serializeBooking(compensated, { flight: resolvedFlight, payment: finalPayment }),
    saga: { state: SAGA_STATE.COMPENSATED, terminal: true }
  };
}

/**
 * Cancels a booking the customer owns.
 *
 * The seat goes back through a different statement depending on where the booking was:
 * a PENDING hold returns from `held_seats`, a CONFIRMED booking returns from the sold
 * side. Using the wrong one silently does nothing, which is why the status is read
 * before the release rather than assumed.
 */
async function cancelBooking({ bookingId, userId, isAdmin = false, reason = 'USER_CANCELLED' }) {
  const booking = await bookingRepository.findAnyById(pool.writePool, { bookingId });
  if (!booking) {
    throw new errors.NotFoundError('Booking not found', { bookingId });
  }
  if (!isAdmin && userId && booking.userId !== userId) {
    throw new errors.ForbiddenError('This booking belongs to another user', { bookingId });
  }
  if (booking.status === BOOKING_STATUS.CANCELLED) {
    const err = new errors.AppError(
      'Booking is already cancelled',
      409,
      'ALREADY_CANCELLED',
      { bookingId, cancelledAt: booking.cancelledAt }
    );
    throw err;
  }
  if (booking.status === BOOKING_STATUS.EXPIRED) {
    throw new errors.HoldExpiredError('The hold expired and the booking can no longer be cancelled', {
      bookingId
    });
  }

  const flight = await flightRepository.findById(pool.writePool, {
    flightId: booking.flightId,
    departureDate: booking.departureDate
  });

  const result = await compensate({
    flightId: booking.flightId,
    departureDate: booking.departureDate,
    bookingId,
    reason,
    flight,
    booking
  });

  return { booking: result.booking, saga: result.saga };
}

/**
 * Rebuilds an error from a stored idempotency record, so a replay reports the
 * original outcome — including its HTTP status and, when one was written, the
 * booking row the failed attempt left behind.
 */
function rehydrateError(stored) {
  if (!stored || !stored.error) {
    return new errors.AppError('The original request failed', 409, 'IDEMPOTENT_FAILURE');
  }

  const { error, booking } = stored;
  const err = new errors.AppError(
    error.message,
    error.statusCode || 409,
    error.code,
    error.details || null
  );
  if (booking) err.booking = booking;
  err.durableOutcome = true;
  return err;
}

/**
 * Turns a SQLSTATE into the API's error vocabulary.
 *
 * `uq_live_seat` firing is the database enforcing "one live booking per seat". The
 * application-level seat check is an optimization and this is the guarantee, so getting
 * the mapping right matters: mapping it to SEAT_UNAVAILABLE tells the client the truth
 * (someone else got the seat, pick another) whereas letting the raw 23505 escape tells
 * them the server is broken.
 *
 * The name in the error is the PARTITION's index name, not the one declared on the
 * parent table — see db/constraintNames for why, and for the catalog lookup that maps
 * one to the other. A violation that cannot be identified is reported as a duplicate
 * rather than silently swallowed: an unidentified unique conflict is still a conflict.
 */
async function translateConflict(err, { flightId, departureDate, idempotencyKey, seatNumber, cabin }) {
  if (err.code !== CONSTRAINT_VIOLATION.UNIQUE_VIOLATION) return err;

  const { constraint, via } = await constraintNames.classifyUniqueViolation(pool.writePool, err);

  switch (constraint) {
    case CONSTRAINT_NAMES.LIVE_SEAT_UNIQUE: {
      const conflict = new errors.SeatUnavailableError('That seat was taken by another booking', {
        flightId,
        departureDate,
        cabin,
        seatNumber
      });
      // The database rejected it, so the seat really is gone — the caller's seat map was
      // stale, not their request malformed.
      conflict.durableOutcome = false;
      return conflict;
    }

    case CONSTRAINT_NAMES.IDEMPOTENCY_UNIQUE: {
      // The cache layer missed (eviction, restart, or a different node), and the database
      // backstop caught the duplicate. The right answer is not an error: the original
      // request succeeded, so this is a replay. Re-read it and answer with the booking
      // that already exists. Only when the booking cannot be found is this a real error.
      if (idempotencyKey) {
        const existing = await bookingRepository.findByIdempotencyKey(pool.writePool, {
          idempotencyKey,
          flightId,
          departureDate
        });
        if (existing) {
          const replay = new errors.DuplicateBookingError('This request already produced a booking', {
            flightId,
            idempotencyKey,
            bookingId: existing.bookingId,
            bookingReference: existing.bookingReference
          });
          replay.durableOutcome = true;
          replay.booking = existing;
          replay.isReplay = true;
          return replay;
        }
      }
      const duplicate = new errors.DuplicateBookingError('A booking already exists for this request', {
        flightId,
        idempotencyKey
      });
      duplicate.durableOutcome = true;
      return duplicate;
    }

    case CONSTRAINT_NAMES.BOOKING_REFERENCE_UNIQUE:
      return new errors.DuplicateEntryError('Booking reference collision; please retry', {
        flightId,
        departureDate
      });

    default: {
      // Unrecognised unique violation. Reported as a conflict with the raw detail kept
      // for diagnosis — the one thing it must not become is an unhandled 500, because
      // that hides a constraint the application forgot to map.
      logger.error('Unmapped unique violation in the booking path', {
        constraint: err.constraint,
        via,
        detail: err.detail
      });
      return new errors.DuplicateEntryError('A unique constraint rejected this booking', {
        flightId,
        departureDate,
        constraint: err.constraint || null,
        detail: err.detail || null
      });
    }
  }
}

async function getBooking({ bookingId }) {
  const booking = await bookingRepository.findAnyById(pool.writePool, { bookingId });
  if (!booking) {
    throw new errors.NotFoundError('Booking not found', { bookingId });
  }
  const flight = await flightRepository.findById(pool.writePool, {
    flightId: booking.flightId,
    departureDate: booking.departureDate
  });
  const payment = await paymentRepository.findByBooking(pool.writePool, {
    flightId: booking.flightId,
    departureDate: booking.departureDate,
    bookingId
  });
  return serializeBooking(booking, { flight, payment });
}

async function getBookingByReference({ bookingReference }) {
  const booking = await bookingRepository.findByReference(pool.writePool, { bookingReference });
  if (!booking) {
    throw new errors.NotFoundError('Booking not found', { bookingReference });
  }
  return getBooking({ bookingId: booking.bookingId });
}

module.exports = {
  createBooking,
  advanceSaga,
  compensate,
  cancelBooking,
  getBooking,
  getBookingByReference,
  serializeBooking,
  flightSnapshot,
  emitBookingEvent,
  emitInventoryChanged,
  loadBookingContext,
  translateConflict,
  generateUniqueReference,
  IDEMPOTENCY_SCOPE,
  _private: { rehydrateError, reservationError }
};
