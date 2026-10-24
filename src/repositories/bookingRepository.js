/**
 * Booking repository (write model).
 *
 * Bookings are distributed by `flight_id` and partitioned by `departure_date`, which
 * is what lets a whole booking (inventory + booking + payment + outbox) commit as one
 * local transaction on one worker. The price of that choice is visible here:
 *
 *   - Anything that knows the flight id and date is a single-shard index probe.
 *   - Anything that knows only the booking id or the booking reference has to fan out
 *     to every shard (`findAnyById`, `findByReference`). At 32 shards that is 32
 *     index probes on the coordinator, which is a fine trade for a single-shard write
 *     path; the endpoints that do it are reads, and they are not on the hot path. If
 *     that ever becomes the bottleneck the fix is a booking_id-keyed index table or a
 *     cache, not a different distribution key — changing the key would cost the
 *     no-2PC write path, which is worth far more.
 *
 * Status transitions are done with *conditional claims*: `UPDATE … WHERE status =
 * ANY($from)` returning the row. Exactly one caller can win that update, which is
 * how the hold reaper and a user cancel cannot both release the same seats.
 */
const { normaliseBooking } = require('./mappers');

const COLUMNS = `
  booking_id, booking_reference, flight_id, departure_date, user_id, cabin,
  inventory_shard, seat_number, passenger_name, passenger_ref, status, price,
  currency, idempotency_key, hold_expires_at, node_id, transaction_id, payment_id,
  confirmed_at, cancelled_at, cancellation_reason, created_at, updated_at`;

/** Booking plus its flight's descriptive fields — a co-located join, resolved locally. */
const COLUMNS_WITH_FLIGHT = `
  b.booking_id, b.booking_reference, b.flight_id, b.departure_date, b.user_id, b.cabin,
  b.inventory_shard, b.seat_number, b.passenger_name, b.passenger_ref, b.status, b.price,
  b.currency, b.idempotency_key, b.hold_expires_at, b.node_id, b.transaction_id, b.payment_id,
  b.confirmed_at, b.cancelled_at, b.cancellation_reason, b.created_at, b.updated_at,
  f.origin, f.destination, f.flight_number, f.airline_code, f.departure_time, f.arrival_time,
  f.aircraft_type`;

/**
 * Inserts the booking row.
 *
 * A unique violation is deliberately NOT caught here: the partial index
 * `uq_live_seat` (one live booking per seat) and `uq_booking_idempotency` are the
 * database-level guarantees, and the service above turns the SQLSTATE into the right
 * API error. Swallowing it here would hide the only proof that the guarantee held.
 */
async function insert(client, booking) {
  const { rows } = await client.query(
    `INSERT INTO bookings (
       booking_id, booking_reference, flight_id, departure_date, user_id, cabin,
       inventory_shard, seat_number, passenger_name, passenger_ref, status, price,
       currency, idempotency_key, hold_expires_at, node_id, transaction_id, payment_id
     ) VALUES (
       COALESCE($1::uuid, app_uuidv7()), $2, $3, $4, $5, $6, $7, $8, $9, $10,
       COALESCE($11, 'PENDING'), $12, COALESCE($13, 'USD'), $14, $15, $16, $17, $18
     )
     RETURNING ${COLUMNS}`,
    [
      booking.bookingId || null,
      booking.bookingReference,
      booking.flightId,
      booking.departureDate,
      booking.userId,
      booking.cabin,
      booking.inventoryShard || 0,
      booking.seatNumber || null,
      booking.passengerName,
      booking.passengerRef || null,
      booking.status || null,
      booking.price,
      booking.currency || null,
      booking.idempotencyKey || null,
      booking.holdExpiresAt || null,
      booking.nodeId || null,
      booking.transactionId,
      booking.paymentId || null
    ]
  );
  return normaliseBooking(rows[0]);
}

/** Primary lookup: flight and date known. */
async function findById(client, { flightId, departureDate, bookingId }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM bookings
      WHERE flight_id = $1 AND departure_date = $2 AND booking_id = $3`,
    [flightId, departureDate, bookingId]
  );
  return rows[0] ? normaliseBooking(rows[0]) : null;
}

/**
 * Lookup by booking id alone, for `GET /api/bookings/:bookingId`. Fans out over the
 * shards; the booking id is a UUIDv7 so it identifies exactly one row.
 */
async function findAnyById(client, { bookingId }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM bookings WHERE booking_id = $1 LIMIT 1`,
    [bookingId]
  );
  return rows[0] ? normaliseBooking(rows[0]) : null;
}

/**
 * Idempotency lookup. Scoped by flight and date when the caller knows them (the
 * common case, and a single-shard probe), and unscoped otherwise so a retry that
 * arrives without the flight still finds its booking.
 */
async function findByIdempotencyKey(client, { idempotencyKey, flightId = null, departureDate = null }) {
  const params = [idempotencyKey];
  let predicate = '';
  if (flightId && departureDate) {
    predicate = ' AND flight_id = $2 AND departure_date = $3';
    params.push(flightId, departureDate);
  }
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM bookings
      WHERE idempotency_key = $1${predicate}
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );
  return rows[0] ? normaliseBooking(rows[0]) : null;
}

/**
 * How many bookings carry this reference. Booking references are per-flight unique in
 * the database; this fan-out probe is how the service establishes that a freshly
 * generated reference is not already used somewhere else in the cluster before
 * handing it to a customer.
 */
async function countByReference(client, { bookingReference }) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM bookings WHERE booking_reference = $1`,
    [bookingReference]
  );
  return Number(rows[0]?.n || 0);
}

async function findByReference(client, { bookingReference }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM bookings WHERE booking_reference = $1 LIMIT 1`,
    [bookingReference]
  );
  return rows[0] ? normaliseBooking(rows[0]) : null;
}

/** Booking with its flight fields, for projection work. */
async function findWithFlight(client, { flightId, departureDate, bookingId }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS_WITH_FLIGHT}
       FROM bookings b
       JOIN flights f
         ON f.flight_id = b.flight_id AND f.departure_date = b.departure_date
      WHERE b.flight_id = $1 AND b.departure_date = $2 AND b.booking_id = $3`,
    [flightId, departureDate, bookingId]
  );
  if (!rows[0]) return null;
  // Returns the booking shape plus the flight fields the projection needs.
  return { ...normaliseBooking(rows[0]), flight: pickFlight(rows[0]) };
}

function pickFlight(row) {
  return {
    origin: row.origin,
    destination: row.destination,
    flightNumber: row.flight_number,
    airlineCode: row.airline_code,
    departureTime: row.departure_time instanceof Date ? row.departure_time.toISOString() : row.departure_time,
    arrivalTime: row.arrival_time instanceof Date ? row.arrival_time.toISOString() : row.arrival_time,
    aircraftType: row.aircraft_type
  };
}

/**
 * PENDING -> CONFIRMED, atomically claimed.
 *
 * `status = 'PENDING'` in the predicate is the claim: if the reaper expired this hold
 * a millisecond ago, this returns no row and the caller knows the sale did not
 * happen — instead of resurrecting an expired booking and selling a seat that was
 * already returned to the pool.
 */
async function claimForConfirm(client, { flightId, departureDate, bookingId, paymentId = null }) {
  const { rows } = await client.query(
    `UPDATE bookings
        SET status       = 'CONFIRMED',
            confirmed_at = now(),
            payment_id   = COALESCE($4::uuid, payment_id),
            updated_at   = now()
      WHERE flight_id = $1 AND departure_date = $2 AND booking_id = $3
        AND status = 'PENDING'
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, bookingId, paymentId]
  );
  return rows[0] ? normaliseBooking(rows[0]) : null;
}

/**
 * PENDING|CONFIRMED -> CANCELLED (user cancel or saga compensation), atomically claimed.
 *
 * It also reports *which* of the two states it claimed the booking from, because the
 * caller's very next act differs: a booking whose seat was sold must be returned with
 * `reclaim`, one whose seat is still held with `release`. Those are different statements
 * and each is guarded so the wrong one moves no seat at all — so choosing wrong does not
 * corrupt anything loudly, it silently strands a seat.
 *
 * The choice therefore cannot be made from a status read taken before this transaction.
 * Such a read can go stale in exactly the window that matters: if a payment captures
 * between the read and this UPDATE, the booking is CONFIRMED (which `allowedFrom`
 * admits) while the caller still believes it was PENDING, so it calls `release`, whose
 * `held_seats >= count` guard finds nothing and updates zero rows. The seat is then
 * neither available nor held, no error is raised, and the only trace is the oversell
 * audit. Deriving the answer from the row this statement just updated closes that
 * window, because the claim and the answer are then the same atomic act.
 *
 * `confirmed_at` is the discriminator, and it is a sound one because the UPDATE does not
 * touch it — so its RETURNING value is the pre-claim value — and the two CHECK
 * constraints `ck_bookings_confirmed_timestamp` / `ck_bookings_pending_timestamp`
 * guarantee that across the two statuses `allowedFrom` admits, a set timestamp means
 * exactly "was CONFIRMED". A CANCELLED row keeps its `confirmed_at` on purpose: that is
 * how a later reader still knows the seat was sold.
 */
async function claimForCancel(client, { flightId, departureDate, bookingId, reason, allowedFrom = ['PENDING', 'CONFIRMED'] }) {
  const { rows } = await client.query(
    `UPDATE bookings
        SET status              = 'CANCELLED',
            cancelled_at        = now(),
            cancellation_reason = $4,
            updated_at          = now()
      WHERE flight_id = $1 AND departure_date = $2 AND booking_id = $3
        AND status = ANY($5::text[])
      RETURNING ${COLUMNS}, (confirmed_at IS NOT NULL) AS was_confirmed`,
    [flightId, departureDate, bookingId, reason, allowedFrom]
  );
  if (!rows[0]) return null;
  // Attached rather than folded into `normaliseBooking`: that function maps the declared
  // COLUMNS, and this one is computed by the statement rather than stored in the table.
  return { ...normaliseBooking(rows[0]), wasConfirmed: rows[0].was_confirmed === true };
}

/** PENDING -> EXPIRED, claimed by the hold reaper. */
async function claimForExpire(client, { flightId, departureDate, bookingId }) {
  const { rows } = await client.query(
    `UPDATE bookings
        SET status              = 'EXPIRED',
            cancelled_at        = now(),
            cancellation_reason = 'HOLD_EXPIRED',
            updated_at          = now()
      WHERE flight_id = $1 AND departure_date = $2 AND booking_id = $3
        AND status = 'PENDING'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at < now()
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, bookingId]
  );
  return rows[0] ? normaliseBooking(rows[0]) : null;
}

/** Attaches a specific seat after the fact (auto-assignment and seat upgrades). */
async function assignSeat(client, { flightId, departureDate, bookingId, seatNumber }) {
  const { rows } = await client.query(
    `UPDATE bookings
        SET seat_number = $4, updated_at = now()
      WHERE flight_id = $1 AND departure_date = $2 AND booking_id = $3
        AND status IN ('PENDING', 'CONFIRMED')
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, bookingId, seatNumber]
  );
  return rows[0] ? normaliseBooking(rows[0]) : null;
}

/** Seats currently held or sold in a cabin — what the seat map subtracts from the template. */
async function listTakenSeats(client, { flightId, departureDate, cabin = null }) {
  const params = [flightId, departureDate];
  let predicate = '';
  if (cabin) {
    predicate = ' AND cabin = $3';
    params.push(cabin);
  }
  const { rows } = await client.query(
    `SELECT seat_number, cabin, status, booking_id
       FROM bookings
      WHERE flight_id = $1 AND departure_date = $2
        AND seat_number IS NOT NULL
        AND status IN ('PENDING', 'CONFIRMED')${predicate}
      ORDER BY seat_number`,
    params
  );
  return rows.map((row) => ({
    seatNumber: row.seat_number,
    cabin: row.cabin,
    status: row.status,
    bookingId: row.booking_id
  }));
}

/**
 * Candidate holds for the reaper. A multi-shard read (`ORDER BY` + `LIMIT` merged on
 * the coordinator) followed by a per-booking conditional claim — never a multi-shard
 * UPDATE, because a scatter update would put a two-phase commit in the reaper where
 * the rest of the system has none.
 *
 * `departureDateFrom` bounds the partition scan: holds on flights that departed long
 * ago are history, and re-scanning every past month on each tick would make the job
 * slower every day the system runs.
 */
async function findExpiredHolds(client, { asOf, departureDateFrom, limit = 200 }) {
  const { rows } = await client.query(
    `SELECT flight_id, departure_date, booking_id, cabin, inventory_shard, user_id, hold_expires_at
       FROM bookings
      WHERE status = 'PENDING'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at < $1
        AND departure_date >= $2
      ORDER BY hold_expires_at
      LIMIT $3`,
    [asOf, departureDateFrom, limit]
  );
  return rows.map((row) => ({
    flightId: row.flight_id,
    departureDate: row.departure_date,
    bookingId: row.booking_id,
    cabin: row.cabin,
    inventoryShard: Number(row.inventory_shard),
    userId: row.user_id,
    holdExpiresAt: row.hold_expires_at instanceof Date ? row.hold_expires_at.toISOString() : row.hold_expires_at
  }));
}

/** Count of open holds, for the active-holds gauge. */
async function countOpenHolds(client, { asOf }) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM bookings
      WHERE status = 'PENDING' AND hold_expires_at IS NOT NULL AND hold_expires_at > $1`,
    [asOf]
  );
  return Number(rows[0]?.n || 0);
}

/**
 * Keyset-paginated walk over bookings for the reprojection job.
 *
 * Keyset rather than OFFSET: the write model is being written to while the job runs,
 * and OFFSET would skip or repeat rows as the underlying set shifts.
 */
async function listForProjection(client, { afterCreatedAt, afterBookingId, createdBefore, limit = 500 }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM bookings
      WHERE (created_at, booking_id) > ($1::timestamptz, $2::uuid)
        AND created_at <= $3
      ORDER BY created_at, booking_id
      LIMIT $4`,
    [afterCreatedAt, afterBookingId, createdBefore, limit]
  );
  return rows.map(normaliseBooking);
}

/** Every booking for a user, straight from the write model (reprojection only). */
async function listByUser(client, { userId, limit = 200, offset = 0 }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM bookings
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows.map(normaliseBooking);
}

/**
 * Candidate bookings for the saga reconciler: still PENDING, created longer ago than
 * `staleSeconds`, and with a hold that has NOT yet expired.
 *
 * The "not yet expired" clause is what splits the work between the two workers, and it
 * is deliberate rather than incidental. A PENDING booking whose hold is still alive is
 * one where a process may simply have died mid-saga — the seats are legitimately held
 * and the right move is to *finish* the booking. Once the hold expires, the right move
 * is the opposite: give the seats back. The reaper owns the second case; this query
 * owns the first.
 *
 * A scatter read (`ORDER BY` + `LIMIT` merged on the coordinator) followed by
 * per-booking single-shard work — never a multi-shard UPDATE, which would introduce a
 * two-phase commit into the one path in this system that is otherwise free of them.
 */
async function findStalePending(client, { olderThan, limit = 100, departureDateFrom = null }) {
  const params = [olderThan, limit];
  let predicate = '';
  if (departureDateFrom) {
    predicate = ' AND departure_date >= $3';
    params.push(departureDateFrom);
  }
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM bookings
      WHERE status = 'PENDING'
        AND created_at < $1
        AND (hold_expires_at IS NULL OR hold_expires_at >= now())
        ${predicate}
      ORDER BY created_at
      LIMIT $2`,
    params
  );
  return rows.map(normaliseBooking);
}

/** Status histogram — used by scripts and the admin summary. */
async function stats(client) {
  const { rows } = await client.query(
    `SELECT status, count(*)::int AS n FROM bookings GROUP BY status ORDER BY status`
  );
  return rows.reduce((acc, row) => {
    acc[row.status] = Number(row.n);
    return acc;
  }, {});
}

module.exports = {
  insert,
  findById,
  findAnyById,
  findByIdempotencyKey,
  countByReference,
  findByReference,
  findWithFlight,
  claimForConfirm,
  claimForCancel,
  claimForExpire,
  assignSeat,
  listTakenSeats,
  findExpiredHolds,
  findStalePending,
  countOpenHolds,
  listForProjection,
  listByUser,
  stats
};
