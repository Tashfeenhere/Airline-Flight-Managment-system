/**
 * Projection service — turns outbox events into read models.
 *
 * Two projections are maintained, and they live in different databases for different
 * reasons:
 *
 *   user_bookings       (write cluster)  answers "my bookings" without scattering a
 *                                        query across every flight's shard. Sharded by
 *                                        user_id, because the question is asked by user.
 *   flight_availability (read cluster)   answers search. Deliberately in its own
 *                                        database so a slow search can never hold a
 *                                        lock that blocks a sale.
 *
 * THE DELIVERY PROTOCOL, which is the whole correctness story here:
 *
 *     project first, then mark published
 *
 * A crash between the two replays the event. That is safe because every projection
 * write is a *guarded upsert* — `WHERE last_event_at <= EXCLUDED.last_event_at` for
 * user_bookings, `WHERE source_version <= EXCLUDED.source_version` for availability —
 * so a replay, or a batch delivered out of order, changes nothing. Marking published
 * first would be the tempting optimization and it inverts the failure mode: a crash
 * after the mark loses the projection permanently, silently, and nothing ever notices.
 * Between "may apply twice" and "may lose one", at-least-once plus idempotent writes is
 * the only one of the two that is recoverable.
 *
 * The events carry a denormalized flight snapshot in their payload, so projecting needs
 * no join back into the write model and the consumer can run anywhere — against a
 * lagging replica, on a separate host, or as a batch job replaying history.
 */
const pool = require('../db/pool');
const env = require('../config/env');
const logger = require('../utils/logger');
const metrics = require('../observability/metrics');
const { OUTBOX_EVENT_TYPES, LOG_OPERATIONS, LOG_RESULTS } = require('../config/constants');

const availabilityRepository = require('../repositories/availabilityRepository');
const userBookingsRepository = require('../repositories/userBookingsRepository');
const outboxRepository = require('../repositories/outboxRepository');
const bookingRepository = require('../repositories/bookingRepository');
const { priceForCabin } = require('./pricingService');

/** Every event type this projector understands. Anything else is a hard error. */
const HANDLED_EVENTS = Object.freeze([
  OUTBOX_EVENT_TYPES.BOOKING_RESERVED,
  OUTBOX_EVENT_TYPES.BOOKING_CONFIRMED,
  OUTBOX_EVENT_TYPES.BOOKING_CANCELLED,
  OUTBOX_EVENT_TYPES.BOOKING_EXPIRED,
  OUTBOX_EVENT_TYPES.INVENTORY_CHANGED,
  OUTBOX_EVENT_TYPES.FLIGHT_UPSERTED
]);

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Which availability rows a single inventory event should update.
 *
 * An INVENTORY_CHANGED event describes ONE cabin's counter, but the read model's key
 * is (origin, destination, date, flight, cabin) and the row needs the flight's route
 * facts too. Both are in the payload. A FLIGHT_UPSERTED event may carry every cabin at
 * once, which is what makes the admin upsert project in one event rather than N.
 */
function availabilityEntriesFrom(event) {
  const payload = event.payload || {};
  const flight = payload.flight || {};

  const base = {
    origin: flight.origin,
    destination: flight.destination,
    departureDate: event.departureDate,
    flightId: event.flightId,
    flightNumber: flight.flightNumber,
    airlineCode: flight.airlineCode,
    aircraftType: flight.aircraftType || null,
    departureTime: flight.departureTime || null,
    arrivalTime: flight.arrivalTime || null,
    status: flight.status || null,
    currency: flight.currency || null
  };

  if (Array.isArray(payload.cabins)) {
    return payload.cabins.map((cabin) => ({
      ...base,
      cabin: cabin.cabin,
      totalSeats: cabin.totalSeats,
      availableSeats: cabin.availableSeats,
      heldSeats: cabin.heldSeats || 0,
      price: cabin.price,
      currency: cabin.currency || base.currency,
      sourceVersion: Number(cabin.version || 0)
    }));
  }

  if (payload.cabin) {
    const basePrice = flight.basePrice === undefined ? null : flight.basePrice;
    return [
      {
        ...base,
        cabin: payload.cabin,
        totalSeats: payload.totalSeats,
        availableSeats: payload.availableSeats,
        heldSeats: payload.heldSeats || 0,
        price:
          payload.price === undefined || payload.price === null
            ? basePrice === null
              ? null
              : priceForCabin({ basePrice, cabin: payload.cabin })
            : payload.price,
        sourceVersion: Number(payload.version || 0)
      }
    ];
  }

  return [];
}

/**
 * Applies one event.
 *
 * Takes both clients because the two projections live in two databases. Each write is
 * independent, and each is individually idempotent — so there is no need for a
 * two-database transaction (which would need two-phase commit, the exact thing this
 * architecture spends its effort avoiding). If the process dies between them, the
 * replay re-applies whichever one landed and the guards reject it.
 */
async function applyEvent({ writeClient, readClient }, event) {
  const payload = event.payload || {};
  const applied = [];

  switch (event.eventType) {
    case OUTBOX_EVENT_TYPES.BOOKING_RESERVED:
    case OUTBOX_EVENT_TYPES.BOOKING_CONFIRMED:
    case OUTBOX_EVENT_TYPES.BOOKING_CANCELLED:
    case OUTBOX_EVENT_TYPES.BOOKING_EXPIRED: {
      if (!event.userId) break;
      const booking = payload.booking || {};
      const flight = payload.flight || {};
      const result = await userBookingsRepository.upsert(writeClient, {
        userId: event.userId,
        bookingId: event.aggregateId || booking.bookingId,
        flightId: event.flightId,
        departureDate: event.departureDate,
        bookingReference: booking.bookingReference,
        status: booking.status,
        cabin: booking.cabin,
        seatNumber: booking.seatNumber || null,
        passengerName: booking.passengerName || null,
        origin: flight.origin || null,
        destination: flight.destination || null,
        flightNumber: flight.flightNumber || null,
        airlineCode: flight.airlineCode || null,
        departureTime: flight.departureTime || null,
        price: booking.price === undefined ? null : booking.price,
        currency: booking.currency || null,
        bookingCreatedAt: booking.createdAt || event.createdAt,
        // The event's own creation time is the ordering key. Because the event is
        // written in the same transaction as the state change it describes, this is
        // transaction time — monotone with respect to the business facts.
        lastEventAt: event.createdAt
      });
      applied.push({ projection: 'user_bookings', applied: result.applied });
      break;
    }

    case OUTBOX_EVENT_TYPES.INVENTORY_CHANGED:
    case OUTBOX_EVENT_TYPES.FLIGHT_UPSERTED: {
      const entries = availabilityEntriesFrom(event);
      let wrote = 0;
      for (const entry of entries) {
        if (!entry.cabin || entry.availableSeats === undefined || entry.availableSeats === null) continue;
        const result = await availabilityRepository.upsert(readClient, entry);
        wrote += 1;
        applied.push({ projection: 'flight_availability', cabin: entry.cabin, applied: result.applied });
      }
      if (wrote > 0) {
        // Bookkeeping that makes "how stale is search?" answerable without scanning the
        // data. GREATEST-guarded in SQL, so a replayed older event cannot rewind the
        // watermark and make the read model look fresher than it is.
        await availabilityRepository.touchProjectionState(readClient, {
          projection: 'flight_availability',
          lastEventAt: event.createdAt,
          lastEventId: event.eventId
        });
      }
      break;
    }

    default:
      // An unknown event type means the outbox contains something this build cannot
      // interpret — a deploy ordering problem. Failing loudly keeps it visible in
      // `outboxRepository.listPoisoned` instead of silently dropping a projection.
      throw new Error(`Unknown outbox event type: ${event.eventType}`);
  }

  return applied;
}

/**
 * Projects a batch.
 *
 * Each event is projected and marked in its own transaction, so one poisonous event
 * cannot roll back the twenty healthy ones behind it. Reads the pending list with a
 * scatter (the outbox is distributed by flight_id) and then does only single-shard
 * writes — no multi-shard UPDATE anywhere in the consumer.
 */
async function runOnce({ limit = env.OUTBOX_BATCH_SIZE, eventTypes = null } = {}) {
  const pending = await outboxRepository.listPending(pool.writePool, { limit, eventTypes });
  if (pending.length === 0) {
    await refreshGauges();
    return { scanned: 0, projected: 0, failed: 0, skipped: 0 };
  }

  let projected = 0;
  let failed = 0;
  let skipped = 0;

  for (const event of pending) {
    const startedAt = Date.now();
    try {
      const applied = await pool.withTransaction(async (writeClient) => {
        const result = await applyEvent({ writeClient, readClient: pool.readPool }, event);
        // Only after the projection is committed do we declare the event delivered.
        await outboxRepository.markPublished(writeClient, {
          flightId: event.flightId,
          departureDate: event.departureDate,
          eventId: event.eventId
        });
        return result;
      });

      const changed = applied.filter((entry) => entry.applied).length;
      projected += 1;
      skipped += applied.length - changed;

      metrics.outboxEventsProcessedTotal.inc({ event_type: event.eventType, result: LOG_RESULTS.SUCCESS });
      logger.logBookingEvent({
        nodeId: env.NODE_ID,
        transactionId: event.eventId,
        flightId: event.flightId,
        operation: LOG_OPERATIONS.OUTBOX_PROJECT,
        result: LOG_RESULTS.SUCCESS,
        eventType: event.eventType,
        projections: applied.length,
        stale: applied.length - changed,
        durationMs: Date.now() - startedAt
      });
    } catch (err) {
      failed += 1;
      metrics.outboxEventsProcessedTotal.inc({ event_type: event.eventType, result: LOG_RESULTS.FAILED });
      logger.error('Outbox projection failed', {
        eventId: event.eventId,
        eventType: event.eventType,
        flightId: event.flightId,
        departureDate: event.departureDate,
        attempts: event.attempts + 1,
        error: err.message
      });
      // Record the attempt but leave the event unpublished: the next tick retries it.
      // `attempts` climbing is what makes a genuinely poisonous event visible.
      try {
        await outboxRepository.markFailed(pool.writePool, {
          flightId: event.flightId,
          departureDate: event.departureDate,
          eventId: event.eventId,
          error: err.message
        });
      } catch (markErr) {
        logger.error('Could not record outbox failure', { eventId: event.eventId, error: markErr.message });
      }
    }
  }

  await refreshGauges();
  return { scanned: pending.length, projected, failed, skipped };
}

/** Publishes the backlog size and age, which is the honest measure of read-model lag. */
async function refreshGauges() {
  try {
    const stats = await outboxRepository.stats(pool.writePool);
    metrics.outboxPendingGauge.set(stats.pending);
    metrics.outboxLagSeconds.set(stats.lagSeconds || 0);
    metrics.readModelLagSeconds.set({ projection: 'outbox' }, stats.lagSeconds || 0);
  } catch (err) {
    logger.warn('Could not refresh outbox gauges', { error: err.message });
  }
}

/**
 * Rebuilds `user_bookings` for a single user straight from the write model.
 *
 * This is the repair path for a projection that has drifted — a user whose booking list
 * is missing a row. It reads the authoritative table and writes the projection, so it
 * can be run as often as needed. It does not touch `flight_availability`, which is
 * rebuilt from the outbox instead (see scripts/reproject-readmodel.js) because
 * availability depends on event *order* rather than on a current-state table.
 */
async function reprojectUser({ userId, onProgress = null }) {
  const bookings = await bookingRepository.listByUser(pool.writePool, { userId, limit: 10000 });
  let written = 0;

  for (const booking of bookings) {
    const flight = await pool.writePool.query(
      `SELECT origin, destination, flight_number, airline_code, departure_time
         FROM flights WHERE flight_id = $1 AND departure_date = $2`,
      [booking.flightId, booking.departureDate]
    );
    const row = flight.rows[0] || {};
    const result = await userBookingsRepository.upsert(pool.writePool, {
      userId,
      bookingId: booking.bookingId,
      flightId: booking.flightId,
      departureDate: booking.departureDate,
      bookingReference: booking.bookingReference,
      status: booking.status,
      cabin: booking.cabin,
      seatNumber: booking.seatNumber,
      passengerName: booking.passengerName,
      origin: row.origin || null,
      destination: row.destination || null,
      flightNumber: row.flight_number || null,
      airlineCode: row.airline_code || null,
      departureTime: toIso(row.departure_time),
      price: booking.price,
      currency: booking.currency,
      bookingCreatedAt: booking.createdAt,
      // The booking's own updated_at is the best available stand-in for "when this
      // state became true", so a later live event can still correct it.
      lastEventAt: booking.updatedAt || booking.createdAt
    });
    if (result.applied) written += 1;
    if (onProgress) onProgress({ total: bookings.length, written });
  }

  return { scanned: bookings.length, written };
}

/**
 * Rebuilds `flight_availability` by replaying the outbox.
 *
 * Availability is a function of event history, not current state: the counters in the
 * read model are versioned snapshots, and replaying them in order rebuilds the same
 * answer.
 *
 * Two knobs make this a repair tool rather than only a rebuild:
 *
 *   flightIds  replays just those flights' events. A cluster-wide replay is the right
 *              answer to "the read model is wrong", but it is the wrong answer to "one
 *              route is showing the wrong price", and at 50M flights it is also an
 *              hour of work for a one-row fix.
 *   force      deletes the affected flights' read rows first. Without it the replay is
 *              a guarded upsert, which can only ever move a row *forward* — it cannot
 *              remove a row that should not exist (a flight cancelled in the write
 *              model while its projection row survived, say). `force` means "rebuild
 *              from history", and history is the only input that decides what remains.
 *
 * `skipped` counts entries the guard rejected because the projected version was
 * already at least as new. A replay reporting mostly `skipped` is the expected,
 * reassuring outcome: it means the read model already agreed with the events.
 */
async function reprojectAvailability({ since, until, limit = 1000, flightIds = null, force = false, onProgress = null }) {
  if (force && flightIds && flightIds.length > 0) {
    for (const flightId of flightIds) {
      await availabilityRepository.deleteByFlightId(pool.readPool, { flightId });
    }
  }

  let offset = 0;
  let projected = 0;
  let written = 0;
  let skipped = 0;
  let batches = 0;

  for (;;) {
    const events = await outboxRepository.listForReprojection(pool.writePool, {
      since,
      until,
      limit,
      offset,
      flightIds,
      eventTypes: [OUTBOX_EVENT_TYPES.INVENTORY_CHANGED, OUTBOX_EVENT_TYPES.FLIGHT_UPSERTED]
    });
    if (events.length === 0) break;

    for (const event of events) {
      for (const entry of availabilityEntriesFrom(event)) {
        if (!entry.cabin || entry.availableSeats === undefined || entry.availableSeats === null) continue;
        const result = await availabilityRepository.upsert(pool.readPool, entry);
        projected += 1;
        if (result.applied) written += 1;
        else skipped += 1;
      }
    }

    batches += 1;
    offset += events.length;
    if (onProgress) onProgress({ batches, projected });
    if (events.length < limit) break;
  }

  const lagSeconds = await availabilityRepository.projectionLagSeconds(pool.readPool, {
    projection: 'flight_availability'
  });

  return { batches, projected, written, skipped, lagSeconds };
}

module.exports = {
  applyEvent,
  availabilityEntriesFrom,
  runOnce,
  refreshGauges,
  reprojectUser,
  reprojectAvailability,
  HANDLED_EVENTS
};
