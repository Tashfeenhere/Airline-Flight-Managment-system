/**
 * `user_bookings` projection repository (write model, but a *derived* table).
 *
 * This table exists because of a distribution decision: bookings are sharded by
 * flight_id, so "all bookings for user X" would otherwise scatter across every shard.
 * Sharding this projection by user_id makes the passenger's own booking list a
 * single-shard read.
 *
 * The cost is consistency: this is not the authoritative record, it is a projection
 * maintained asynchronously by the outbox consumer, so a booking that just committed
 * may not be visible here for a moment. Two rules follow, and both are load-bearing:
 *
 *   1. Nothing may make a business decision from this table. It answers reads for a
 *      human; it never decides whether a seat is free.
 *   2. `last_event_at` guards the upsert, so an event that arrives out of order
 *      cannot walk a row backwards (CONFIRMED reverted to PENDING) — which is exactly
 *      what a retried or replayed batch would do without the guard.
 */
const { normaliseUserBooking } = require('./mappers');

const COLUMNS = `
  user_id, booking_id, flight_id, departure_date, booking_reference, status, cabin,
  seat_number, passenger_name, origin, destination, flight_number, airline_code,
  departure_time, price, currency, booking_created_at, last_event_at, updated_at`;

/**
 * Idempotent projection write. Replaying the same event changes nothing; an older
 * event that arrives late is ignored rather than applied.
 */
async function upsert(client, entry) {
  const { rows } = await client.query(
    `INSERT INTO user_bookings (
       user_id, booking_id, flight_id, departure_date, booking_reference, status, cabin,
       seat_number, passenger_name, origin, destination, flight_number, airline_code,
       departure_time, price, currency, booking_created_at, last_event_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       COALESCE($16, 'USD'), $17, $18
     )
     ON CONFLICT (user_id, booking_id) DO UPDATE SET
       status          = EXCLUDED.status,
       cabin           = EXCLUDED.cabin,
       seat_number     = EXCLUDED.seat_number,
       passenger_name  = EXCLUDED.passenger_name,
       origin          = EXCLUDED.origin,
       destination     = EXCLUDED.destination,
       flight_number   = EXCLUDED.flight_number,
       airline_code    = EXCLUDED.airline_code,
       departure_time  = EXCLUDED.departure_time,
       price           = EXCLUDED.price,
       currency        = EXCLUDED.currency,
       last_event_at   = EXCLUDED.last_event_at,
       updated_at      = now()
     WHERE user_bookings.last_event_at <= EXCLUDED.last_event_at
     RETURNING ${COLUMNS}`,
    [
      entry.userId,
      entry.bookingId,
      entry.flightId,
      entry.departureDate,
      entry.bookingReference,
      entry.status,
      entry.cabin,
      entry.seatNumber || null,
      entry.passengerName || null,
      entry.origin || null,
      entry.destination || null,
      entry.flightNumber || null,
      entry.airlineCode || null,
      entry.departureTime || null,
      entry.price === undefined ? null : entry.price,
      entry.currency || null,
      entry.bookingCreatedAt,
      entry.lastEventAt
    ]
  );
  // Zero rows on conflict means the guard rejected a stale event — the expected
  // outcome for a replay, not an error.
  return { applied: rows.length > 0, row: rows[0] ? normaliseUserBooking(rows[0]) : null };
}

/**
 * A user's bookings, newest first — one shard, one index scan.
 *
 * The total is a second statement rather than `count(*) OVER ()` on the page. A window
 * count is evaluated over the rows the query actually returned, so a page past the end
 * of the list — `?offset=5000` on a user with three bookings — reports `total: 0`, and
 * a client that pages until `total` is exhausted is told the user has nothing left
 * rather than that it walked off the end. The count is cheap here: `user_bookings` is
 * distributed by `user_id`, so both statements are a single-shard index scan of the
 * same partition of the index.
 */
async function listByUser(client, { userId, status = null, limit = 50, offset = 0 }) {
  const countParams = [userId];
  let predicate = '';
  if (status) {
    predicate = ' AND status = $2';
    countParams.push(status);
  }

  const { rows: countRows } = await client.query(
    `SELECT count(*)::int AS n FROM user_bookings WHERE user_id = $1${predicate}`,
    countParams
  );

  const pageParams = [...countParams, limit, offset];
  const limitIdx = pageParams.length - 1;
  const offsetIdx = pageParams.length;

  const { rows } = await client.query(
    `SELECT ${COLUMNS}
       FROM user_bookings
      WHERE user_id = $1${predicate}
      ORDER BY booking_created_at DESC, booking_id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    pageParams
  );

  return {
    bookings: rows.map(normaliseUserBooking),
    total: Number(countRows[0] ? countRows[0].n : 0)
  };
}

/** How fresh this user's projection is — the honest answer for a client that just booked. */
async function latestEventAt(client, { userId }) {
  const { rows } = await client.query(
    `SELECT max(last_event_at) AS latest FROM user_bookings WHERE user_id = $1`,
    [userId]
  );
  return rows[0]?.latest || null;
}

async function stats(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS rows, max(last_event_at) AS latest FROM user_bookings`
  );
  return { rows: Number(rows[0]?.rows || 0), latestEventAt: rows[0]?.latest || null };
}

module.exports = {
  upsert,
  listByUser,
  latestEventAt,
  stats
};
