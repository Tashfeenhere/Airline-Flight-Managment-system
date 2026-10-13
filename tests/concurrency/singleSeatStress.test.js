const request = require('supertest');
const app = require('../../src/app');
const Flight = require('../../src/models/flight.model');
const Seat = require('../../src/models/seat.model');
const Booking = require('../../src/models/booking.model');
const {
  setupTestDB,
  teardownTestDB,
  clearTestDB,
  seedTestFlightAndSeats
} = require('../setup');

describe('Critical Concurrency Test: 100 Concurrent Booking Attempts on the Same Flight & Seat', () => {
  let seeded;

  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    seeded = await seedTestFlightAndSeats();
  });

  it('MUST permit EXACTLY 1 confirmed booking and reject all other 99 attempts when 100 requests race for Seat 12A', async () => {
    const CONCURRENT_REQUESTS = 100;
    const flightId = seeded.flight._id.toString();
    const seatNumber = '12A';
    const initialAvailable = seeded.flight.availableSeats;

    console.log(`[CONCURRENCY_TEST] Launching ${CONCURRENT_REQUESTS} simultaneous booking requests for PK123 Seat 12A...`);

    // Prepare 100 concurrent HTTP requests
    const promises = Array.from({ length: CONCURRENT_REQUESTS }, (_, index) => {
      const passengerId = `PASSENGER-CONCURRENT-${String(index + 1).padStart(3, '0')}`;
      return request(app)
        .post('/api/bookings')
        .send({
          flightId,
          seatNumber,
          passengerId
        });
    });

    // Execute all 100 requests in parallel to stress optimistic concurrency control
    const results = await Promise.allSettled(promises);

    const successfulResponses = [];
    const conflictResponses = [];
    const otherResponses = [];

    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        const res = r.value;
        if (res.status === 201) {
          successfulResponses.push(res.body);
        } else if (res.status === 409) {
          conflictResponses.push(res.body);
        } else {
          otherResponses.push({ status: res.status, body: res.body });
        }
      } else {
        otherResponses.push({ error: r.reason });
      }
    });

    console.log(`[CONCURRENCY_TEST] Results: Successes=${successfulResponses.length}, Conflicts(409)=${conflictResponses.length}, Other=${otherResponses.length}`);

    // CRITICAL ASSERTION 1: Exactly 1 HTTP request succeeded
    expect(successfulResponses.length).toBe(1);

    // CRITICAL ASSERTION 2: Exactly 99 HTTP requests were rejected with 409 Conflict
    expect(conflictResponses.length).toBe(CONCURRENT_REQUESTS - 1);
    expect(otherResponses.length).toBe(0);

    const winningBooking = successfulResponses[0].data;
    expect(winningBooking.seatNumber).toBe('12A');
    expect(winningBooking.status).toBe('CONFIRMED');

    // CRITICAL ASSERTION 3: Query MongoDB directly to verify authoritative inventory state
    const confirmedBookingsInDb = await Booking.find({
      flightId: seeded.flight._id,
      seatNumber: '12A',
      status: 'CONFIRMED'
    });

    // INVARIANT: confirmed bookings for PK123 / 12A = EXACTLY 1
    expect(confirmedBookingsInDb.length).toBe(1);
    expect(confirmedBookingsInDb[0]._id.toString()).toBe(winningBooking._id.toString());
    expect(confirmedBookingsInDb[0].bookingReference).toBe(winningBooking.bookingReference);

    // CRITICAL ASSERTION 4: Verify Seat status and version in database
    const seatInDb = await Seat.findOne({
      flightId: seeded.flight._id,
      seatNumber: '12A'
    });

    expect(seatInDb.status).toBe('BOOKED');
    expect(seatInDb.version).toBe(1); // Increment count must be EXACTLY 1
    expect(seatInDb.bookingId.toString()).toBe(winningBooking._id.toString());

    // CRITICAL ASSERTION 5: Verify Flight availableSeats count is decremented by EXACTLY 1
    const flightInDb = await Flight.findById(seeded.flight._id);
    expect(flightInDb.availableSeats).toBe(initialAvailable - 1);
  }, 45000); // 45s timeout for 100 concurrent transaction cycles
});
