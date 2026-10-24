/**
 * Shared helpers for the k6 load scenarios.
 *
 * k6 runs each VU in a separate JS runtime, so this module holds no server-side state:
 * every helper is a pure function of its arguments and the per-VU `__VU`/`__ITER`
 * counters. The scripts are deliberately dependency-free (k6 has no npm modules); they
 * exercise the same HTTP contract a real client does.
 */
import http from 'k6/http';

export const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

export function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
}

/** A per-iteration key. Unique by default; `fixedKey` turns a VU into a replay client. */
export function idempotencyKey(prefix = 'k6', fixedKey = null) {
  if (fixedKey) return fixedKey;
  return `${prefix}-${__VU}-${__ITER}-${Date.now()}`;
}

/** `YYYY-MM-DD`, `days` from today in UTC. */
export function utcDatePlus(days = 0) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

export function search(origin, destination, departureDate, extraQuery = '') {
  const url =
    `${BASE_URL}/api/flights/search?origin=${encodeURIComponent(origin)}` +
    `&destination=${encodeURIComponent(destination)}` +
    `&departureDate=${encodeURIComponent(departureDate)}${extraQuery}`;
  return httpGet(url, { tags: { endpoint: 'search' } });
}

export function httpGet(url, params = {}) {
  return http.get(url, { ...params, headers: jsonHeaders(params.headers || {}) });
}

export function availability(flightId) {
  return httpGet(`${BASE_URL}/api/flights/${flightId}/availability`, {
    tags: { endpoint: 'availability' }
  });
}

/**
 * Books one seat. `Idempotency-Key` is always sent: without it a retried request after
 * a network timeout is a second booking, which is exactly what this system is built to
 * prevent.
 */
export function book({
  flightId,
  cabin = 'ECONOMY',
  passengerName = 'k6 Passenger',
  key,
  token = null,
  expectedVersion = undefined
}) {
  const headers = jsonHeaders({ 'Idempotency-Key': key });
  if (token) headers.Authorization = `Bearer ${token}`;

  const payload = { flightId, cabin, passengerName };
  if (expectedVersion !== undefined && expectedVersion !== null) {
    payload.expectedVersion = expectedVersion;
  }

  return http.post(
    `${BASE_URL}/api/bookings`,
    JSON.stringify(payload),
    { headers, tags: { endpoint: 'booking' } }
  );
}

export function cancel(bookingId, token = null) {
  const headers = jsonHeaders();
  if (token) headers.Authorization = `Bearer ${token}`;
  return http.post(`${BASE_URL}/api/bookings/${bookingId}/cancel`, JSON.stringify({ reason: 'K6' }), {
    headers,
    tags: { endpoint: 'cancel' }
  });
}

/** Classify a booking response for k6's `Rate`/`Counter` metrics. */
export function bookingOutcome(response) {
  if (response.status === 201) return 'confirmed';
  if (response.status === 200) return 'replayed';
  if (response.status === 409) return 'refused';
  if (response.status === 401 || response.status === 403) return 'unauthorised';
  if (response.status >= 500) return 'server_error';
  return 'other';
}
