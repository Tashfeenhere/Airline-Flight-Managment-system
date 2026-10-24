const crypto = require('crypto');
const { v7: uuidv7 } = require('uuid');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generates a UUIDv7 primary key.
 *
 * v7 is time-ordered: the leading 48 bits are a millisecond timestamp, so index
 * inserts stay at the right edge of the B-tree instead of scattering across it
 * the way random v4 keys do. That matters at billions of rows.
 */
function newUuid() {
  return uuidv7();
}

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/**
 * Normalizes an id for comparison/lookup. Returns null for anything that is not
 * a syntactically valid UUID so callers can answer 400 rather than letting a
 * malformed value reach PostgreSQL (where it raises `22P02`, a 500-shaped error).
 */
function toUuidOrNull(value) {
  if (value === null || value === undefined) return null;
  const asString = String(value).trim();
  return isValidUuid(asString) ? asString.toLowerCase() : null;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Human-facing booking reference, e.g. `BK-7F9A12K4QW`.
 *
 * Crockford base32 over 50 random bits: short enough to read over the phone,
 * wide enough that collisions are negligible. Uniqueness is still enforced by
 * the `uq_booking_reference` index — the caller retries on conflict.
 */
function generateBookingReference() {
  const bytes = crypto.randomBytes(7);
  let bits = 0n;
  for (const byte of bytes) {
    bits = (bits << 8n) | BigInt(byte);
  }

  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }

  return `BK-${out}`;
}

/** Opaque, URL-safe token for refresh tokens and idempotency keys. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Timing-safe comparison for secrets of equal length. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  newUuid,
  isValidUuid,
  toUuidOrNull,
  generateBookingReference,
  randomToken,
  safeEqual
};
