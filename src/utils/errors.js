const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

/**
 * Base operational error class for the application.
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

class SeatUnavailableError extends AppError {
  constructor(message = 'Requested seat is no longer available', details = null) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.SEAT_UNAVAILABLE, details);
  }
}

class VersionConflictError extends AppError {
  constructor(
    message = 'Optimistic concurrency version conflict: seat state modified by another node',
    details = null
  ) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.VERSION_CONFLICT, details);
  }
}

class DuplicateBookingError extends AppError {
  constructor(message = 'A confirmed booking already exists for this seat', details = null) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.DUPLICATE_BOOKING, details);
  }
}

class TransientTransactionError extends AppError {
  constructor(
    message = 'Transient write conflict encountered in database transaction',
    details = null
  ) {
    super(message, HTTP_STATUS.SERVICE_UNAVAILABLE, ERROR_CODES.TRANSIENT_TRANSACTION_ERROR, details);
  }
}

module.exports = {
  AppError,
  NotFoundError,
  ValidationError,
  SeatUnavailableError,
  VersionConflictError,
  DuplicateBookingError,
  TransientTransactionError
};
