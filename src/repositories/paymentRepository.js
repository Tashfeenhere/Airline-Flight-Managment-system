/**
 * Payment repository (write model).
 *
 * The payments table is the saga's durable memory. Every step writes its state
 * before the next step starts, so a process that dies mid-saga leaves a row that
 * says exactly how far it got — which is what `scripts/reconcile-sagas.js` needs to
 * decide between rolling forward and compensating.
 *
 * Co-located with `bookings` by flight_id, so a payment update is always a
 * single-shard statement and the saga never needs a distributed transaction.
 */
const { normalisePayment } = require('./mappers');

const COLUMNS = `
  payment_id, flight_id, departure_date, booking_id, amount, currency, provider,
  status, saga_state, failure_reason, provider_reference, idempotency_key,
  authorized_at, captured_at, refunded_at, created_at, updated_at`;

async function insert(client, payment) {
  const { rows } = await client.query(
    `INSERT INTO payments (
       payment_id, flight_id, departure_date, booking_id, amount, currency, provider,
       status, saga_state, idempotency_key
     ) VALUES (
       COALESCE($1::uuid, app_uuidv7()), $2, $3, $4, $5, COALESCE($6, 'USD'),
       COALESCE($7, 'SIMULATED'), COALESCE($8, 'PENDING'), $9, $10
     )
     ON CONFLICT (flight_id, departure_date, booking_id) DO UPDATE SET
       amount     = EXCLUDED.amount,
       updated_at = now()
     RETURNING ${COLUMNS}`,
    [
      payment.paymentId || null,
      payment.flightId,
      payment.departureDate,
      payment.bookingId,
      payment.amount,
      payment.currency || null,
      payment.provider || null,
      payment.status || null,
      payment.sagaState || null,
      payment.idempotencyKey || null
    ]
  );
  return normalisePayment(rows[0]);
}

/** One payment per booking, so flight + date + booking id identifies it exactly. */
async function findByBooking(client, { flightId, departureDate, bookingId }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM payments
      WHERE flight_id = $1 AND departure_date = $2 AND booking_id = $3`,
    [flightId, departureDate, bookingId]
  );
  return rows[0] ? normalisePayment(rows[0]) : null;
}

/**
 * A generic status write, guarded by the saga state we believe we are moving from.
 *
 * `status` is applied with COALESCE so a caller may advance the *saga state* alone.
 * That distinction is load-bearing: COMPENSATING records that a refund is in progress,
 * and it is not a payment status — the money is still captured until the refund
 * returns. Writing it as a status would either be a lie or, as it was before this
 * COALESCE, a NULL into a NOT NULL column that failed the whole transaction.
 */
async function updateStatus(client, { flightId, departureDate, paymentId, status = null, sagaState, failureReason = null, providerReference = null, expectedSagaStates = null }) {
  const { rows } = await client.query(
    `UPDATE payments
        SET status             = COALESCE($4, status),
            saga_state         = COALESCE($5, saga_state),
            failure_reason     = COALESCE($6, failure_reason),
            provider_reference = COALESCE($7, provider_reference),
            authorized_at      = CASE WHEN $4 = 'AUTHORIZED' THEN now() ELSE authorized_at END,
            captured_at        = CASE WHEN $4 = 'CAPTURED'   THEN now() ELSE captured_at   END,
            refunded_at        = CASE WHEN $4 = 'REFUNDED'   THEN now() ELSE refunded_at   END,
            updated_at         = now()
      WHERE flight_id = $1 AND departure_date = $2 AND payment_id = $3
        AND ($8::text[] IS NULL OR saga_state = ANY($8::text[]))
      RETURNING ${COLUMNS}`,
    [
      flightId,
      departureDate,
      paymentId,
      status,
      sagaState || null,
      failureReason,
      providerReference,
      expectedSagaStates
    ]
  );
  return rows[0] ? normalisePayment(rows[0]) : null;
}

const markAuthorizing = (client, args) => updateStatus(client, { ...args, status: 'PENDING', sagaState: 'AUTHORIZING', expectedSagaStates: ['RESERVED'] });
const markAuthorized = (client, args) => updateStatus(client, { ...args, status: 'AUTHORIZED', sagaState: 'AUTHORIZED' });
const markCapturing = (client, args) => updateStatus(client, { ...args, status: 'AUTHORIZED', sagaState: 'CAPTURING', expectedSagaStates: ['AUTHORIZED'] });
const markCaptured = (client, args) => updateStatus(client, { ...args, status: 'CAPTURED', sagaState: 'CAPTURED' });
const markFailed = (client, args) => updateStatus(client, { ...args, status: 'FAILED', sagaState: 'FAILED' });
const markCompensating = (client, args) => updateStatus(client, { ...args, sagaState: 'COMPENSATING' });
const markCompensated = (client, args) => updateStatus(client, { ...args, status: 'REFUNDED', sagaState: 'COMPENSATED', expectedSagaStates: ['COMPENSATING', 'CAPTURED', 'AUTHORIZED'] });

/**
 * Payments stuck mid-saga. A multi-shard read whose rows each carry the flight id
 * and date, so the reconciliation that follows is still per-row single-shard work.
 */
async function listStuck(client, { olderThan, limit = 100 }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM payments
      WHERE saga_state = ANY(ARRAY['AUTHORIZING','CAPTURING'])
        AND updated_at < $1
      ORDER BY updated_at
      LIMIT $2`,
    [olderThan, limit]
  );
  return rows.map(normalisePayment);
}

async function stats(client) {
  const { rows } = await client.query(
    `SELECT status, count(*)::int AS n FROM payments GROUP BY status ORDER BY status`
  );
  return rows.reduce((acc, row) => {
    acc[row.status] = Number(row.n);
    return acc;
  }, {});
}

module.exports = {
  insert,
  findByBooking,
  updateStatus,
  markAuthorizing,
  markAuthorized,
  markCapturing,
  markCaptured,
  markFailed,
  markCompensating,
  markCompensated,
  listStuck,
  stats
};
