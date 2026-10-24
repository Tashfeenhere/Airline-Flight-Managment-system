/**
 * Flight service — search, flight detail, seat map, and the admin upsert.
 *
 * The split between the two databases is visible here and is deliberate:
 *
 *   search            reads the READ model (flight_availability). It is the wide,
 *                     filtered, high-volume query, and it is allowed to be a moment
 *                     stale — the API says so in the response.
 *   detail/seat map   reads the WRITE model. A seat map that shows a seat as free
 *                     when it is held is worse than a slow one, and the write model
 *                     is the only place that number is true.
 *
 * `getAvailability` reads the write model for the same reason: it is the number the
 * booking path will actually enforce, so it is the number worth reporting to a client
 * about to press "book".
 */
const pool = require('../db/pool');
const env = require('../config/env');
const logger = require('../utils/logger');
const metrics = require('../observability/metrics');
const errors = require('../utils/errors');
const { OUTBOX_EVENT_TYPES } = require('../config/constants');

const flightRepository = require('../repositories/flightRepository');
const availabilityRepository = require('../repositories/availabilityRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const bookingRepository = require('../repositories/bookingRepository');
const referenceRepository = require('../repositories/referenceRepository');
const outboxRepository = require('../repositories/outboxRepository');
const inventoryService = require('./inventoryService');
const pricing = require('./pricingService');
const { priceForCabin } = pricing;
const { toIsoString } = require('../repositories/mappers');

function serializeFlight(flight) {
  if (!flight) return null;
  return {
    flightId: flight.flightId,
    flightNumber: flight.flightNumber,
    airlineCode: flight.airlineCode,
    origin: flight.origin,
    destination: flight.destination,
    departureDate: flight.departureDate,
    departureTime: toIsoString(flight.departureTime),
    arrivalTime: toIsoString(flight.arrivalTime),
    aircraftType: flight.aircraftType,
    basePrice: flight.basePrice,
    currency: flight.currency,
    status: flight.status
  };
}

/** The denormalized flight facts the availability projection needs. */
function flightSnapshotForProjection(flight) {
  return {
    flightId: flight.flightId,
    flightNumber: flight.flightNumber,
    airlineCode: flight.airlineCode,
    origin: flight.origin,
    destination: flight.destination,
    aircraftType: flight.aircraftType,
    departureTime: toIsoString(flight.departureTime),
    arrivalTime: toIsoString(flight.arrivalTime),
    basePrice: flight.basePrice,
    currency: flight.currency,
    status: flight.status
  };
}

/**
 * Search, served from the read model.
 *
 * `freshness` reports how far behind the read model is, because a client deciding
 * whether to trust "12 seats left" deserves to know whether that number is a
 * millisecond or a minute old.
 *
 * The rows arrive already grouped per flight with a `cabins` array (see
 * `availabilityRepository.search`), so nothing here re-shapes them; the service only
 * adds the party total, which is a presentation concern rather than a stored one.
 */
async function searchFlights({ origin, destination, departureDate, cabin = null, passengers = 1, limit = 25, offset = 0 }) {
  const result = await metrics.timeDb('read', 'flight_search', () =>
    availabilityRepository.search(pool.readReplicaPool, {
      origin,
      destination,
      departureDate,
      cabin: cabin ? String(cabin).toUpperCase() : null,
      passengers,
      limit,
      offset
    })
  );

  // Lag is read from the replica too: it is the freshness of the copy the caller
  // actually queried, not of the primary the projector writes to.
  const lagSeconds = await availabilityRepository.projectionLagSeconds(pool.readReplicaPool, {
    projection: 'flight_availability'
  });

  const flights = result.flights.map((flight) => ({
    ...flight,
    // The read model stores the *cabin* price, so the party total multiplies the
    // cheapest returned fare directly. Deriving it from a base price would mean
    // re-applying the cabin multiplier to a number that already has it applied — a
    // double-multiplied fare, which is the kind of bug a customer notices.
    totalPrice: flight.lowestPrice === null || flight.lowestPrice === undefined
      ? null
      : pricing.roundCents(Number(flight.lowestPrice) * passengers),
    seatsSufficient: flight.cabins.every((entry) => entry.availableSeats >= passengers)
  }));

  return {
    flights,
    total: result.total,
    limit,
    offset,
    passengers,
    freshness: {
      source: 'read_model',
      lagSeconds,
      note: 'Availability is eventually consistent; the booking endpoint is authoritative.'
    }
  };
}

/**
 * Resolves a flight by id, returning the row (and therefore the departure date).
 *
 * A flight id already identifies one flight on one date: the id is minted per
 * scheduled departure, so the date is not the second half of the key. Supplying it
 * lets the query prune to a single monthly partition and skip the others, which is
 * why `findById` is preferred when the caller knows it; the public single-flight
 * endpoints do not take a date, so when it is absent the row is read without one and
 * the date is taken from the row. Guessing it would be worse than useless — every
 * counter and booking lookup below is partitioned by that value.
 */
async function resolveFlight({ flightId, departureDate = null }) {
  const flight = departureDate
    ? await flightRepository.findById(pool.writePool, { flightId, departureDate })
    : await flightRepository.findAnyById(pool.writePool, { flightId });

  if (!flight) {
    throw new errors.NotFoundError('Flight not found', {
      flightId,
      departureDate: departureDate || null
    });
  }

  return flight;
}

/**
 * Flight detail from the write model, with authoritative per-cabin availability.
 *
 * Reads the counters directly rather than the projection. The projection exists to make
 * search cheap, not to be the truth.
 */
async function getFlight({ flightId, departureDate = null }) {
  const flight = await resolveFlight({ flightId, departureDate });

  const cabins = await inventoryService.getAvailability(pool.writePool, {
    flightId: flight.flightId,
    departureDate: flight.departureDate
  });

  return {
    ...serializeFlight(flight),
    cabins: cabins.map((cabin) => ({
      cabin: cabin.cabin,
      totalSeats: cabin.totalSeats,
      availableSeats: cabin.availableSeats,
      heldSeats: cabin.heldSeats,
      confirmedSeats: cabin.confirmedSeats,
      version: cabin.version,
      price: cabin.price,
      currency: cabin.currency
    }))
  };
}

/**
 * Authoritative availability straight from the counters.
 *
 * `version` is returned so a client can pass it back as `expectedVersion` and be told
 * when someone else changed the counter between its read and its write — the seat-map
 * UI's optimistic-concurrency loop. It is only available under the single-counter
 * strategy; with sharding the version belongs to a hidden row, and pretending otherwise
 * would be a lie the API can avoid telling.
 */
async function getAvailability({ flightId, departureDate = null, cabin = null }) {
  const flight = await resolveFlight({ flightId, departureDate });
  const departure = flight.departureDate;

  const rows = await inventoryService.getAvailability(pool.writePool, {
    flightId,
    departureDate: departure,
    cabin: cabin ? String(cabin).toUpperCase() : null
  });

  return {
    flightId,
    departureDate: departure,
    status: flight.status,
    departureTime: toIsoString(flight.departureTime),
    authoritative: true,
    versionPinningAvailable: env.INVENTORY_STRATEGY !== 'sharded',
    cabins: rows
  };
}

/**
 * The seat map: the aircraft's template minus the seats that are held or sold.
 *
 * Built by subtraction rather than by storing a row per seat. A seat row per flight
 * would be ~180 rows per flight and ~9 billion at 50M flights; the template is a few
 * thousand rows total and the taken set is at most the number of live bookings, which
 * is bounded by capacity. The response is the same either way.
 *
 * `taken` entries carry the booking status rather than the buyer: a seat map is public
 * information, and who is sitting in 14C is not.
 */
async function getSeatMap({ flightId, departureDate = null, cabin = null }) {
  const flight = await resolveFlight({ flightId, departureDate });
  const departure = flight.departureDate;

  if (!flight.aircraftType) {
    throw new errors.ValidationError('Flight has no aircraft type, so it has no seat map', { flightId });
  }

  const requestedCabin = cabin ? String(cabin).toUpperCase() : null;
  const template = await referenceRepository.listSeatTemplate(pool.writePool, {
    aircraftType: flight.aircraftType,
    cabin: requestedCabin
  });
  const taken = await bookingRepository.listTakenSeats(pool.writePool, {
    flightId,
    departureDate: departure,
    cabin: requestedCabin
  });

  const takenBySeat = new Map(taken.map((row) => [row.seatNumber, row]));
  const cabins = await inventoryService.getAvailability(pool.writePool, { flightId, departureDate: departure });

  const byCabin = new Map();
  for (const seat of template) {
    if (!byCabin.has(seat.cabin)) {
      const counter = cabins.find((entry) => entry.cabin === seat.cabin);
      byCabin.set(seat.cabin, {
        cabin: seat.cabin,
        columns: [],
        seats: [],
        totalSeats: 0,
        availableSeats: counter ? counter.availableSeats : null,
        price: counter ? counter.price : null,
        currency: counter ? counter.currency : flight.currency
      });
    }
    const group = byCabin.get(seat.cabin);
    group.totalSeats += 1;

    const occupant = takenBySeat.get(seat.seatNumber);
    group.seats.push({
      seatNumber: seat.seatNumber,
      row: Number(String(seat.seatNumber).replace(/\D/g, '')) || null,
      column: String(seat.seatNumber).replace(/[^A-Za-z]/g, '') || null,
      position: seat.seatPosition,
      isExitRow: Boolean(seat.isExitRow),
      // A seat with no occupant is not necessarily bookable — the cabin may be
      // oversubscribed by holds whose seats were never chosen. `availableSeats` on the
      // cabin is the number that decides, and `bookable` says so explicitly.
      status: occupant ? (occupant.status === 'PENDING' ? 'HELD' : 'OCCUPIED') : 'FREE',
      bookable: !occupant
    });

    const letter = String(seat.seatNumber).replace(/[^A-Za-z]/g, '');
    if (letter && !group.columns.includes(letter)) group.columns.push(letter);
  }

  for (const group of byCabin.values()) group.columns.sort();

  return {
    flightId,
    departureDate: departure,
    aircraftType: flight.aircraftType,
    cabins: Array.from(byCabin.values()),
    // Explicit because the map is per-seat and the counter is per-cabin: a cabin can
    // have free-looking seats and zero seats left to sell.
    note:
      'Seat status is per-seat; bookable seat count is the cabin availableSeats value. ' +
      'Seats not chosen by a passenger are assigned at check-in.'
  };
}

/**
 * Admin flight upsert, which is also how inventory gets created.
 *
 * Ordering matters here. The flight row and its counter rows are written in ONE
 * transaction, because a flight without counters is a flight nobody can book and a
 * counter without a flight is an orphan — and the outbox event is written in that same
 * transaction so the read model learns about it atomically with the change.
 *
 * `reseedInventory` exists because capacity can legitimately change (an equipment swap
 * from an A320 to a B777 adds seats). It only ever *raises* capacity, and never below
 * what is already sold or held: shrinking a cabin below its sold count would make the
 * audit's two equalities unsatisfiable, so the request is refused rather than silently
 * reducing a number that bookings depend on.
 */
async function upsertFlight(input, { createInventory = true, reseedInventory = false } = {}) {
  const flight = await pool.withTransaction(async (client) => {
    const saved = await flightRepository.upsert(client, {
      flightId: input.flightId || null,
      flightNumber: input.flightNumber,
      airlineCode: input.airlineCode,
      origin: String(input.origin).toUpperCase(),
      destination: String(input.destination).toUpperCase(),
      departureDate: input.departureDate,
      departureTime: input.departureTime,
      arrivalTime: input.arrivalTime,
      aircraftType: input.aircraftType,
      basePrice: input.basePrice,
      currency: input.currency || null,
      status: input.status || null
    });

    if (createInventory || reseedInventory) {
      const templateSizes = await referenceRepository.cabinSizes(client, { aircraftType: saved.aircraftType });
      if (templateSizes.length === 0) {
        throw new errors.ValidationError('Aircraft type has no seat-map template, so capacity is unknown', {
          aircraftType: saved.aircraftType,
          hint: 'Seed seat_map_templates for this aircraft type, or supply explicit cabin capacities.'
        });
      }

      const capacities = input.cabins && input.cabins.length > 0 ? input.cabins : templateSizes;

      if (reseedInventory) {
        for (const entry of capacities) {
          const seats = entry.seats !== undefined ? entry.seats : entry.totalSeats;
          const current = await inventoryRepository.getCabin(client, {
            flightId: saved.flightId,
            departureDate: saved.departureDate,
            cabin: entry.cabin
          });
          if (!current) continue;
          const soldOrHeld = current.totalSeats - current.availableSeats;
          if (seats < soldOrHeld) {
            throw new errors.ValidationError(
              'Cannot shrink cabin capacity below the seats already sold or held',
              { cabin: entry.cabin, requested: seats, soldOrHeld, currentCapacity: current.totalSeats }
            );
          }
        }
      }

      await inventoryService.ensureInventoryForFlight(client, {
        flightId: saved.flightId,
        departureDate: saved.departureDate,
        aircraftType: saved.aircraftType,
        basePrice: saved.basePrice,
        cabins: capacities
      });
    }

    const counters = await inventoryRepository.listCabins(client, {
      flightId: saved.flightId,
      departureDate: saved.departureDate
    });

    await outboxRepository.insert(client, {
      flightId: saved.flightId,
      departureDate: saved.departureDate,
      eventType: OUTBOX_EVENT_TYPES.FLIGHT_UPSERTED,
      aggregateId: saved.flightId,
      userId: null,
      payload: {
        flight: flightSnapshotForProjection(saved),
        cabins: counters.map((counter) => ({
          cabin: counter.cabin,
          totalSeats: counter.totalSeats,
          availableSeats: counter.availableSeats,
          heldSeats: counter.heldSeats,
          version: counter.version,
          price: priceForCabin({ basePrice: saved.basePrice, cabin: counter.cabin }),
          currency: saved.currency
        }))
      }
    });

    return { flight: saved, counters };
  });

  logger.info('Flight upserted', {
    flightId: flight.flight.flightId,
    departureDate: flight.flight.departureDate,
    aircraftType: flight.flight.aircraftType,
    cabins: flight.counters.length,
    reseedInventory
  });

  return {
    ...serializeFlight(flight.flight),
    // Whether this call inserted the flight or updated one that was already there.
    // Passed through because the admin endpoint reports it and nothing else can
    // reconstruct it after the fact.
    created: flight.flight.created === true,
    cabins: flight.counters.map((counter) => ({
      cabin: counter.cabin,
      totalSeats: counter.totalSeats,
      availableSeats: counter.availableSeats,
      heldSeats: counter.heldSeats,
      price: priceForCabin({ basePrice: flight.flight.basePrice, cabin: counter.cabin }),
      currency: flight.flight.currency
    }))
  };
}

/**
 * Cancels a flight.
 *
 * A flight with live bookings is refused. Cancelling it would leave bookings that are
 * CONFIRMED against a flight that will not operate, and the inventory counters would
 * still count them as sold — the audit would be right and the business would be wrong.
 * Refusing makes the operator deal with the passengers first, which is what a real
 * airline does anyway.
 */
async function cancelFlight({ flightId, departureDate, reason = 'FLIGHT_CANCELLED' }) {
  const flight = await flightRepository.findById(pool.writePool, { flightId, departureDate });
  if (!flight) {
    throw new errors.NotFoundError('Flight not found', { flightId, departureDate });
  }
  if (flight.status === 'CANCELLED') {
    return serializeFlight(flight);
  }

  const live = await pool.writePool.query(
    `SELECT count(*)::int AS n FROM bookings
      WHERE flight_id = $1 AND departure_date = $2 AND status IN ('PENDING', 'CONFIRMED')`,
    [flightId, departureDate]
  );
  if (Number(live.rows[0].n) > 0) {
    throw new errors.ValidationError('Flight has live bookings and cannot be cancelled', {
      flightId,
      departureDate,
      liveBookings: Number(live.rows[0].n)
    });
  }

  const updated = await pool.withTransaction(async (client) => {
    const saved = await flightRepository.updateStatus(client, { flightId, departureDate, status: 'CANCELLED' });
    await outboxRepository.insert(client, {
      flightId,
      departureDate,
      eventType: OUTBOX_EVENT_TYPES.FLIGHT_UPSERTED,
      aggregateId: flightId,
      userId: null,
      payload: {
        flight: { ...flightSnapshotForProjection(saved), status: 'CANCELLED' },
        cabins: []
      }
    });
    return saved;
  });

  logger.warn('Flight cancelled', { flightId, departureDate, reason });
  return serializeFlight(updated);
}

/** Upcoming flights by route, from the write model — used by the admin listing. */
async function listFlights({ origin = null, destination = null, departureDate = null, fromDate = null, toDate = null, limit = 50, offset = 0 }) {
  if (origin && destination && departureDate) {
    return flightRepository.listByRoute(pool.writePool, { origin, destination, departureDate, limit, offset });
  }
  const from = fromDate || departureDate || new Date().toISOString().slice(0, 10);
  const to = toDate || from;
  return flightRepository.listByDateRange(pool.writePool, { fromDate: from, toDate: to, limit, offset });
}

/** Reference data for the client: airlines, airports, aircraft types, cabins. */
async function getReferenceData() {
  const [airlines, airports, aircraftTypes, cabins] = await Promise.all([
    referenceRepository.listAirlines(pool.writePool),
    referenceRepository.listAirports(pool.writePool),
    referenceRepository.listAircraftTypes(pool.writePool),
    referenceRepository.listCabins(pool.writePool)
  ]);
  return { airlines, airports, aircraftTypes, cabins };
}

/**
 * Assigns a specific seat, or the best free one when none is requested.
 *
 * The seat is validated against the aircraft's template rather than accepted as free
 * text: taking a seat number the aircraft does not have would produce a booking nobody
 * can sit in. The unique index `uq_live_seat` is the real guarantee against two live
 * bookings on one seat; this check just gives a better error than a constraint
 * violation.
 */
async function assignSeat({ flightId, departureDate, bookingId, seatNumber = null, cabin = null }) {
  const booking = await bookingRepository.findById(pool.writePool, { flightId, departureDate, bookingId });
  if (!booking) {
    throw new errors.NotFoundError('Booking not found', { bookingId });
  }
  if (!['PENDING', 'CONFIRMED'].includes(booking.status)) {
    throw new errors.ValidationError('Cannot assign a seat to a booking that is not live', {
      bookingId,
      status: booking.status
    });
  }

  const flight = await flightRepository.findById(pool.writePool, { flightId, departureDate });
  if (!flight) {
    throw new errors.NotFoundError('Flight not found', { flightId, departureDate });
  }

  const targetCabin = cabin ? String(cabin).toUpperCase() : booking.cabin;
  const template = await referenceRepository.listSeatTemplate(pool.writePool, {
    aircraftType: flight.aircraftType,
    cabin: targetCabin
  });
  const taken = new Set(
    (await bookingRepository.listTakenSeats(pool.writePool, { flightId, departureDate, cabin: targetCabin }))
      .filter((row) => row.bookingId !== bookingId)
      .map((row) => row.seatNumber)
  );

  let chosen = seatNumber ? String(seatNumber).toUpperCase() : null;
  if (chosen) {
    const exists = template.some((seat) => seat.seatNumber === chosen);
    if (!exists) {
      throw new errors.ValidationError('That seat does not exist on this aircraft', {
        seatNumber: chosen,
        cabin: targetCabin,
        aircraftType: flight.aircraftType
      });
    }
    if (taken.has(chosen)) {
      throw new errors.SeatUnavailableError('Seat is already taken', { seatNumber: chosen, cabin: targetCabin });
    }
  } else {
    const free = template.find((seat) => !taken.has(seat.seatNumber));
    if (!free) {
      throw new errors.SoldOutError('No free seat remains in this cabin', { cabin: targetCabin, flightId });
    }
    chosen = free.seatNumber;
  }

  const updated = await pool.withTransaction(async (client) => {
    const saved = await bookingRepository.assignSeat(client, { flightId, departureDate, bookingId, seatNumber: chosen });
    if (!saved) {
      throw new errors.ValidationError('Booking is no longer live', { bookingId });
    }
    // The projection carries the seat number, so it has to hear about this. The event
    // type matches the booking's *current* status, which is what makes the projection
    // upsert idempotent rather than a status regression.
    await outboxRepository.insert(client, {
      flightId,
      departureDate,
      eventType:
        saved.status === 'CONFIRMED'
          ? OUTBOX_EVENT_TYPES.BOOKING_CONFIRMED
          : OUTBOX_EVENT_TYPES.BOOKING_RESERVED,
      aggregateId: saved.bookingId,
      userId: saved.userId,
      payload: {
        booking: {
          bookingId: saved.bookingId,
          bookingReference: saved.bookingReference,
          flightId: saved.flightId,
          departureDate: saved.departureDate,
          userId: saved.userId,
          cabin: saved.cabin,
          seatNumber: saved.seatNumber,
          passengerName: saved.passengerName,
          status: saved.status,
          price: saved.price,
          currency: saved.currency,
          createdAt: toIsoString(saved.createdAt)
        },
        flight: flightSnapshotForProjection(flight)
      }
    });
    return saved;
  });

  return updated;
}

module.exports = {
  searchFlights,
  getFlight,
  getAvailability,
  getSeatMap,
  upsertFlight,
  cancelFlight,
  listFlights,
  getReferenceData,
  assignSeat,
  serializeFlight,
  flightSnapshotForProjection
};
