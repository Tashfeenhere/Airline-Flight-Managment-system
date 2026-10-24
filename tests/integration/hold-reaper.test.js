'use strict';
/**
 * The hold reaper — the worker that makes `BOOKING_HOLD_TTL_SECONDS` a real bound.
 *
 * The interesting case is not "an abandoned hold is expired"; it is the interaction
 * between expiry and payment settlement. These tests therefore drive the two paths
 * separately:
 *
 *   - a genuinely abandoned PENDING hold is expired and its seat returns;
 *   - a PENDING hold whose payment was CAPTURED is left alone, because the customer
 *     has paid and the reconciler must roll the booking forward instead.
 *
 * The claim `PENDING -> EXPIRED WHERE hold_expires_at < now()` is also asserted to be
 * single-shot: a second pass cannot credit the same seat twice.
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
const holdReaper = require('../../src/workers/holdReaper');
const bookingRepository = require('../../src/repositories/bookingRepository');
const paymentRepository = require('../../src/repositories/paymentRepository');
const inventoryService = require('../../src/services/inventoryService');

const createdFlights = [];

async function newFlight() {
  const fixture = await createFlight({
    cabins: [{ cabin: 'ECONOMY', totalSeats: 2 }]
  });
  createdFlights.push(fixture);
  return fixture;
}

/**
 * Writes exactly what the saga writes in its first transaction: a reservation plus a
 * PENDING booking whose hold has already elapsed. Going through the service is not an
 * option because the inline saga confirms immediately; the point of this fixture is to
 * reproduce the state a crash between reserve and pay leaves behind.
 */
async function createExpiredHold({ flightId, departureDate, cabin = 'ECONOMY', paymentStatus = null }) {
  const bookingId = ids.newUuid();
  const paymentId = ids.newUuid();
  const holdExpiresAt = new Date(Date.now() - 5 * 60 * 1000);

  await pool.withTransaction(async (client) => {
    const reservation = await inventoryService.reserveSeat(client, {
      flightId,
      departureDate,
      cabin,
      count: 1
    });
    expect(reservation.reserved).toBe(true);

    await bookingRepository.insert(client, {
      bookingId,
      bookingReference: ids.generateBookingReference(),
      flightId,
      departureDate,
      userId: env.GUEST_USER_ID,
      cabin,
      inventoryShard: reservation.shardNo,
      seatNumber: null,
      passengerName: 'Reaper Fixture',
      status: 'PENDING',
      price: 10000,
      currency: 'USD',
      holdExpiresAt,
      nodeId: env.NODE_ID,
      transactionId: ids.newUuid(),
      paymentId
    });

    await paymentRepository.insert(client, {
      paymentId,
      flightId,
      departureDate,
      bookingId,
      amount: 10000,
      currency: 'USD',
      status: 'PENDING',
      sagaState: 'RESERVED'
    });

    if (paymentStatus === 'CAPTURED') {
      const captured = await paymentRepository.markCaptured(client, {
        flightId,
        departureDate,
        paymentId,
        providerReference: 'SIM-AUTH-REAPER-FIXTURE'
      });
      expect(captured.status).toBe('CAPTURED');
    }
  });

  return { bookingId, paymentId };
}

afterEach(async () => {
  for (const fixture of createdFlights.splice(0)) {
    await cleanupFlight(fixture.flightId, fixture.departureDate);
  }
});

afterAll(async () => {
  await closePools();
});

describe('abandoned hold', () => {
  test('runOnce expires an elapsed PENDING hold and returns its seat exactly once', async () => {
    const { flightId, departureDate } = await newFlight();
    const { bookingId } = await createExpiredHold({ flightId, departureDate });

    const before = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(before.availableSeats).toBe(1);
    expect(before.heldSeats).toBe(1);

    const pass = await holdReaper.runOnce({ limit: 100 });
    expect(pass.failed).toBe(0);
    expect(pass.expired).toBeGreaterThanOrEqual(1);

    const stored = await bookingService.getBooking({ bookingId });
    expect(stored.status).toBe('EXPIRED');
    expect(stored.cancellationReason).toBe('HOLD_EXPIRED');

    const after = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(after.availableSeats).toBe(2);
    expect(after.heldSeats).toBe(0);
    expect(after.confirmedSeats).toBe(0);

    // A second pass must not find it: the row is no longer PENDING, and re-releasing
    // the seat would inflate availability above capacity.
    const beforeSecondPass = after.availableSeats;
    await holdReaper.runOnce({ limit: 100 });
    const afterSecondPass = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(afterSecondPass.availableSeats).toBe(beforeSecondPass);
    expect(afterSecondPass.heldSeats).toBe(0);

    expect(await auditFlight(flightId)).toEqual([]);
  });

  test('emits BOOKING_EXPIRED and INVENTORY_CHANGED for the projection', async () => {
    const { flightId, departureDate } = await newFlight();
    const { bookingId } = await createExpiredHold({ flightId, departureDate });

    await holdReaper.expireHold({ flightId, departureDate, bookingId });

    const { rows } = await pool.writePool.query(
      'SELECT event_type FROM booking_outbox WHERE flight_id = $1 ORDER BY created_at',
      [flightId]
    );
    const types = rows.map((row) => row.event_type);
    expect(types).toContain('BOOKING_EXPIRED');
    expect(types).toContain('INVENTORY_CHANGED');
  });
});

describe('settled payment safety', () => {
  test('a CAPTURED payment protects the hold from the reaper', async () => {
    const { flightId, departureDate } = await newFlight();
    const { bookingId } = await createExpiredHold({
      flightId,
      departureDate,
      paymentStatus: 'CAPTURED'
    });

    // The direct seam, so the assertion is about the decision rather than about
    // whatever else happened to be due in the same scan.
    const outcome = await holdReaper.expireHold({ flightId, departureDate, bookingId });
    expect(outcome).toEqual({ expired: false, skipped: true, reason: 'PAYMENT_CAPTURED' });

    const stored = await bookingService.getBooking({ bookingId });
    expect(stored.status).toBe('PENDING');
    // The seat stays reserved for the paid customer; the saga reconciler will confirm.
    const counter = await cabinAvailability(flightId, departureDate, 'ECONOMY');
    expect(counter.heldSeats).toBe(1);
    expect(counter.availableSeats).toBe(1);
    expect(await auditFlight(flightId)).toEqual([]);
  });
});
