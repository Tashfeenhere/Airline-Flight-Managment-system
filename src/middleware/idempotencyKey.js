/**
 * Idempotency-Key extraction.
 *
 * The header is optional on booking creation, but its absence is meaningful and must not
 * be replaced by a server-generated value: a key is a promise that a retry will not
 * double-charge, and the server cannot make that promise on the client's behalf. No key
 * means no replay protection, which is the client's choice to make.
 *
 * Two spellings are accepted. `Idempotency-Key` is the conventional one and
 * `x-idempotency-key` is what HTTP/2 and several API gateways normalize it to; refusing
 * one of them would produce a bug that only appears behind a particular proxy.
 */
const errors = require('../utils/errors');
const { HEADERS } = require('../config/constants');

const MAX_LENGTH = 255;

/**
 * Reads the key without validating it. Exported for the replay-lookup path, which needs
 * the raw value to ask "have I seen this before?" before deciding whether to be strict.
 */
function readIdempotencyKey(req) {
  const get = typeof req.get === 'function' ? (name) => req.get(name) : (name) => (req.headers ? req.headers[name] : undefined);

  const value = get(HEADERS.IDEMPOTENCY_KEY) || get(HEADERS.X_IDEMPOTENCY_KEY);
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Installs the key on `req.idempotencyKey`. A key longer than the contract allows is
 * rejected rather than truncated — two different keys that share a 255-character prefix
 * would collide, and a collision in this header means one client's retry replays
 * another client's booking.
 */
function idempotencyKey(req, res, next) {
  const key = readIdempotencyKey(req);

  if (key === null) {
    req.idempotencyKey = null;
    return next();
  }

  if (key.length > MAX_LENGTH) {
    return next(
      new errors.ValidationError('Request validation failed', {
        source: 'headers',
        fields: [
          {
            path: HEADERS.IDEMPOTENCY_KEY,
            message: `must have at most ${MAX_LENGTH} characters`,
            received: `[${key.length} characters]`
          }
        ]
      })
    );
  }

  req.idempotencyKey = key;
  return next();
}

module.exports = { idempotencyKey, readIdempotencyKey };
