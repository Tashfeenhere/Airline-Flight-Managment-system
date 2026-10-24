/**
 * Central error translation and the single place a failure becomes an HTTP response.
 *
 * Every response the API emits uses the same envelope, so clients parse one shape:
 *   success: { success: true,  data: <payload> }
 *   failure: { success: false, error: { code, message, details }, nodeId, timestamp }
 *
 * The translation layer exists because raw database and parser errors are not safe
 * to surface: a PostgreSQL message names tables, columns and constraint internals
 * (useful to an attacker mapping the schema) and a stack trace leaks file paths and
 * dependency versions. Here those are mapped to a small set of stable, client-safe
 * error codes, and anything unrecognised is logged in full but answered generically.
 */
const env = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const {
  HTTP_STATUS,
  ERROR_CODES,
  RETRYABLE_PG_CODES,
  CONSTRAINT_VIOLATION,
  CONSTRAINT_NAMES
} = require('../config/constants');
const { getRequestId } = require('./requestContext');

// HTTP_STATUS intentionally has no 413 entry (the shared constants file is owned
// elsewhere), so keep the literal here rather than inventing a duplicate constant.
const PAYLOAD_TOO_LARGE = 413;

const INTERNAL_MESSAGE = 'Internal server error';

// A SQLSTATE is always exactly five characters from [0-9A-Z]. This distinguishes a
// driver error from an AppError, whose `code` is a long, underscored identifier.
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

// Precomputed so the hot path does not rebuild the list on every failure.
const RETRYABLE_CODES = new Set(Object.values(RETRYABLE_PG_CODES));

function isPgError(err) {
  return Boolean(err) && typeof err.code === 'string' && SQLSTATE_RE.test(err.code);
}

/**
 * Maps a driver error onto a client-safe outcome.
 *
 * Returns null when the error is not a recognised PostgreSQL condition, letting the
 * caller fall through to the generic 500 path. Exported (via module.exports) so the
 * mapping table can be unit tested without a live database.
 *
 * @returns {{ statusCode: number, code: string, message: string, details: object|null }|null}
 */
function translatePgError(err) {
  if (!isPgError(err)) return null;

  const { code, constraint, table } = err;

  if (code === CONSTRAINT_VIOLATION.UNIQUE_VIOLATION) {
    if (constraint === CONSTRAINT_NAMES.LIVE_SEAT_UNIQUE) {
      // The partial unique index over live bookings is the last line of defence
      // against double-selling a specific seat.
      return {
        statusCode: HTTP_STATUS.CONFLICT,
        code: ERROR_CODES.SEAT_UNAVAILABLE,
        message: 'The requested seat is no longer available on this flight',
        details: { constraint }
      };
    }
    if (
      constraint === CONSTRAINT_NAMES.BOOKING_REFERENCE_UNIQUE ||
      constraint === CONSTRAINT_NAMES.IDEMPOTENCY_UNIQUE
    ) {
      return {
        statusCode: HTTP_STATUS.CONFLICT,
        code: ERROR_CODES.DUPLICATE_BOOKING,
        message: 'A booking with this reference or idempotency key already exists',
        details: { constraint }
      };
    }
    if (constraint === CONSTRAINT_NAMES.USER_EMAIL_UNIQUE) {
      return {
        statusCode: HTTP_STATUS.CONFLICT,
        code: ERROR_CODES.DUPLICATE_USER,
        message: 'An account with this email already exists',
        details: { constraint }
      };
    }
    return {
      statusCode: HTTP_STATUS.CONFLICT,
      code: ERROR_CODES.DUPLICATE_ENTRY,
      message: 'A conflicting record already exists',
      details: { constraint }
    };
  }

  if (code === CONSTRAINT_VIOLATION.CHECK_VIOLATION) {
    if (
      constraint === CONSTRAINT_NAMES.INVENTORY_CAPACITY ||
      constraint === CONSTRAINT_NAMES.INVENTORY_NON_NEGATIVE
    ) {
      // A counter went over capacity or negative. This is not a client mistake: it
      // means the booking algorithm produced an impossible state, so it is a 500
      // and an operational alarm, never a 4xx the caller is told to fix.
      return {
        statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
        code: ERROR_CODES.INVENTORY_INVARIANT_VIOLATION,
        message: 'Inventory accounting invariant violated',
        details: { constraint }
      };
    }
    // Any other CHECK constraint is still a server-side data integrity problem;
    // return null so it is logged with its stack rather than mislabelled.
    return null;
  }

  if (code === CONSTRAINT_VIOLATION.FOREIGN_KEY_VIOLATION) {
    return {
      statusCode: HTTP_STATUS.CONFLICT,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'The request references a record that does not exist',
      details: { constraint, ...(table ? { table } : {}) }
    };
  }

  // Serialization failure / deadlock that escaped `executeWithRetry`: the
  // transaction provably did not commit, so a retry is safe.
  if (
    code === RETRYABLE_PG_CODES.SERIALIZATION_FAILURE ||
    code === RETRYABLE_PG_CODES.DEADLOCK_DETECTED
  ) {
    return {
      statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
      code: ERROR_CODES.TRANSIENT_TRANSACTION_ERROR,
      message: 'The transaction conflicted with a concurrent write; please retry',
      details: null
    };
  }

  // statement_timeout cancels the running query with 57014. Checked before the
  // generic retryable set because it is a timeout, not an availability failure.
  if (code === RETRYABLE_PG_CODES.QUERY_CANCELED) {
    return {
      statusCode: HTTP_STATUS.GATEWAY_TIMEOUT,
      code: ERROR_CODES.DATABASE_UNAVAILABLE,
      message: 'The database query timed out',
      details: null
    };
  }

  // Everything else the retry policy considers transient (connection loss, worker
  // gone, too many connections) means the write model is unreachable right now.
  if (RETRYABLE_CODES.has(code)) {
    return {
      statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
      code: ERROR_CODES.DATABASE_UNAVAILABLE,
      message: 'The database is temporarily unavailable',
      details: null
    };
  }

  return null;
}

/**
 * body-parser rejects malformed or oversized bodies with its own error shapes.
 * Normalising them here keeps the client contract "bad input -> 400/413 with
 * VALIDATION_ERROR" instead of leaking body-parser internals.
 */
function translateBodyParserError(err) {
  if (!err || typeof err !== 'object') return null;

  const isParseFailure =
    err.type === 'entity.parse.failed' ||
    (err instanceof SyntaxError &&
      (err.status === HTTP_STATUS.BAD_REQUEST || err.statusCode === HTTP_STATUS.BAD_REQUEST));

  if (isParseFailure) {
    return {
      statusCode: HTTP_STATUS.BAD_REQUEST,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Request body is not valid JSON',
      details: null
    };
  }

  if (err.type === 'entity.too.large') {
    return {
      statusCode: PAYLOAD_TOO_LARGE,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Request payload is too large',
      details: err.limit ? { limitBytes: err.limit } : null
    };
  }

  return null;
}

function writeEnvelope(res, { statusCode, code, message, details }) {
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details: details === undefined ? null : details
    },
    nodeId: env.NODE_ID,
    timestamp: new Date().toISOString()
  });
}

function logRequestFailure(req, level, message, meta) {
  logger[level](message, {
    requestId: getRequestId(req),
    method: req && req.method,
    path: req && req.path,
    nodeId: env.NODE_ID,
    ...meta
  });
}

function errorHandler(err, req, res, next) {
  // Once headers are on the wire the response is committed; the best we can do is
  // let Express destroy the socket rather than throw "headers already sent".
  if (res.headersSent) {
    return next(err);
  }

  // 1. Deliberately raised business/operational errors carry their own outcome.
  if (err instanceof AppError || (err && err.isOperational)) {
    const statusCode = err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
    logRequestFailure(req, statusCode >= 500 ? 'error' : 'warn', 'Request failed', {
      statusCode,
      code: err.code,
      error: err
    });
    return writeEnvelope(res, {
      statusCode,
      code: err.code || ERROR_CODES.INTERNAL_ERROR,
      message: err.message,
      details: err.details
    });
  }

  // 2. Malformed JSON / oversized payload.
  const parserError = translateBodyParserError(err);
  if (parserError) {
    logRequestFailure(req, 'warn', 'Request body rejected', {
      statusCode: parserError.statusCode,
      code: parserError.code,
      error: err
    });
    return writeEnvelope(res, parserError);
  }

  // 3. Database faults, translated so schema internals never reach the client.
  const pgError = translatePgError(err);
  if (pgError) {
    logRequestFailure(req, pgError.statusCode >= 500 ? 'error' : 'warn', 'Database request failed', {
      statusCode: pgError.statusCode,
      code: pgError.code,
      error: err
    });
    return writeEnvelope(res, pgError);
  }

  // 4. Unknown fault: full detail (with stack) to the logs, nothing useful — and
  //    nothing dangerous — to the caller. Non-production environments surface the
  //    real message/stack in `details` to keep local debugging fast.
  logRequestFailure(req, 'error', 'Unhandled error', {
    statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    code: ERROR_CODES.INTERNAL_ERROR,
    error: err
  });
  return writeEnvelope(res, {
    statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: INTERNAL_MESSAGE,
    details: env.isProduction
      ? null
      : { message: err && err.message, stack: err && err.stack }
  });
}

module.exports = errorHandler;
module.exports.errorHandler = errorHandler;
module.exports.translatePgError = translatePgError;
