/**
 * The Express application.
 *
 * Exported as a factory rather than as a module-level singleton because the test suite
 * builds a fresh app per file: a shared app would carry one file's mounted state and
 * rate-limit counters into the next, and `supertest` would be exercising a process that
 * has already served hundreds of unrelated requests.
 *
 * The middleware order below is load-bearing, from the outside in:
 *
 *   trust proxy   before anything reads `req.ip`, or every rate limiter sees the LB;
 *   helmet/cors   before routing, so an error response carries the same headers;
 *   compression   before routing;
 *   body parser   after the security headers, and bounded — an unbounded JSON body is
 *                 a free denial of service on a 40MB `cabins` array;
 *   requestContext/logger/metrics   wrap the handlers, so a crash still has an id;
 *   routes        then the terminal 404, then the single error handler.
 *
 * The error handler is registered last and takes four arguments: Express selects error
 * middleware by arity, so a three-argument version would be treated as an ordinary
 * handler and never called.
 */
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const env = require('./config/env');
const logger = require('./utils/logger');
const { HEADERS } = require('./config/constants');
const requestContext = require('./middleware/requestContext');
const requestLogger = require('./middleware/requestLogger');
const httpMetrics = require('./middleware/httpMetrics');
const errorHandler = require('./middleware/errorHandler');
const buildRouter = require('./routes');

/**
 * Body size ceiling.
 *
 * The largest legitimate body is an admin flight upsert with a dozen cabins — a few
 * kilobytes. 1MB leaves two orders of magnitude of headroom for a bulk-friendly batch
 * without letting one caller allocate an arbitrary amount of memory per request.
 */
const JSON_BODY_LIMIT = '1mb';

/**
 * CORS.
 *
 * `*` (the default) is served as a literal wildcard with no credentials, which is what
 * makes the public read endpoints usable from any browser. A configured origin list is
 * echoed back per request instead, so `Access-Control-Allow-Origin` is never a wildcard
 * alongside `Allow-Credentials` — a combination browsers reject anyway, and one that
 * silently breaks the first client that tries to send a cookie.
 */
function corsOptions() {
  const origins = env.CORS_ORIGINS;
  const wildcard = origins.includes('*');

  return {
    origin: wildcard ? '*' : origins,
    credentials: !wildcard,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', HEADERS.IDEMPOTENCY_KEY],
    // Let a browser client read the values that make retry and freshness decisions.
    exposedHeaders: [
      HEADERS.NODE_ID,
      HEADERS.IDEMPOTENCY_KEY,
      HEADERS.READ_MODEL_LAG,
      'Idempotent-Replay',
      'RateLimit',
      'RateLimit-Policy'
    ],
    maxAge: 600
  };
}

/**
 * `trust proxy` accepts either a boolean-ish flag ('true'/'false') or an Express trust
 * expression (a hop count, an IP list, a subnet). Passing the raw string through is
 * deliberate: Express understands 'loopback', '1', and the numeric form, and guessing
 * on its behalf would reject configurations it supports.
 */
function trustProxyValue() {
  const raw = env.TRUST_PROXY;
  if (raw === null || raw === undefined || raw === '') return false;
  const normalised = String(raw).trim().toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  return raw;
}

function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyValue());

  // `crossOriginResourcePolicy` is relaxed to same-site rather than same-origin: the
  // Swagger UI and the JSON API are served from this same origin, but a separate
  // front-end origin reading the API in a browser is the intended deployment.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: env.isProduction ? undefined : false
    })
  );

  app.use(cors(corsOptions()));
  app.use(compression());

  app.use(requestContext);
  app.use(requestLogger);
  app.use(httpMetrics);

  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  // Form encoding is accepted only for the JSON-ish content type a browser sends when
  // it is not using fetch; the API itself is JSON-only.
  app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }));

  app.use(buildRouter());

  // The router ends with the terminal 404, which raises a NotFoundError rather than
  // writing a response itself. This handler is what renders both it and every other
  // failure, which is what keeps the error envelope identical everywhere.
  app.use(errorHandler);

  return app;
}

/**
 * Startup diagnostics that are cheap to check and expensive to discover in production.
 * Called by the server on boot, not per request.
 */
function warnOnRiskyConfig() {
  if (env.isProduction) {
    if (!env.TRUST_PROXY) {
      logger.warn(
        'TRUST_PROXY is unset in production: req.ip will be the load balancer address, so every ' +
          'client shares one rate-limit bucket.'
      );
    }
    if (String(env.JWT_ACCESS_SECRET).startsWith('dev-only-')) {
      logger.warn('JWT_ACCESS_SECRET is still the development default. Set a real secret.');
    }
  }

  if (env.CORS_ORIGINS.includes('*') && env.isProduction) {
    logger.warn('CORS_ORIGINS is "*" in production: any origin may call the API from a browser.');
  }
}

module.exports = buildApp;
module.exports.buildApp = buildApp;
module.exports.warnOnRiskyConfig = warnOnRiskyConfig;
