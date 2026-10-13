const env = require('../config/env');
const logger = require('../utils/logger');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

/**
 * Centralized Express error-handling middleware.
 * Translates operational errors, Mongoose/MongoDB errors, and unexpected exceptions
 * into structured, meaningful JSON responses.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  let statusCode = err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
  let code = err.code || ERROR_CODES.INTERNAL_ERROR;
  let message = err.message || 'An unexpected error occurred';
  let details = err.details || null;

  // Handle Mongoose Schema Validation Error
  if (err.name === 'ValidationError' && err.errors) {
    statusCode = HTTP_STATUS.BAD_REQUEST;
    code = ERROR_CODES.VALIDATION_ERROR;
    const validationErrors = Object.entries(err.errors).map(([field, errorObj]) => ({
      field,
      message: errorObj.message
    }));
    message = validationErrors.map((e) => e.message).join(', ');
    details = validationErrors;
  }

  // Handle Mongoose CastError (e.g., malformed ObjectId)
  if (err.name === 'CastError') {
    statusCode = HTTP_STATUS.BAD_REQUEST;
    code = ERROR_CODES.INVALID_ID;
    message = `Invalid value for parameter '${err.path}'`;
    details = [{ field: err.path, message: `Expected valid ${err.kind}` }];
  }

  // Handle MongoDB Unique Constraint Violation (E11000)
  if (err.code === 11000) {
    statusCode = HTTP_STATUS.CONFLICT;
    code = ERROR_CODES.DUPLICATE_ENTRY;
    message = 'A conflicting record already exists in the database';
  }

  // Log non-operational / unhandled server errors
  if (!err.isOperational && statusCode === HTTP_STATUS.INTERNAL_SERVER_ERROR) {
    logger.error('Unhandled Server Error:', {
      error: err.message,
      stack: err.stack,
      url: req.originalUrl,
      method: req.method
    });

    if (env.NODE_ENV === 'production') {
      message = 'An unexpected internal server error occurred';
      details = null;
    }
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    },
    nodeId: env.NODE_ID,
    timestamp: new Date().toISOString()
  });
}

module.exports = errorHandler;
