/**
 * Auth routes.
 *
 * The credential endpoints are rate limited much more tightly than the rest of the
 * API (`authRateLimit`), because they are the only ones where a caller's success is a
 * function of how many guesses they can make. `/me` is not: it requires a token the
 * caller already holds, so guessing gains nothing, and it sits under the ordinary API
 * budget.
 */
const express = require('express');
const controller = require('../controllers/authController');
const validate = require('../middleware/validate');
const asyncHandler = require('../middleware/asyncHandler');
const { authenticate, optionalAuth } = require('../middleware/authenticate');
const { authRateLimit, apiRateLimit } = require('../middleware/rateLimit');
const { USER_ROLES } = require('../config/constants');

const router = express.Router();

const email = { type: 'string', required: true, trim: true, lowercase: true, maxLength: 254 };
const password = { type: 'string', required: true, minLength: 8, maxLength: 128 };

router.post(
  '/register',
  authRateLimit,
  validate({
    body: {
      email,
      password,
      fullName: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 200 },
      phone: { type: 'string', trim: true, maxLength: 32 },
      // Accepted and validated, then ignored by the service: self-registration only
      // ever creates a PASSENGER. Rejecting the field outright would be clearer still,
      // but the contract documents it, so it must not be an unknown-field surprise.
      role: { type: 'string', enum: [USER_ROLES.PASSENGER] }
    }
  }),
  asyncHandler(controller.register)
);

router.post(
  '/login',
  authRateLimit,
  validate({
    body: {
      email,
      password,
      code: { type: 'string', minLength: 6, maxLength: 6 }
    }
  }),
  asyncHandler(controller.login)
);

router.post(
  '/verify-2fa',
  authRateLimit,
  validate({
    body: {
      tempToken: { type: 'string', required: true, minLength: 1 },
      code: { type: 'string', required: true, minLength: 6, maxLength: 6 }
    }
  }),
  asyncHandler(controller.verify2FA)
);

router.post(
  '/verify-email',
  authRateLimit,
  validate({
    body: {
      email,
      code: { type: 'string', required: true, minLength: 6, maxLength: 6 }
    }
  }),
  asyncHandler(controller.verifyEmail)
);

router.post(
  '/resend-code',
  authRateLimit,
  asyncHandler(controller.resendCode)
);

router.post(
  '/refresh',
  authRateLimit,
  validate({ body: { refreshToken: { type: 'string', required: true, minLength: 1 } } }),
  asyncHandler(controller.refresh)
);

router.post(
  '/logout',
  authRateLimit,
  // Optional rather than required: a client whose access token has already expired
  // must still be able to revoke its refresh token. Requiring a live access token to
  // log out is how a user ends up unable to end a session.
  optionalAuth,
  validate({ body: { refreshToken: { type: 'string', required: true, minLength: 1 } } }),
  asyncHandler(controller.logout)
);

router.get('/me', apiRateLimit, authenticate(), asyncHandler(controller.me));

module.exports = { router, path: '/api/auth' };
