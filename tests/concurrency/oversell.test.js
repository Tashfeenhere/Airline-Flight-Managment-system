'use strict';
/**
 * Concurrency — the anti-oversell invariant. This is the one correctness claim the whole
 * design rests on (Deliverable 11; ARCHITECTURE §4): under contention, a (flight, cabin)
 * counter can never sell more than it has.
 *
 * N buyers hit ONE counter row at once. The conditional decrement
 * `UPDATE ... SET available_seats = available_seats - 1 WHERE available_seats >= 1`
 * takes a row lock and re-evaluates the predicate after winning it, so the buyers
 * serialise: exactly `capacity` win and every other sees `available_seats = 0` and is
 * refused. A mock cannot prove this — it would serialise calls in JavaScript and exercise
 * none of the row-locking/MVCC that makes the guarantee real — which is why this runs
 * against a live database.
 */
const {
  createFlight,
  cleanupFlight,
  cabinAvailability,
  auditFlight,
  closePools,
  env
} = require('../helpers/db');

const CAPACITY = 5;
const RACERS = 25;

describe('concurrency: anti-oversell on a single cabin counter', () => {
  let flightId;
  let departureDate;

  beforeAll(async () => {
    // A deliberately tiny cabin so a modest racer count straddles capacity: 25 buyers,
    // 5 seats, 20 guaranteed losers.
    const created = await createFlight({ cabins: [{ cabin: 'ECONOMY', totalSeats: CAPACITY }] });
    flightId = created.flightId;
    departureDate = created.departureDate;
  });

  afterAll(async () => {
    if (flightId) await cleanupFlight(flightId, departureDate);
    await closePools();
  });

  test(`exactly ${CAPACITY} of ${RACERS} concurrent bookings win; the rest are SOLD_OUT`, async () => {
    const bookingService = require('../../src/services/bookingService');

    const settled = await Promise.allSettled(
      Array.from({ length: RACERS }, (_, i) =>
        bookingService.createBooking({
          userId: env.GUEST_USER_ID,
          flightId,
          cabin: 'ECONOMY',
          passengerName: `Racer ${i}`
        })
      )
    );

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    // Exactly capacity succeeded, each a terminal CONFIRMED booking.
    expect(fulfilled).toHaveLength(CAPACITY);
    for (const s of fulfilled) {
      expect(s.value.statusCode).toBe(201);
      expect(s.value.booking.status).toBe('CONFIRMED');
    }

    // Every loser failed for the right business reason — a refused reservation, not a
    // crash or a constraint error leaking through.
    expect(rejected).toHaveLength(RACERS - CAPACITY);
    const reasons = [...new Set(rejected.map((s) => s.reason && s.reason.code))];
    expect(reasons).toEqual(['SOLD_OUT']);

    // The counter landed exactly at capacity sold — never oversold, never negative.
    const counter = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counter.availableSeats).toBe(0);
    expect(counter.heldSeats).toBe(0);
    expect(counter.confirmedSeats).toBe(CAPACITY);
    expect(counter.availableSeats).toBeGreaterThanOrEqual(0);
    expect(counter.availableSeats + counter.heldSeats).toBeLessThanOrEqual(counter.totalSeats);

    // The write model agrees with the bookings table: no HELD/CONFIRMED drift.
    expect(await auditFlight(flightId, departureDate)).toEqual([]);
  });

  test('a later wave against the sold-out cabin is all SOLD_OUT and moves nothing', async () => {
    const bookingService = require('../../src/services/bookingService');
    const before = await cabinAvailability(flightId, departureDate, 'ECONOMY');

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        bookingService.createBooking({
          userId: env.GUEST_USER_ID,
          flightId,
          cabin: 'ECONOMY',
          passengerName: `Late ${i}`
        })
      )
    );

    expect(settled.every((s) => s.status === 'rejected' && s.reason.code === 'SOLD_OUT')).toBe(true);
    expect(await cabinAvailability(flightId, departureDate, 'ECONOMY')).toEqual(before);
  });
});
