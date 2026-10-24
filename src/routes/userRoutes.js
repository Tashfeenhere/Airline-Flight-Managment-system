/**
 * User routes.
 *
 * `/me/bookings` reads the caller's own projection, so there is no id in the path and
 * nothing to authorize: the token *is* the query. `limit`/`offset` are bounded here
 * rather than trusted, because the projection is the one read path a logged-in user can
 * hammer without any per-record cost being visible to them.
 */
const express = require('express');
const controller = require('../controllers/userController');
const validate = require('../middleware/validate');
const asyncHandler = require('../middleware/asyncHandler');
const { authenticate } = require('../middleware/authenticate');
const { apiRateLimit } = require('../middleware/rateLimit');
const { BOOKING_STATUS } = require('../config/constants');

const router = express.Router();

router.get(
  '/me/bookings',
  apiRateLimit,
  authenticate(),
  validate({
    query: {
      status: { type: 'string', enum: Object.values(BOOKING_STATUS) },
      limit: { type: 'integer', min: 1, max: 200, default: 20 },
      offset: { type: 'integer', min: 0, default: 0 }
    }
  }),
  asyncHandler(controller.listMyBookings)
);

module.exports = { router, path: '/api/users' };
