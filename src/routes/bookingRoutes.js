/**
 * Booking routes.
 *
 * `POST /` is the only place authentication is optional, and only because
 * `REQUIRE_AUTH_FOR_BOOKING` can be off: `optionalAuth` means "if a token is here, use
 * it", and `resolveBookingUser` turns the absence into the guest identity. Reading or
 * cancelling a booking always requires a token — there is no way to prove an anonymous
 * caller is the same anonymous caller who booked, and both of those operations disclose
 * or release somebody's seat.
 *
 * `/reference/:bookingReference` is declared before `/:bookingId` deliberately.
 * Express matches in declaration order, and `validateIdParam('bookingId')` rejects the
 * literal string "reference" as a malformed id — so the reverse order would answer a
 * perfectly valid reference lookup with INVALID_ID.
 */
const express = require('express');
const controller = require('../controllers/bookingController');
const validate = require('../middleware/validate');
const asyncHandler = require('../middleware/asyncHandler');
const { validateIdParam } = require('../middleware/validateId');
const { authenticate, optionalAuth } = require('../middleware/authenticate');
const { bookingRateLimit } = require('../middleware/rateLimit');
const { idempotencyKey } = require('../middleware/idempotencyKey');
const { CABINS } = require('../config/constants');

const router = express.Router();

router.post(
  '/',
  // The rate limit runs before the body is validated so a flood is rejected on the
  // cheapest possible path. It is the strictest profile in the app: each accepted
  // booking consumes inventory that cannot be conjured back.
  bookingRateLimit,
  optionalAuth,
  idempotencyKey,
  validate({
    body: {
      flightId: { type: 'uuid', required: true },
      cabin: { type: 'string', enum: [...CABINS] },
      passengerName: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 200 },
      passengerRef: { type: 'string', trim: true, maxLength: 100 },
      passengerId: { type: 'string', trim: true, maxLength: 100 },
      // Either case is accepted and the controller uppercases it: the column's check
      // constraint stores seat numbers uppercase, and a web form that submits "12a"
      // is not making a mistake worth a validation error.
      seatNumber: { type: 'string', trim: true, pattern: /^[0-9]{1,3}[A-Za-z]$/ },
      expectedVersion: { type: 'integer', min: 0 }
    }
  }),
  asyncHandler(controller.create)
);

router.get(
  '/reference/:bookingReference',
  authenticate(),
  asyncHandler(controller.getByReference)
);

router.get(
  '/:bookingId',
  authenticate(),
  validateIdParam('bookingId'),
  asyncHandler(controller.get)
);

router.post(
  '/:bookingId/cancel',
  authenticate(),
  validateIdParam('bookingId'),
  validate({
    body: {
      reason: { type: 'string', trim: true, maxLength: 200 }
    }
  }),
  asyncHandler(controller.cancel)
);

module.exports = { router, path: '/api/bookings' };
