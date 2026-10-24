'use strict';
/**
 * Concurrency — at most one live booking per specific seat (Deliverable 11; ARCHITECTURE §3).
 *
 * Capacity is deliberately NOT the limiter here (the cabin is full-size): the limiter is
 * the `uq_live_seat` partial unique index, one live (PENDING/CONFIRMED) booking per
 * (flight, departure_date, seat_number). N buyers all demand the same seat; the index
 * lets exactly one win, and the rest surface as SEAT_UNAVAILABLE — the raw 23505 is
 * translated by the service, never leaked as a 500. Each loser's reservation is in the
 * same transaction as its failed insert, so the rollback returns its seat to the counter
 * and leaves exactly one taken.
 */
const {
  createFlight,
  cleanupFlight,
  cabinAvailability,
  auditFlight,
  closePools,
  env
} = require('../helpers/db');

const RACERS = 10;
const SEAT = '12A';

describe('concurrency: at most one live booking per seat', () => {
  let flightId;
  let departureDate;

  beforeAll(async () => {
    // Full A320 ECONOMY, so the seat — not capacity — is the only thing that can block.
    const created = await createFlight();
    flightId = created.flightId;
    departureDate = created.departureDate;
  });

  afterAll(async () => {
    if (flightId) await cleanupFlight(flightId, departureDate);
    await closePools();
  });

  test(`${RACERS} buyers race for ${SEAT}; exactly one wins, the rest are SEAT_UNAVAILABLE`, async () => {
    const bookingService = require('../../src/services/bookingService');
    const flightService = require('../../src/services/flightService');

    const settled = await Promise.allSettled(
      Array.from({ length: RACERS }, (_, i) =>
        bookingService.createBooking({
          userId: env.GUEST_USER_ID,
          flightId,
          cabin: 'ECONOMY',
          passengerName: `Seat racer ${i}`,
          seatNumber: SEAT
        })
      )
    );

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    // Exactly one holder of the seat.
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value.booking.seatNumber).toBe(SEAT);
    expect(fulfilled[0].value.booking.status).toBe('CONFIRMED');

    // Everyone else was told the seat is gone — not handed a 500.
    expect(rejected).toHaveLength(RACERS - 1);
    expect([...new Set(rejected.map((s) => s.reason && s.reason.code))]).toEqual(['SEAT_UNAVAILABLE']);

    // Exactly one seat consumed; the rolled-back losers left no held residue, no drift.
    const counter = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counter.confirmedSeats).toBe(1);
    expect(counter.heldSeats).toBe(0);
    expect(await auditFlight(flightId, departureDate)).toEqual([]);

    // The public seat map shows the one winner as taken.
    const map = await flightService.getSeatMap({ flightId, departureDate, cabin: 'ECONOMY' });
    const economy = map.cabins.find((c) => c.cabin === 'ECONOMY');
    const seat = economy.seats.find((s) => s.seatNumber === SEAT);
    expect(seat.status).toBe('OCCUPIED');
  });
});
