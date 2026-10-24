const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

/**
 * Base operational error class.
 *
 * `isOperational` distinguishes expected business outcomes (safe to surface to the
 * caller verbatim) from programmer errors / infrastructure faults (logged, then
 * sanitized before leaving the process).
 */
class AppError extends Error {
  constructor(
    message,
    statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR,
    code = ERROR_CODES.INTERNAL_ERROR,
    details = null
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details = null) {
    super(message, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, details);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null) {
    super(message, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, details);
  }
}

/** No inventory left on the (flight, cabin) counter — the anti-oversell outcome. */
class SoldOutError extends AppError {
  constructor(message = 'No seats remaining in the requested cabin', details = null) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.SOLD_OUT, details);
  }
}

/** The requested specific seat is already held or booked. */
class SeatUnavailableError extends AppError {
  constructor(message = 'Requested seat is no longer available', details = null) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.SEAT_UNAVAILABLE, details);
  }
}

/** Optimistic concurrency control mismatch on the inventory counter. */
class VersionConflictError extends AppError {
  constructor(
    message = 'Optimistic concurrency version conflict: inventory changed by another transaction',
    details = null
  ) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.VERSION_CONFLICT, details);
  }
}

class DuplicateBookingError extends AppError {
  constructor(message = 'A live booking already exists for this seat', details = null) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.DUPLICATE_BOOKING, details);
  }
}

class DuplicateEntryError extends AppError {
  constructor(message = 'A conflicting record already exists', details = null) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.DUPLICATE_ENTRY, details);
  }
}

class DuplicateUserError extends AppError {
  constructor(message = 'An account with this email already exists', details = null) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.DUPLICATE_USER, details);
  }
}

/** The PENDING hold expired (or was reaped) before payment settled. */
class HoldExpiredError extends AppError {
  constructor(message = 'The reservation hold expired before payment settled', details = null) {
    super(message, HTTP_STATUS.GONE, ERROR_CODES.HOLD_EXPIRED, details);
  }
}

class PaymentFailedError extends AppError {
  constructor(message = 'Payment could not be completed', details = null) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.PAYMENT_FAILED, details);
  }
}

/** A CHECK constraint / accounting invariant was violated — a correctness alarm. */
class InvariantViolationError extends AppError {
  constructor(message = 'Inventory accounting invariant violated', details = null) {
    super(message, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INVENTORY_INVARIANT_VIOLATION, details);
  }
}

class IdempotencyConflictError extends AppError {
  constructor(message = 'This idempotency key was already used for a different request', details = null) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.IDEMPOTENCY_CONFLICT, details);
  }
}

class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication is required', code = ERROR_CODES.UNAUTHENTICATED, details = null) {
    super(message, HTTP_STATUS.UNAUTHORIZED, code, details);
  }
}

class InvalidCredentialsError extends AppError {
  constructor(message = 'Invalid email or password', details = null) {
    super(message, HTTP_STATUS.UNAUTHORIZED, ERROR_CODES.INVALID_CREDENTIALS, details);
  }
}

class TokenExpiredError extends AppError {
  constructor(message = 'Token has expired', details = null) {
    super(message, HTTP_STATUS.UNAUTHORIZED, ERROR_CODES.TOKEN_EXPIRED, details);
  }
}

class TokenInvalidError extends AppError {
  constructor(message = 'Token is invalid', details = null) {
    super(message, HTTP_STATUS.UNAUTHORIZED, ERROR_CODES.TOKEN_INVALID, details);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', details = null) {
    super(message, HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN, details);
  }
}

class RateLimitedError extends AppError {
  constructor(message = 'Too many requests', details = null) {
    super(message, HTTP_STATUS.TOO_MANY_REQUESTS, ERROR_CODES.RATE_LIMITED, details);
  }
}

/**
 * Transient database condition (serialization failure, deadlock, worker
 * unavailable). Safe to retry; surfaces as 503 when retries are exhausted.
 */
class TransientTransactionError extends AppError {
  constructor(
    message = 'Transient write conflict encountered in database transaction',
    details = null
  ) {
    super(
      message,
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      ERROR_CODES.TRANSIENT_TRANSACTION_ERROR,
      details
    );
  }
}

/** The write model is unreachable — only the affected shard/workload is impacted. */
class DatabaseUnavailableError extends AppError {
  constructor(message = 'Database is temporarily unavailable', details = null) {
    super(message, HTTP_STATUS.SERVICE_UNAVAILABLE, ERROR_CODES.DATABASE_UNAVAILABLE, details);
  }
}

class NotImplementedError extends AppError {
  constructor(message = 'Not implemented', details = null) {
    super(message, HTTP_STATUS.NOT_IMPLEMENTED, ERROR_CODES.NOT_IMPLEMENTED, details);
  }
}

module.exports = {
  AppError,
  NotFoundError,
  ValidationError,
  SoldOutError,
  SeatUnavailableError,
  VersionConflictError,
  DuplicateBookingError,
  DuplicateEntryError,
  DuplicateUserError,
  HoldExpiredError,
  PaymentFailedError,
  InvariantViolationError,
  IdempotencyConflictError,
  UnauthenticatedError,
  InvalidCredentialsError,
  TokenExpiredError,
  TokenInvalidError,
  ForbiddenError,
  RateLimitedError,
  TransientTransactionError,
  DatabaseUnavailableError,
  NotImplementedError
};
