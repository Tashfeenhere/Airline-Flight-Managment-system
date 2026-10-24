/**
 * The caller's own bookings, served from the `user_bookings` projection.
 *
 * This is the one endpoint whose freshness cannot be described by the global outbox
 * lag: a user who has just booked wants to know whether *their* booking is visible
 * yet, and a cluster-wide number would answer a different question. So the lag
 * reported here is the age of the newest event reflected in this user's own rows.
 */
const pool = require('../db/pool');
const userBookingsRepository = require('../repositories/userBookingsRepository');
const metrics = require('../observability/metrics');
const { ok, lagHeader } = require('../http/respond');

async function listMyBookings(req, res) {
  const { userId } = req.user;
  const limit = req.query.limit === undefined ? 20 : req.query.limit;
  const offset = req.query.offset === undefined ? 0 : req.query.offset;
  const status = req.query.status || null;

  const result = await metrics.timeDb('read', 'user_bookings_list', () =>
    userBookingsRepository.listByUser(pool.writePool, { userId, status, limit, offset })
  );

  const latestEventAt = await userBookingsRepository.latestEventAt(pool.writePool, { userId });
  // Null means this user has no projected rows at all, which is answered by omitting
  // the lag rather than by reporting zero. Zero would claim the projection is perfectly
  // fresh — and a user whose very first booking has not been projected yet would read
  // "0ms lag, no bookings" as "your booking did not happen", when the honest answer is
  // that nothing about them has been projected yet.
  const lagMs = latestEventAt === null
    ? null
    : Math.max(0, Date.now() - new Date(latestEventAt).getTime());

  if (lagMs !== null) lagHeader(res, lagMs / 1000);

  return ok(res, {
    bookings: result.bookings.map(toMyBooking),
    pagination: {
      limit,
      offset,
      total: result.total,
      hasMore: offset + result.bookings.length < result.total
    },
    ...(lagMs === null ? {} : { readModelLagMs: lagMs })
  });
}

/**
 * A `user_bookings` row in the documented shape.
 *
 * The projection carries `lastEventAt` and `userId` for its own bookkeeping — the
 * first is how the lag above is computed, the second is the shard key — and neither
 * is part of the contract. `lastEventAt` would be actively misleading here: it is the
 * projection's watermark, and the client already has `updatedAt` for "when did this
 * booking last change".
 */
function toMyBooking(row) {
  return {
    bookingId: row.bookingId,
    bookingReference: row.bookingReference,
    flightId: row.flightId,
    flightNumber: row.flightNumber,
    airlineCode: row.airlineCode,
    origin: row.origin,
    destination: row.destination,
    departureDate: row.departureDate,
    departureTime: row.departureTime,
    cabin: row.cabin,
    seatNumber: row.seatNumber,
    passengerName: row.passengerName,
    status: row.status,
    price: row.price,
    currency: row.currency,
    bookingCreatedAt: row.bookingCreatedAt,
    updatedAt: row.updatedAt
  };
}

module.exports = { listMyBookings, toMyBooking };
