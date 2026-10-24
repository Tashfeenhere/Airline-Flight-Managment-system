/**
 * Authentication and authorization middleware.
 *
 * Access tokens are verified locally (no round trip to an auth service), so this is
 * the gate that decides who a request runs as and what it is allowed to touch. It
 * separates three concerns that are easy to conflate:
 *
 *   - authentication (authenticate/optionalAuth): is the caller a valid token holder?
 *   - vertical privilege (requireRole): is their role allowed to perform the action?
 *   - horizontal privilege (requireSelf): may they act on THIS specific record?
 *
 * The last one matters most here: a token proves a passenger is logged in, not that
 * the booking id in the URL is theirs. Without requireSelf a valid token could read
 * or cancel any other passenger's booking.
 */
const env = require('../config/env');
const { USER_ROLES, HEADERS } = require('../config/constants');
const { UnauthenticatedError, ForbiddenError } = require('../utils/errors');
const { verifyAccessToken } = require('../auth/tokens');

function readAuthorizationHeader(req) {
  // Prefer the case-insensitive accessor; fall back to the raw bag for test fakes.
  if (typeof req.get === 'function') {
    const viaGetter = req.get(HEADERS.AUTHORIZATION);
    if (typeof viaGetter === 'string') return viaGetter;
  }
  const raw = req.headers ? req.headers[HEADERS.AUTHORIZATION] : undefined;
  return typeof raw === 'string' ? raw : null;
}

/** Splits 'Bearer <token>' into its scheme and credential. */
function splitAuthorization(value) {
  const trimmed = String(value).trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) return { scheme: trimmed, token: '' };
  return {
    scheme: trimmed.slice(0, spaceIndex),
    token: trimmed.slice(spaceIndex + 1).trim()
  };
}

/**
 * @param {{ required?: boolean }} [options]
 *   required=true  (default) a missing/malformed header is a 401.
 *   required=false a MISSING header is allowed and leaves `req.user = null` (used by
 *                  endpoints that behave differently for signed-in callers but still
 *                  serve anonymous ones). A malformed or invalid credential is still
 *                  rejected — the client meant to authenticate and got it wrong.
 */
function authenticate(options = {}) {
  const required = options.required !== false;

  return function authenticateMiddleware(req, res, next) {
    const header = readAuthorizationHeader(req);

    if (!header) {
      if (required) {
        return next(new UnauthenticatedError('Authorization header is required'));
      }
      req.user = null;
      return next();
    }

    const { scheme, token } = splitAuthorization(header);
    if (scheme.toLowerCase() !== 'bearer' || !token) {
      return next(new UnauthenticatedError('Authorization header must use the "Bearer <token>" scheme'));
    }

    try {
      const payload = verifyAccessToken(token);
      const userId = payload.sub || payload.userId;

      // A verified access token that identifies no subject is unusable and would
      // make requireSelf compare against undefined; treat it as invalid.
      if (!userId) {
        return next(new UnauthenticatedError('Access token does not identify a subject'));
      }

      req.user = {
        userId,
        email: payload.email || null,
        role: payload.role || null,
        jti: payload.jti || null
      };
      return next();
    } catch (err) {
      // verifyAccessToken already throws the right AppError subclass (expired vs
      // invalid); forwarding it unchanged preserves that distinction for the client.
      return next(err);
    }
  };
}

/** Authentication that never rejects an anonymous caller — `req.user` is null then. */
const optionalAuth = authenticate({ required: false });

/**
 * Vertical privilege check. Role comparison is case-insensitive so a token claim and
 * the USER_ROLES enum cannot fail to match over letter casing.
 */
function requireRole(...roles) {
  const allowed = roles.map((role) => String(role).toUpperCase());

  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) {
      return next(new UnauthenticatedError('Authentication is required'));
    }

    const role = req.user.role ? String(req.user.role).toUpperCase() : null;
    if (!role || !allowed.includes(role)) {
      return next(
        new ForbiddenError(`This action requires one of the following roles: ${roles.join(', ')}`)
      );
    }

    return next();
  };
}

/**
 * Horizontal privilege check: the caller may act only on their own resource, unless
 * they are an admin. This is what stops a valid token from reading or cancelling a
 * booking that belongs to someone else.
 *
 * @param {string} paramName — the route parameter holding the owner's user id.
 */
function requireSelf(paramName) {
  return function requireSelfMiddleware(req, res, next) {
    if (!req.user) {
      return next(new UnauthenticatedError('Authentication is required'));
    }

    const target = req.params ? req.params[paramName] : undefined;
    const isSelf = target !== undefined && target !== null && String(req.user.userId) === String(target);
    const isAdmin = String(req.user.role).toUpperCase() === USER_ROLES.ADMIN;

    if (!isSelf && !isAdmin) {
      return next(new ForbiddenError('You may only access your own resources'));
    }

    return next();
  };
}

/**
 * Resolves the user a booking should be attributed to.
 *
 * The original prototype allowed anonymous bookings, and that contract is preserved
 * until real user accounts are loaded: with REQUIRE_AUTH_FOR_BOOKING off, an
 * unauthenticated booking is attributed to a well-known guest identity so it still
 * has a stable owner. Flip the flag on to make authentication mandatory.
 */
function resolveBookingUser(req) {
  if (req.user && req.user.userId) return req.user.userId;

  if (env.REQUIRE_AUTH_FOR_BOOKING) {
    throw new UnauthenticatedError('Authentication is required to create a booking');
  }

  return env.GUEST_USER_ID;
}

module.exports = {
  authenticate,
  optionalAuth,
  requireRole,
  requireSelf,
  resolveBookingUser
};
