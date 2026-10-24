/**
 * Path/query identifier validation.
 *
 * `validate` produces VALIDATION_ERROR for a bad value, which is right for a field in a
 * body. An identifier in the URL is a different failure: the caller named a resource
 * that cannot exist, and the documented code for that is INVALID_ID with the offending
 * parameter named. Both are 400, but a client branches on `code`, and "your id is not an
 * id" and "your body is missing a field" are different bugs on their side.
 */
const errors = require('../utils/errors');
const { ERROR_CODES, HTTP_STATUS } = require('../config/constants');
const { isUuid } = require('./validate');

function invalidId(param) {
  return new errors.AppError(`Invalid ${param}: expected a UUID`, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.INVALID_ID, {
    param
  });
}

/**
 * @param {...string} names — parameters that must be UUIDs.
 * @returns {import('express').RequestHandler}
 */
function validateIdParam(...names) {
  return function validateIdParamMiddleware(req, res, next) {
    for (const name of names) {
      const value = req.params ? req.params[name] : undefined;
      if (!isUuid(value)) return next(invalidId(name));
    }
    return next();
  };
}

/**
 * Validates an optional UUID in the query string.
 *
 * Optional because most callers ask an unscoped question; present-but-malformed is still
 * an error, since silently ignoring it would answer a different question than the one
 * asked.
 */
function validateUuidQuery(...names) {
  return function validateUuidQueryMiddleware(req, res, next) {
    for (const name of names) {
      const value = req.query ? req.query[name] : undefined;
      if (value === undefined || value === null || value === '') continue;
      if (!isUuid(value)) return next(invalidId(name));
    }
    return next();
  };
}

module.exports = { validateIdParam, validateUuidQuery, invalidId };
