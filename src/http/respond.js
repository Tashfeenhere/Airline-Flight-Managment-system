/**
 * Response envelope helpers.
 *
 * Every 2xx body is `{ success: true, data: ... }` and every error body is
 * `{ success: false, error: { code, message, details }, nodeId, timestamp }`. The error
 * half is produced by `errorHandler`; this module produces the success half, so the two
 * envelopes are defined in one place each rather than inline in twenty handlers.
 *
 * `x-node-id` is stamped on every response, including errors (which do it in
 * `errorHandler`). When a client reports "the booking failed", the first question is
 * which instance served it, and a header that is only sometimes present is a header
 * nobody can rely on.
 */
const env = require('../config/env');
const { HEADERS } = require('../config/constants');

/**
 * @param {import('express').Response} res
 * @param {*} data
 * @param {{ statusCode?: number, headers?: Record<string, string|number|boolean|null|undefined> }} [options]
 */
function ok(res, data, options = {}) {
  const { statusCode = 200, headers = {} } = options;

  for (const [name, value] of Object.entries(headers)) {
    // Skipping null/undefined rather than stringifying them: `String(undefined)` is the
    // header value "undefined", which a client would faithfully parse as a node id.
    if (value === null || value === undefined) continue;
    res.setHeader(name, String(value));
  }

  res.setHeader(HEADERS.NODE_ID, env.NODE_ID);

  // `data: null` rather than an omitted key: the envelope's contract is that `data` is
  // always present, so a client can destructure it without a guard.
  return res.status(statusCode).json({ success: true, data: data === undefined ? null : data });
}

/**
 * Marks a booking response as an idempotent replay.
 *
 * The status code already says 200-vs-201, but a header is what a client can assert on
 * without parsing the body, and it is the honest signal for retry logic: a replay means
 * the original request already succeeded and must not be retried again.
 */
function idempotencyHeaders({ replayed, idempotencyKey = null }) {
  return {
    'Idempotent-Replay': replayed ? 'true' : 'false',
    ...(idempotencyKey ? { [HEADERS.IDEMPOTENCY_KEY]: idempotencyKey } : {})
  };
}

/**
 * Sets the read-model lag header on a projection-backed response.
 *
 * Search and "my bookings" are eventually consistent by design, and a client that
 * cannot see how stale the answer is will either distrust it entirely or trust it too
 * much. A header makes the freshness machine-readable.
 */
function lagHeader(res, lagSeconds) {
  if (lagSeconds === null || lagSeconds === undefined) return;
  res.setHeader(HEADERS.READ_MODEL_LAG, String(Math.round(Number(lagSeconds) * 1000)));
}

module.exports = { ok, idempotencyHeaders, lagHeader };
