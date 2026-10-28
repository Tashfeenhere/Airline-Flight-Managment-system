/**
 * Flight routes. All public — browsing a schedule requires no account, which is what
 * makes the read path independently scalable from the write path.
 *
 * The two consistency levels are visible in the paths themselves:
 * `/search` reads the projection, `/{id}/availability` reads the write model. A client
 * that needs to book reads availability first, because only that answer carries the
 * `version` the booking will be checked against.
 */
const express = require('express');
const controller = require('../controllers/flightController');
const validate = require('../middleware/validate');
const asyncHandler = require('../middleware/asyncHandler');
const { validateIdParam } = require('../middleware/validateId');
const { apiRateLimit } = require('../middleware/rateLimit');
const { CABINS } = require('../config/constants');

const router = express.Router();

const limit = { type: 'integer', min: 1, max: 200, default: 20 };
const offset = { type: 'integer', min: 0, default: 0 };
const cabin = { type: 'string', enum: [...CABINS] };

router.get(
  '/search',
  apiRateLimit,
  validate({
    query: {
      // Three letters, either case: the write model stores IATA codes uppercase, and
      // the controller uppercases before querying, so accepting "isb" from a human is
      // not a validation error — it is the same airport.
      // Optional airport codes (empty or 3 letters)
      origin: { type: 'string', required: false, trim: true, pattern: /^$|^[A-Za-z]{3}$/ },
      destination: { type: 'string', required: false, trim: true, pattern: /^$|^[A-Za-z]{3}$/ },
      departureDate: { type: 'date', required: false },
      cabin: { type: 'string', enum: [...CABINS, ''], required: false },
      passengers: { type: 'integer', min: 1, max: 9, default: 1 },
      limit,
      offset
    }
  }),
  asyncHandler(controller.search)
);

router.get(
  '/:flightId',
  apiRateLimit,
  validateIdParam('flightId'),
  asyncHandler(controller.getFlight)
);

router.get(
  '/:flightId/seatmap',
  apiRateLimit,
  validateIdParam('flightId'),
  validate({ query: { cabin } }),
  asyncHandler(controller.getSeatMap)
);

router.get(
  '/:flightId/availability',
  apiRateLimit,
  validateIdParam('flightId'),
  validate({ query: { cabin } }),
  asyncHandler(controller.getAvailability)
);

module.exports = { router, path: '/api/flights' };
