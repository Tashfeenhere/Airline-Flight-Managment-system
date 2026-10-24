'use strict';
/**
 * The outbox -> read-model pipeline, projected against both databases.
 *
 * The delivery protocol is "project, then mark published", which permits at-least-once
 * delivery. The tests here verify the two consequences that matter:
 *
 *   1. A booking's events become visible in search and in `user_bookings` after one
 *      drain, with no join back into the write model.
 *   2. Replaying an OLDER event — what a retry or a late batch does — cannot move a
 *      projection backwards. The guarded upserts are the only thing standing between
 *      at-least-once and "the read model shows a confirmed booking as pending".
 *
 * `drainOutbox` consumes the whole pending list rather than one flight's slice,
 * because that is exactly what the worker does; the assertions are all scoped to the
 * fresh flight this file created.
 */
const {
  createFlight,
  cleanupFlight,
  drainOutbox,
  env,
  pool,
  closePools
} = require('../helpers/db');
const bookingService = require('../../src/services/bookingService');
const flightService = require('../../src/services/flightService');
const projectionService = require('../../src/services/projectionService');
const userBookingsRepository = require('../../src/repositories/userBookingsRepository');

const createdFlights = [];

async function newFlight() {
  const fixture = await createFlight({
    cabins: [{ cabin: 'ECONOMY', totalSeats: 3 }]
  });
  createdFlights.push(fixture);
  return fixture;
}

function book(flightId) {
  return bookingService.createBooking({
    userId: env.GUEST_USER_ID,
    flightId,
    cabin: 'ECONOMY',
    passengerName: 'Projection Passenger'
  });
}

/** The read-model row for one flight+cabin, if it exists. */
async function readModelRow(flightId, cabin = 'ECONOMY') {
  const { rows } = await pool.readPool.query(
    `SELECT flight_id, cabin, total_seats, available_seats, held_seats, source_version
       FROM flight_availability
      WHERE flight_id = $1 AND cabin = $2`,
    [flightId, cabin]
  );
  return rows[0] || null;
}

/** Raw outbox rows for a flight, in the order a projector would see them. */
async function outboxRows(flightId) {
  const { rows } = await pool.writePool.query(
    `SELECT event_id, event_type, payload, user_id, aggregate_id, flight_id,
            departure_date, created_at
       FROM booking_outbox
      WHERE flight_id = $1
      ORDER BY created_at, event_id`,
    [flightId]
  );
  return rows;
}

afterEach(async () => {
  for (const fixture of createdFlights.splice(0)) {
    await cleanupFlight(fixture.flightId, fixture.departureDate);
  }
});

afterAll(async () => {
  await closePools();
});

describe('flight upsert projection', () => {
  test('a new flight becomes searchable with its cabin counters', async () => {
    const { flightId, departureDate } = await newFlight();

    const drain = await drainOutbox();
    expect(drain.projected).toBeGreaterThanOrEqual(1);

    const row = await readModelRow(flightId);
    expect(row).not.toBeNull();
    expect(row.total_seats).toBe(3);
    expect(row.available_seats).toBe(3);
    expect(row.held_seats).toBe(0);

    const search = await flightService.searchFlights({
      origin: 'DEL',
      destination: 'BOM',
      departureDate
    });
    const match = search.flights.find((flight) => flight.flightId === flightId);
    expect(match).toBeDefined();
    const economy = match.cabins.find((cabin) => cabin.cabin === 'ECONOMY');
    expect(economy.availableSeats).toBe(3);

    // The freshness watermark is written in the same projection as the row.
    const state = await pool.readPool.query(
      `SELECT last_event_at FROM projection_state WHERE projection = 'flight_availability'`
    );
    expect(state.rows[0].last_event_at).not.toBeNull();
  });
});

describe('booking projection', () => {
  test('confirmation reaches search and user_bookings after one drain', async () => {
    const { flightId, departureDate } = await newFlight();

    const created = await book(flightId);
    expect(created.booking.status).toBe('CONFIRMED');

    const drain = await drainOutbox();
    expect(drain.projected).toBeGreaterThanOrEqual(1);

    const row = await readModelRow(flightId);
    expect(row.available_seats).toBe(2);
    expect(row.held_seats).toBe(0);

    const search = await flightService.searchFlights({
      origin: 'DEL',
      destination: 'BOM',
      departureDate
    });
    const match = search.flights.find((flight) => flight.flightId === flightId);
    expect(match.cabins.find((cabin) => cabin.cabin === 'ECONOMY').availableSeats).toBe(2);

    // `user_bookings` is sharded by user_id and is the only correct place for
    // "my bookings" to read: the authoritative table is sharded by flight.
    const projected = await userBookingsRepository.listByUser(pool.writePool, {
      userId: env.GUEST_USER_ID,
      limit: 200
    });
    const entry = projected.bookings.find((booking) => booking.bookingId === created.booking.bookingId);
    expect(entry).toBeDefined();
    expect(entry.status).toBe('CONFIRMED');
    expect(entry.flightId).toBe(flightId);

    const pending = await pool.writePool.query(
      'SELECT count(*)::int AS n FROM booking_outbox WHERE flight_id = $1 AND published = false',
      [flightId]
    );
    expect(pending.rows[0].n).toBe(0);
  });
});

describe('out-of-order delivery', () => {
  test('replaying an older BOOKING_RESERVED cannot revert a CONFIRMED projection', async () => {
    const { flightId } = await newFlight();
    const created = await book(flightId);
    await drainOutbox();

    const rows = await outboxRows(flightId);
    const reserved = rows.find((row) => row.event_type === 'BOOKING_RESERVED');
    expect(reserved).toBeDefined();
    expect(reserved.payload.booking.status).toBe('PENDING');

    // Deliver it again, exactly as an at-least-once broker would.
    const applied = await projectionService.applyEvent(
      { writeClient: pool.writePool, readClient: pool.readPool },
      {
        eventId: reserved.event_id,
        eventType: reserved.event_type,
        payload: reserved.payload,
        userId: reserved.user_id,
        aggregateId: reserved.aggregate_id,
        flightId: reserved.flight_id,
        departureDate: reserved.departure_date,
        createdAt: reserved.created_at
      }
    );

    expect(applied[0]).toMatchObject({ projection: 'user_bookings', applied: false });

    const projected = await userBookingsRepository.listByUser(pool.writePool, {
      userId: env.GUEST_USER_ID,
      limit: 200
    });
    const entry = projected.bookings.find((booking) => booking.bookingId === created.booking.bookingId);
    expect(entry.status).toBe('CONFIRMED');
  });

  test('an older counter snapshot cannot overwrite fresher availability', async () => {
    const { flightId } = await newFlight();
    await book(flightId);
    await drainOutbox();

    const before = await readModelRow(flightId);
    expect(before.available_seats).toBe(2);

    const rows = await outboxRows(flightId);
    const olderInventory = rows.find((row) => row.event_type === 'INVENTORY_CHANGED');
    expect(olderInventory).toBeDefined();

    const applied = await projectionService.applyEvent(
      { writeClient: pool.writePool, readClient: pool.readPool },
      {
        eventId: olderInventory.event_id,
        eventType: olderInventory.event_type,
        payload: olderInventory.payload,
        userId: olderInventory.user_id,
        aggregateId: olderInventory.aggregate_id,
        flightId: olderInventory.flight_id,
        departureDate: olderInventory.departure_date,
        createdAt: olderInventory.created_at
      }
    );

    expect(applied.some((entry) => entry.projection === 'flight_availability')).toBe(true);

    const after = await readModelRow(flightId);
    expect(after.available_seats).toBe(before.available_seats);
    expect(after.held_seats).toBe(before.held_seats);
    expect(Number(after.source_version)).toBeGreaterThanOrEqual(Number(before.source_version));
  });
});

describe('repair', () => {
  test('reprojecting a flight rebuilds a lost read-model row from the outbox', async () => {
    const { flightId, departureDate } = await newFlight();
    const created = await book(flightId);
    await drainOutbox();

    await pool.readPool.query('DELETE FROM flight_availability WHERE flight_id = $1', [flightId]);
    expect(await readModelRow(flightId)).toBeNull();

    const result = await projectionService.reprojectAvailability({
      flightIds: [flightId],
      since: new Date('2000-01-01T00:00:00.000Z'),
      until: new Date(Date.now() + 60 * 1000)
    });
    expect(result.projected).toBeGreaterThanOrEqual(2);

    const rebuilt = await readModelRow(flightId);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt.available_seats).toBe(2);
    expect(rebuilt.held_seats).toBe(0);

    // The per-user projection can be rebuilt from the authoritative booking table too.
    const repaired = await projectionService.reprojectUser({ userId: env.GUEST_USER_ID });
    expect(repaired.scanned).toBeGreaterThanOrEqual(1);

    const projected = await userBookingsRepository.listByUser(pool.writePool, {
      userId: env.GUEST_USER_ID,
      limit: 200
    });
    const entry = projected.bookings.find((booking) => booking.bookingId === created.booking.bookingId);
    expect(entry.status).toBe('CONFIRMED');
    expect(entry.departureDate).toBe(departureDate);
  });
});
