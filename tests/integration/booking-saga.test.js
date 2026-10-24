'use strict';
/**
 * The booking saga, end to end against PostgreSQL.
 *
 * These are the plan's consistency claims, stated as invariants rather than as log
 * lines: a confirmed booking has moved exactly one seat from available to confirmed;
 * a declined payment leaves the counter exactly as it found it; cancelling a paid
 * booking moves that seat back. `auditFlight` checks the two accounting equalities
 * (`available + held + confirmed = total`, and no negative counters) so a test fails
 * on a counter mismatch rather than only on the field it happened to assert.
 *
 * Payment failure is injected per call (`injectPaymentFailure`), never through the
 * global failure rate, so the other suites cannot fail at random and these tests do
 * not need to retry until they see a decline.
 */
const {
  createFlight,
  cleanupFlight,
  cabinAvailability,
  auditFlight,
  env,
  pool,
  closePools
} = require('../helpers/db');
const bookingService = require('../../src/services/bookingService');

const createdFlights = [];

async function newFlight(overrides = {}) {
  const fixture = await createFlight({
    // Small cabins keep the arithmetic obvious and fast.
    cabins: [
      { cabin: 'ECONOMY', totalSeats: 3 },
      { cabin: 'BUSINESS', totalSeats: 2 }
    ],
    ...overrides
  });
  createdFlights.push(fixture);
  return fixture;
}

function book({ flightId, cabin = 'ECONOMY', ...rest }) {
  return bookingService.createBooking({
    userId: env.GUEST_USER_ID,
    flightId,
    cabin,
    passengerName: 'Saga Test Passenger',
    ...rest
  });
}

afterEach(async () => {
  for (const fixture of createdFlights.splice(0)) {
    await cleanupFlight(fixture.flightId, fixture.departureDate);
  }
});

afterAll(async () => {
  await closePools();
});

describe('successful booking', () => {
  test('reserves, captures and confirms in one saga; the counter accounts for it exactly', async () => {
    const { flightId } = await newFlight();

    const result = await book({ flightId });

    expect(result.replayed).toBe(false);
    expect(result.statusCode).toBe(201);
    expect(result.booking.status).toBe('CONFIRMED');
    expect(result.booking.confirmedAt).toEqual(expect.any(String));
    expect(result.booking.payment.status).toBe('CAPTURED');
    // The payment records the last saga step it completed; confirmation is the
    // booking's transition, not a second payment write.
    expect(result.booking.payment.sagaState).toBe('CAPTURED');

    const counter = await cabinAvailability(flightId, result.booking.departureDate, 'ECONOMY');
    expect(counter.totalSeats).toBe(3);
    expect(counter.availableSeats).toBe(2);
    // A confirmed seat is no longer "held": held is only the PENDING window.
    expect(counter.heldSeats).toBe(0);
    expect(counter.confirmedSeats).toBe(1);

    expect(await auditFlight(flightId)).toEqual([]);
  });

  test('lazy seat assignment: no physical seat is consumed until one is requested', async () => {
    const { flightId } = await newFlight();

    const result = await book({ flightId });

    // The plan's count-based inventory deliberately does not allocate a seat row per
    // sale; `seat_number` stays NULL until the customer picks one.
    expect(result.booking.seatNumber).toBeNull();

    const seatMap = await require('../../src/services/flightService').getSeatMap({ flightId });
    const economy = seatMap.cabins.find((entry) => entry.cabin === 'ECONOMY');
    // The map still shows every template seat as free, because the count, not a
    // per-seat row, is what reserves capacity.
    expect(economy.seats.every((seat) => seat.status === 'FREE')).toBe(true);
    expect(economy.availableSeats).toBe(2);
  });
});

describe('specific-seat booking', () => {
  test('stores the requested seat and refuses it to a second live booking', async () => {
    const { flightId } = await newFlight();

    const first = await book({ flightId, seatNumber: '1A' });
    expect(first.booking.seatNumber).toBe('1A');

    await expect(book({ flightId, seatNumber: '1A' })).rejects.toMatchObject({
      code: 'SEAT_UNAVAILABLE',
      statusCode: 409
    });

    const counter = await cabinAvailability(flightId, first.booking.departureDate, 'ECONOMY');
    // The failed attempt rolled back its reservation too.
    expect(counter.availableSeats).toBe(2);
    expect(counter.confirmedSeats).toBe(1);
    expect(await auditFlight(flightId)).toEqual([]);
  });
});

describe('payment failure compensation', () => {
  test('a declined authorization cancels the booking and returns the seat immediately', async () => {
    const { flightId, departureDate } = await newFlight();

    let failure = null;
    try {
      await book({ flightId, injectPaymentFailure: true });
    } catch (err) {
      failure = err;
    }

    expect(failure).not.toBeNull();
    expect(failure.code).toBe('PAYMENT_FAILED');
    expect(failure.statusCode).toBe(409);
    expect(failure.booking.status).toBe('CANCELLED');

    const stored = await bookingService.getBooking({ bookingId: failure.booking.bookingId });
    expect(stored.status).toBe('CANCELLED');
    expect(stored.cancellationReason).toBe('PAYMENT_INJECTED_FAILURE');
    expect(stored.payment.status).toBe('FAILED');
    expect(stored.payment.failureReason).toBe('INJECTED_FAILURE');

    // Compensation is the point: the seats are back BEFORE the hold TTL would expire.
    const counter = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counter.availableSeats).toBe(3);
    expect(counter.heldSeats).toBe(0);
    expect(counter.confirmedSeats).toBe(0);
    expect(await auditFlight(flightId)).toEqual([]);

    // The cancellation is durable and observable to the read-model pipeline.
    const events = await pool.writePool.query(
      'SELECT event_type FROM booking_outbox WHERE flight_id = $1 ORDER BY created_at',
      [flightId]
    );
    const types = events.rows.map((row) => row.event_type);
    expect(types).toContain('BOOKING_RESERVED');
    expect(types).toContain('BOOKING_CANCELLED');
    expect(types).not.toContain('BOOKING_CONFIRMED');
  });
});

describe('cancellation', () => {
  test('cancelling a CONFIRMED booking reclaims the seat and refunds the capture', async () => {
    const { flightId, departureDate } = await newFlight();
    const created = await book({ flightId });

    const counterAfterBooking = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counterAfterBooking.availableSeats).toBe(2);

    const cancelled = await bookingService.cancelBooking({
      bookingId: created.booking.bookingId,
      userId: env.GUEST_USER_ID,
      isAdmin: false,
      reason: 'USER_CANCELLED'
    });

    expect(cancelled.booking.status).toBe('CANCELLED');
    expect(cancelled.booking.payment.status).toBe('REFUNDED');

    const counterAfterCancel = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counterAfterCancel.availableSeats).toBe(3);
    expect(counterAfterCancel.heldSeats).toBe(0);
    expect(counterAfterCancel.confirmedSeats).toBe(0);
    expect(await auditFlight(flightId)).toEqual([]);
  });

  test('another user cannot cancel the booking (the service refuses)', async () => {
    const { flightId } = await newFlight();
    const created = await book({ flightId });

    await expect(
      bookingService.cancelBooking({
        bookingId: created.booking.bookingId,
        userId: '00000000-0000-7000-8000-00000000beef',
        isAdmin: false
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const stored = await bookingService.getBooking({ bookingId: created.booking.bookingId });
    expect(stored.status).toBe('CONFIRMED');
  });
});

describe('optimistic concurrency', () => {
  test('a stale expectedVersion is rejected without touching the counter', async () => {
    const { flightId, departureDate } = await newFlight();
    const initial = await cabinAvailability(flightId, departureDate, 'ECONOMY');

    await book({ flightId, expectedVersion: initial.version });

    await expect(book({ flightId, expectedVersion: initial.version })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409
    });

    const counter = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counter.availableSeats).toBe(2);
    expect(counter.confirmedSeats).toBe(1);
    expect(await auditFlight(flightId)).toEqual([]);
  });
});

describe('sold-out boundary', () => {
  test('the counter never goes negative when demand exceeds capacity', async () => {
    const { flightId, departureDate } = await newFlight();

    const first = await book({ flightId });
    const second = await book({ flightId });
    const third = await book({ flightId });
    for (const result of [first, second, third]) {
      expect(result.booking.status).toBe('CONFIRMED');
    }

    await expect(book({ flightId })).rejects.toMatchObject({ code: 'SOLD_OUT' });

    const counter = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counter.availableSeats).toBe(0);
    expect(counter.confirmedSeats).toBe(3);
    expect(await auditFlight(flightId)).toEqual([]);
  });
});
