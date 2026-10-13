const mongoose = require('mongoose');
const { ValidationError } = require('../utils/errors');
const { FLIGHT_STATUS, SEAT_STATUS } = require('../config/constants');

/**
 * Helper to test if a string is a valid 24-hex-char MongoDB ObjectId.
 */
function isValidObjectId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id) && mongoose.Types.ObjectId.isValid(id);
}

/**
 * Validates request payload for booking creation.
 */
function validateCreateBooking(req, res, next) {
  const { flightId, seatNumber, passengerId, idempotencyKey } = req.body || {};
  const details = [];

  if (!flightId || typeof flightId !== 'string' || !flightId.trim()) {
    details.push({ field: 'flightId', message: 'flightId is required' });
  } else if (!isValidObjectId(flightId.trim())) {
    details.push({ field: 'flightId', message: 'flightId must be a valid 24-character hex ObjectId' });
  }

  if (!seatNumber || typeof seatNumber !== 'string' || !seatNumber.trim()) {
    details.push({ field: 'seatNumber', message: 'seatNumber is required' });
  }

  if (!passengerId || typeof passengerId !== 'string' || !passengerId.trim()) {
    details.push({ field: 'passengerId', message: 'passengerId is required' });
  }

  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 128) {
      details.push({ field: 'idempotencyKey', message: 'idempotencyKey must be a string up to 128 characters' });
    }
  }

  if (details.length > 0) {
    const errorMsg = details.map((d) => d.message).join('; ');
    return next(new ValidationError(errorMsg, details));
  }

  next();
}

/**
 * Validates that flightId parameter in URL is a valid ObjectId.
 */
function validateFlightIdParam(req, res, next) {
  const { flightId } = req.params;

  if (!flightId || !isValidObjectId(flightId)) {
    return next(
      new ValidationError('Invalid flight ID format; must be a 24-character hex ObjectId', [
        { field: 'flightId', message: 'Must be a valid 24-character hex ObjectId' }
      ])
    );
  }

  next();
}

/**
 * Validates query parameters when querying flight seats.
 */
function validateFlightSeatsQuery(req, res, next) {
  const { status } = req.query;
  const validStatuses = Object.values(SEAT_STATUS);

  if (status && !validStatuses.includes(status.toUpperCase())) {
    return next(
      new ValidationError(`Invalid seat status filter. Allowed values: ${validStatuses.join(', ')}`, [
        { field: 'status', message: `Allowed values are: ${validStatuses.join(', ')}` }
      ])
    );
  }

  next();
}

/**
 * Validates query parameters when filtering/searching flights.
 */
function validateFlightSearchQuery(req, res, next) {
  const { maxPrice, minAvailableSeats, hasAvailableSeats, status } = req.query;
  const details = [];

  if (maxPrice !== undefined) {
    const priceNum = Number(maxPrice);
    if (isNaN(priceNum) || priceNum < 0) {
      details.push({ field: 'maxPrice', message: 'maxPrice must be a non-negative number' });
    }
  }

  if (minAvailableSeats !== undefined) {
    const seatsNum = Number(minAvailableSeats);
    if (isNaN(seatsNum) || seatsNum < 0 || !Number.isInteger(seatsNum)) {
      details.push({ field: 'minAvailableSeats', message: 'minAvailableSeats must be a non-negative integer' });
    }
  }

  if (hasAvailableSeats !== undefined) {
    if (hasAvailableSeats !== 'true' && hasAvailableSeats !== 'false') {
      details.push({ field: 'hasAvailableSeats', message: "hasAvailableSeats must be 'true' or 'false'" });
    }
  }

  if (status !== undefined) {
    const validFlightStatuses = Object.values(FLIGHT_STATUS);
    if (!validFlightStatuses.includes(status.toUpperCase())) {
      details.push({
        field: 'status',
        message: `status must be one of: ${validFlightStatuses.join(', ')}`
      });
    }
  }

  if (details.length > 0) {
    const errorMsg = details.map((d) => d.message).join('; ');
    return next(new ValidationError(errorMsg, details));
  }

  next();
}

/**
 * Validates bookingId parameter (either ObjectId or reference string).
 */
function validateBookingIdentifierParam(req, res, next) {
  const { bookingId } = req.params;

  if (!bookingId || typeof bookingId !== 'string' || !bookingId.trim()) {
    return next(
      new ValidationError('Booking identifier parameter is required', [
        { field: 'bookingId', message: 'Booking identifier cannot be empty' }
      ])
    );
  }

  next();
}

module.exports = {
  isValidObjectId,
  validateCreateBooking,
  validateFlightIdParam,
  validateFlightSeatsQuery,
  validateFlightSearchQuery,
  validateBookingIdentifierParam
};
