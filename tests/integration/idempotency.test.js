'use strict';
/**
 * Idempotency, at both layers.
 *
 * The cache is the fast path and the database's partial unique index is the guarantee.
 * A test that only exercises the cache would pass while a cache eviction could still
 * create two bookings, so the suite deliberately deletes the cache record between the
 * two calls: the second request then reaches the unique index, and the service must
 * recognize the constraint violation as "the original succeeded" and replay it.
 *
 * A retry also must not re-authorize a card. The declined-payment case asserts that a
 * durable failure is recorded and replayed, not re-executed.
 */
const {
  createFlight,
  cleanupFlight,
  cabinAvailability,
  auditFlight,
  env,
  ids,
  pool,
  closePools
} = require('../helpers/db');
const bookingService = require('../../src/services/bookingService');
const cache = require('../../src/cache');

const createdFlights = [];

async function newFlight() {
  const fixture = await createFlight({
    cabins: [{ cabin: 'ECONOMY', totalSeats: 3 }]
  });
  createdFlights.push(fixture);
  return fixture;
}

function book({ flightId, idempotencyKey, ...rest }) {
  return bookingService.createBooking({
    userId: env.GUEST_USER_ID,
    flightId,
    cabin: 'ECONOMY',
    passengerName: 'Idempotency Passenger',
    idempotencyKey,
    ...rest
  });
}

function key() {
  return `itest-${ids.newUuid()}`;
}

/** Removes both keys the idempotency service writes, simulating a cache eviction. */
async function evict(keyValue) {
  const claim = cache.KEYS.IDEMPOTENCY('booking', keyValue);
  await cache.del(claim);
  await cache.del(`${claim}:record`);
}

afterEach(async () => {
  for (const fixture of createdFlights.splice(0)) {
    await cleanupFlight(fixture.flightId, fixture.departureDate);
  }
});

afterAll(async () => {
  await cache.close();
  await closePools();
});

describe('cache fast path', () => {
  test('an identical retry replays the original booking instead of selling a second seat', async () => {
    const { flightId, departureDate } = await newFlight();
    const idemKey = key();

    const first = await book({ flightId, idempotencyKey: idemKey });
    expect(first.statusCode).toBe(201);
    expect(first.replayed).toBe(false);

    const second = await book({ flightId, idempotencyKey: idemKey });
    expect(second.statusCode).toBe(200);
    expect(second.replayed).toBe(true);
    expect(second.booking.bookingId).toBe(first.booking.bookingId);
    expect(second.booking.bookingReference).toBe(first.booking.bookingReference);

    const bookings = await pool.writePool.query(
      'SELECT count(*)::int AS n FROM bookings WHERE flight_id = $1',
      [flightId]
    );
    expect(bookings.rows[0].n).toBe(1);

    const counter = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counter.availableSeats).toBe(2);
    expect(counter.confirmedSeats).toBe(1);
    expect(await auditFlight(flightId)).toEqual([]);
  });

  test('reusing a key with a different body is a 409, not a thoughtful wrong answer', async () => {
    const { flightId } = await newFlight();
    const idemKey = key();

    await book({ flightId, idempotencyKey: idemKey, passengerName: 'Original Passenger' });

    await expect(
      book({ flightId, idempotencyKey: idemKey, passengerName: 'Different Passenger' })
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      statusCode: 409
    });
  });
});

describe('database backstop', () => {
  test('a cache miss cannot create a second booking for the same key', async () => {
    const { flightId, departureDate } = await newFlight();
    const idemKey = key();

    const first = await book({ flightId, idempotencyKey: idemKey });

    // The eviction is the whole point: the cache has no memory of the first request,
    // so only the unique index on (flight_id, departure_date, idempotency_key) stands
    // between this retry and a double sale.
    await evict(idemKey);

    const recovered = await book({ flightId, idempotencyKey: idemKey });

    expect(recovered.replayed).toBe(true);
    expect(recovered.saga.recoveredFromDatabaseBackstop).toBe(true);
    expect(recovered.booking.bookingId).toBe(first.booking.bookingId);

    const bookings = await pool.writePool.query(
      'SELECT count(*)::int AS n FROM bookings WHERE flight_id = $1',
      [flightId]
    );
    expect(bookings.rows[0].n).toBe(1);

    const counter = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counter.availableSeats).toBe(2);
    expect(await auditFlight(flightId)).toEqual([]);
  });
});

describe('durable failure replay', () => {
  test('a declined payment is recorded and replayed without authorizing again', async () => {
    const { flightId, departureDate } = await newFlight();
    const idemKey = key();

    await expect(
      book({ flightId, idempotencyKey: idemKey, injectPaymentFailure: true })
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED', statusCode: 409 });

    // The retry must report the same failure. If it re-ran the saga it would create a
    // second payment authorization for a customer whose card was already declined.
    await expect(
      book({ flightId, idempotencyKey: idemKey, injectPaymentFailure: true })
    ).rejects.toMatchObject({ code: 'PAYMENT_FAILED', statusCode: 409 });

    const payments = await pool.writePool.query(
      'SELECT count(*)::int AS n FROM payments WHERE flight_id = $1',
      [flightId]
    );
    expect(payments.rows[0].n).toBe(1);

    const counter = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counter.availableSeats).toBe(3);
    expect(counter.heldSeats).toBe(0);
    expect(await auditFlight(flightId)).toEqual([]);
  });
});
