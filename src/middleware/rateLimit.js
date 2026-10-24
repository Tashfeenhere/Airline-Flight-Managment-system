/**
 * Per-IP rate limiting.
 *
 * Three profiles share one factory so the response envelope, headers and bypass
 * behaviour stay identical:
 *   - apiRateLimit     general ceiling for the whole API surface;
 *   - authRateLimit    tighter, on login/register/refresh, to blunt credential
 *                      stuffing and refresh-token brute force;
 *   - bookingRateLimit strictest, on POST /api/bookings, because each accepted
 *                      booking consumes scarce, non-fungible inventory.
 *
 * Every limiter is a straight pass-through when limiting is disabled or under test.
 * The test suite fires hundreds of requests through the same fake IP, so an active
 * limiter would turn correct tests into 429s and make CI flaky — the limiters are
 * proven by unit tests around the factory, not by starving the suite.
 *
 * Note on client identity: behind a load balancer `req.ip` is the PROXY's address
 * unless the app trusts the forwarded chain. The app sets
 * `app.set('trust proxy', ...)` from env.TRUST_PROXY; without it every request shares
 * one bucket (all clients throttled together), so deploying behind a proxy and
 * leaving TRUST_PROXY unset is a configuration bug, not a limiter bug.
 */
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { RateLimitedError } = require('../utils/errors');

const ONE_MINUTE_MS = 60 * 1000;

function buildRateLimiter({ windowMs, limit, name }) {
  // Bypass entirely — see the module comment for why the test environment is exempt.
  if (!env.RATE_LIMIT_ENABLED || env.isTest) {
    return function disabledRateLimit(req, res, next) {
      next();
    };
  }

  return rateLimit({
    windowMs,
    limit,
    // Draft-7 emits the standardised RateLimit-* headers and drops the legacy,
    // non-standard X-RateLimit-* ones.
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Forward a RateLimitedError instead of letting the library write its own body,
    // so a throttled request is indistinguishable in shape from every other error.
    handler: (req, res, next, options) => {
      next(
        new RateLimitedError(`Too many requests: the ${name} rate limit was exceeded`, {
          limit: options.limit,
          windowMs: options.windowMs
        })
      );
    }
  });
}

const apiRateLimit = buildRateLimiter({
  windowMs: ONE_MINUTE_MS,
  limit: env.API_RATE_LIMIT_PER_MIN,
  name: 'api'
});

const authRateLimit = buildRateLimiter({
  windowMs: ONE_MINUTE_MS,
  limit: env.AUTH_RATE_LIMIT_PER_MIN,
  name: 'auth'
});

// Derive the booking budget from the general budget rather than adding a new env
// var: it stays proportional when operators retune API_RATE_LIMIT_PER_MIN, with a
// floor of 10/min so a small general limit cannot crush legitimate booking traffic.
const bookingLimit = Math.max(10, Math.floor(env.API_RATE_LIMIT_PER_MIN / 6));

const bookingRateLimit = buildRateLimiter({
  windowMs: ONE_MINUTE_MS,
  limit: bookingLimit,
  name: 'booking'
});

module.exports = {
  apiRateLimit,
  authRateLimit,
  bookingRateLimit
};
