/**
 * Idempotency service.
 *
 * A retried POST must not create a second booking. There are two independent layers
 * protecting that, and they exist for different reasons:
 *
 *   1. THIS LAYER (the cache) is the fast path. `SET NX` on a key derived from the
 *      caller's Idempotency-Key means the first request wins the claim and every
 *      concurrent duplicate either waits for the result or is told to retry. It also
 *      records the *response*, so a replay returns the original booking rather than
 *      silently creating a new one. With a distributed cache this works across API
 *      instances; with the in-process driver it covers one process only — which is
 *      exactly why it is not the guarantee.
 *
 *   2. THE DATABASE (partial unique index `uq_booking_idempotency`) is the guarantee.
 *      It cannot be bypassed by a node that lost its claim, by an eviction, or by a
 *      deploy. Its scope is per (flight_id, departure_date) because a unique index on
 *      a distributed table must contain the distribution column.
 *
 * Two keys per request, and the split matters:
 *   - the CLAIM key holds this request's token and lives for the whole TTL. It is
 *     never deleted on success: releasing the claim when the response is recorded
 *     would let a duplicate acquire it and start a second booking.
 *   - the RECORD key holds the state and, once finished, the response.
 * Releasing after a *failure* is therefore a compare-and-delete on the claim key,
 * which is atomic in both drivers — a slow failed request can never delete the claim
 * of a newer one that has since taken over.
 *
 * The request body is hashed into the record. Reusing a key with a *different* body is
 * a client bug, and answering with the first request's booking would be worse than
 * failing: the customer would be told they booked something they never asked for. That
 * case is a 409, not a replay.
 */
const crypto = require('crypto');
const pool = require('../db/pool');
const cache = require('../cache');
const logger = require('../utils/logger');
const { IdempotencyConflictError } = require('../utils/errors');

/** How long an idempotency record is remembered. Longer than any sane client retry. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** How long a duplicate waits for the in-flight original before giving up. */
const DEFAULT_WAIT_MS = 2000;
const POLL_INTERVAL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Canonical JSON: object keys sorted recursively, so two structurally identical bodies
 * hash the same regardless of key order. Without this, a client that serializes its
 * retry with a different field order would be told its body changed.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashRequest(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

const claimKeyFor = (scope, key) => cache.KEYS.IDEMPOTENCY(scope, key);
const recordKeyFor = (scope, key) => `${cache.KEYS.IDEMPOTENCY(scope, key)}:record`;

/**
 * Claims the key, or reports what the previous request did with it.
 *
 * Returns one of:
 *   { state: 'acquired', token }   -> caller owns the key; must complete() or release()
 *   { state: 'replay', response }  -> the original request finished; return its response
 *   { state: 'in_flight' }         -> a duplicate is still running; caller should 409/retry
 *
 * Throws IdempotencyConflictError when the key was already used with a different body.
 */
async function begin({ scope, key, requestHash, ttlSeconds = DEFAULT_TTL_SECONDS, waitMs = DEFAULT_WAIT_MS }) {
  const claimKey = claimKeyFor(scope, key);
  const recordKey = recordKeyFor(scope, key);
  const token = crypto.randomUUID();

  if (await cache.setNx(claimKey, token, ttlSeconds)) {
    await cache.setJson(recordKey, { state: 'IN_PROGRESS', requestHash, startedAt: Date.now() }, ttlSeconds);
    return { state: 'acquired', token, claimKey, recordKey };
  }

  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    const record = await cache.getJson(recordKey);

    if (record === null) {
      // Either the record expired or the cache was reset while the claim survived;
      // taking the claim ourselves is the only way to make progress. The database
      // backstop still protects the outcome even if this decision is wrong.
      if (await cache.setNx(claimKey, token, ttlSeconds)) {
        await cache.setJson(recordKey, { state: 'IN_PROGRESS', requestHash, startedAt: Date.now() }, ttlSeconds);
        return { state: 'acquired', token, claimKey, recordKey };
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (record.requestHash && record.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        'This Idempotency-Key was already used with a different request body',
        { key, scope }
      );
    }

    if (record.state === 'COMPLETED') {
      return { state: 'replay', response: record.response, claimKey, recordKey };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Fast-path / Redis timed out: Check durable PostgreSQL idempotency_records table
  try {
    const { rows } = await pool.query(
      `SELECT request_fingerprint, status, response_body
         FROM idempotency_records
        WHERE scope = $1 AND idempotency_key = $2 AND expires_at > now()`,
      [scope, key]
    );
    if (rows.length > 0) {
      const dbRecord = rows[0];
      if (dbRecord.request_fingerprint && dbRecord.request_fingerprint !== requestHash) {
        throw new IdempotencyConflictError(
          'This Idempotency-Key was already used with a different request body',
          { key, scope }
        );
      }
      if (dbRecord.status === 'COMPLETED') {
        return { state: 'replay', response: dbRecord.response_body, claimKey, recordKey };
      }
    }
  } catch (pgErr) {
    if (pgErr instanceof IdempotencyConflictError) throw pgErr;
    logger.warn('Failed querying postgres idempotency_records', { error: pgErr.message });
  }

  // Still running after the wait window: the honest answer is "a duplicate of this
  // request is in flight, ask again", not a fabricated result.
  logger.warn('Idempotency key still in flight after wait window', { scope, key });
  return { state: 'in_flight', claimKey, recordKey };
}

/** Records the outcome so a later replay can return it verbatim. */
async function complete({ scope, key, requestHash, response, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  await cache.setJson(
    recordKeyFor(scope, key),
    { state: 'COMPLETED', requestHash, response, completedAt: Date.now() },
    ttlSeconds
  );

  // Durable write to PostgreSQL
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await pool.query(
      `INSERT INTO idempotency_records (
         idempotency_key, scope, request_fingerprint, status, response_status, response_body, expires_at, updated_at
       ) VALUES ($1, $2, $3, 'COMPLETED', $4, $5, $6, now())
       ON CONFLICT (scope, idempotency_key) DO UPDATE
       SET status = 'COMPLETED', response_status = $4, response_body = $5, expires_at = $6, updated_at = now()`,
      [key, scope, requestHash, response && response.statusCode ? response.statusCode : 200, JSON.stringify(response), expiresAt]
    );
  } catch (err) {
    logger.warn('Failed writing to durable idempotency_records', { scope, key, error: err.message });
  }
}

/**
 * Releases the claim after a failure, so the client's retry may try again instead of
 * being answered with a replay of a request that never succeeded.
 */
async function release({ claimKey, recordKey, token, scope = null, key = null }) {
  const released = await cache.delIfValue(claimKey, token);
  if (recordKey) await cache.del(recordKey);
  if (scope && key) {
    try {
      await pool.query('DELETE FROM idempotency_records WHERE scope = $1 AND idempotency_key = $2', [scope, key]);
    } catch (err) {
      // ignore
    }
  }
  return released;
}

/**
 * Reads the record without claiming it — used by the failure path to check whether a
 * previous attempt with this key actually succeeded before deciding how to report the
 * current error.
 */
async function peek({ scope, key }) {
  return cache.getJson(recordKeyFor(scope, key));
}

/** True when the cache is shared, i.e. records are visible to every API instance. */
function isDistributed() {
  return cache.describe().distributed;
}

module.exports = {
  begin,
  complete,
  release,
  peek,
  hashRequest,
  stableStringify,
  isDistributed,
  DEFAULT_TTL_SECONDS,
  DEFAULT_WAIT_MS,
  POLL_INTERVAL_MS
};
