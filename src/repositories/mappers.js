/**
 * Row mappers.
 *
 * SQL speaks snake_case; the API and the service layer speak camelCase. The two
 * shapes are kept apart on purpose — mapping in one place means the response
 * contract has exactly one definition, and a column rename cannot leak a
 * `departure_date` key into a JSON response.
 *
 * Mappers are defensive about types that `pg` hands back in more than one form
 * (a `date` column arrives as a JS Date at midnight local time when the parser is
 * left alone), because a date that silently shifts a day is the classic way a
 * booking lands in the wrong partition.
 */

/**
 * `pg` is configured to return DATE as a string (see src/db/pool.js); the Date
 * branch below is a defensive path for a caller that built its own pool.
 */
function toDateOnly(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  // Local-midnight Dates are what the default parser produces; read the calendar
  // date back out of local parts, which is what the driver meant by them.
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toIsoString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normaliseFlight(row) {
  if (!row) return null;
  return {
    flightId: row.flight_id,
    flightNumber: row.flight_number,
    airlineCode: row.airline_code,
    origin: row.origin,
    destination: row.destination,
    departureDate: toDateOnly(row.departure_date),
    departureTime: toIsoString(row.departure_time),
    arrivalTime: toIsoString(row.arrival_time),
    aircraftType: row.aircraft_type,
    basePrice: row.base_price === null ? null : Number(row.base_price),
    currency: row.currency,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function normaliseInventory(row) {
  if (!row) return null;
  return {
    flightId: row.flight_id,
    departureDate: toDateOnly(row.departure_date),
    cabin: row.cabin,
    shardNo: row.shard_no === undefined ? 0 : Number(row.shard_no),
    totalSeats: Number(row.total_seats),
    availableSeats: Number(row.available_seats),
    heldSeats: Number(row.held_seats),
    version: Number(row.version),
    updatedAt: toIsoString(row.updated_at)
  };
}

function normaliseBooking(row) {
  if (!row) return null;
  return {
    bookingId: row.booking_id,
    bookingReference: row.booking_reference,
    flightId: row.flight_id,
    departureDate: toDateOnly(row.departure_date),
    userId: row.user_id,
    cabin: row.cabin,
    inventoryShard: row.inventory_shard === undefined ? 0 : Number(row.inventory_shard),
    seatNumber: row.seat_number,
    passengerName: row.passenger_name,
    passengerRef: row.passenger_ref,
    status: row.status,
    price: row.price === null ? null : Number(row.price),
    currency: row.currency,
    idempotencyKey: row.idempotency_key,
    holdExpiresAt: toIsoString(row.hold_expires_at),
    nodeId: row.node_id,
    transactionId: row.transaction_id,
    paymentId: row.payment_id,
    confirmedAt: toIsoString(row.confirmed_at),
    cancelledAt: toIsoString(row.cancelled_at),
    cancellationReason: row.cancellation_reason,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function normalisePayment(row) {
  if (!row) return null;
  return {
    paymentId: row.payment_id,
    flightId: row.flight_id,
    departureDate: toDateOnly(row.departure_date),
    bookingId: row.booking_id,
    amount: row.amount === null ? null : Number(row.amount),
    currency: row.currency,
    provider: row.provider,
    status: row.status,
    sagaState: row.saga_state,
    failureReason: row.failure_reason,
    providerReference: row.provider_reference,
    idempotencyKey: row.idempotency_key,
    authorizedAt: toIsoString(row.authorized_at),
    capturedAt: toIsoString(row.captured_at),
    refundedAt: toIsoString(row.refunded_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function normaliseUserBooking(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    bookingId: row.booking_id,
    bookingReference: row.booking_reference,
    flightId: row.flight_id,
    departureDate: toDateOnly(row.departure_date),
    status: row.status,
    cabin: row.cabin,
    seatNumber: row.seat_number,
    passengerName: row.passenger_name,
    origin: row.origin,
    destination: row.destination,
    flightNumber: row.flight_number,
    airlineCode: row.airline_code,
    departureTime: toIsoString(row.departure_time),
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    currency: row.currency,
    bookingCreatedAt: toIsoString(row.booking_created_at),
    lastEventAt: toIsoString(row.last_event_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function normaliseAvailability(row) {
  if (!row) return null;
  return {
    origin: row.origin,
    destination: row.destination,
    departureDate: toDateOnly(row.departure_date),
    flightId: row.flight_id,
    flightNumber: row.flight_number,
    airlineCode: row.airline_code,
    aircraftType: row.aircraft_type,
    departureTime: toIsoString(row.departure_time),
    arrivalTime: toIsoString(row.arrival_time),
    cabin: row.cabin,
    totalSeats: Number(row.total_seats),
    availableSeats: Number(row.available_seats),
    heldSeats: Number(row.held_seats),
    price: row.price === null ? null : Number(row.price),
    currency: row.currency,
    status: row.status,
    sourceVersion: Number(row.source_version),
    updatedAt: toIsoString(row.updated_at)
  };
}

/**
 * One search hit: a flight with its cabins attached.
 *
 * The cabins arrive as `json_agg` output, so they are already camelCase and already
 * JSON-safe — but `json_build_object` cannot convert a `bigint` to a JSON number
 * without loss, so `source_version` comes back as a numeric *string* and is coerced
 * here. That is the kind of thing that renders as `"version": "41"` in a response and
 * breaks a strict client, so it is handled once, in the mapper.
 */
function normaliseSearchFlight(row) {
  if (!row) return null;

  const cabins = (row.cabins || []).map((cabin) => ({
    cabin: cabin.cabin,
    totalSeats: Number(cabin.totalSeats),
    availableSeats: Number(cabin.availableSeats),
    heldSeats: Number(cabin.heldSeats),
    price: cabin.price === null ? null : Number(cabin.price),
    currency: cabin.currency,
    sourceVersion: Number(cabin.sourceVersion)
  }));

  return {
    flightId: row.flight_id,
    flightNumber: row.flight_number,
    airlineCode: row.airline_code,
    origin: row.origin,
    destination: row.destination,
    departureDate: toDateOnly(row.departure_date),
    departureTime: toIsoString(row.departure_time),
    arrivalTime: toIsoString(row.arrival_time),
    aircraftType: row.aircraft_type,
    status: row.status,
    currency: row.currency,
    lowestPrice: row.lowest_price === null ? null : Number(row.lowest_price),
    sourceVersion: Number(row.source_version),
    updatedAt: toIsoString(row.updated_at),
    cabins
  };
}

function normaliseOutboxEvent(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    flightId: row.flight_id,
    departureDate: toDateOnly(row.departure_date),
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    userId: row.user_id,
    payload: row.payload,
    published: row.published,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    createdAt: toIsoString(row.created_at),
    publishedAt: toIsoString(row.published_at)
  };
}

function normaliseUser(row, { includePassword = false } = {}) {
  if (!row) return null;
  const user = {
    userId: row.id,
    email: row.email,
    role: row.role,
    fullName: row.full_name,
    phone: row.phone,
    isActive: row.is_active,
    lastLoginAt: toIsoString(row.last_login_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
  if (includePassword) user.passwordHash = row.password_hash;
  return user;
}

module.exports = {
  toDateOnly,
  toIsoString,
  normaliseFlight,
  normaliseInventory,
  normaliseBooking,
  normalisePayment,
  normaliseUserBooking,
  normaliseAvailability,
  normaliseSearchFlight,
  normaliseOutboxEvent,
  normaliseUser
};
