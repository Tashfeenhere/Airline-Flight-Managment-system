/**
 * One structured access log line per finished request.
 *
 * Emitted from the response `finish` event rather than on entry: only then is the
 * final status code and byte count known, and only then does the duration reflect
 * the whole handler pipeline. In and out logging (two lines) would double the log
 * volume for no additional signal.
 *
 * The read-model lag header is captured when present so a search response can be
 * tied back to how stale the projection it was served from actually was.
 */
const env = require('../config/env');
const logger = require('../utils/logger');
const { HEADERS } = require('../config/constants');

function requestLogger(req, res, next) {
  // The test suite drives hundreds of requests; emitting a JSON line for each one
  // drowns the reporter output and slows CI down for no benefit.
  if (env.isTest) return next();

  const startedAt = Date.now();

  res.on('finish', () => {
    const status = res.statusCode;
    const durationMs = Date.now() - startedAt;

    // `req.route` is populated only once the request has reached a matched route
    // handler, so prefer its template ('/api/bookings/:id') over the raw path —
    // templates aggregate in metrics, raw paths explode into one bucket per id.
    const route = (req.route && req.route.path) || req.path;

    const contentLength = res.getHeader('content-length');
    const lagHeader = res.getHeader(HEADERS.READ_MODEL_LAG);

    const meta = {
      method: req.method,
      route,
      status,
      durationMs,
      requestId: req.context ? req.context.requestId : null,
      nodeId: env.NODE_ID,
      contentLength: contentLength === undefined ? null : Number(contentLength)
    };

    if (lagHeader !== undefined && lagHeader !== null) {
      meta.readModelLagMs = Number(lagHeader);
    }

    // Server faults deserve error level (they page); client mistakes warn; the
    // rest is ordinary traffic.
    if (status >= 500) {
      logger.error('Request completed', meta);
    } else if (status >= 400) {
      logger.warn('Request completed', meta);
    } else {
      logger.info('Request completed', meta);
    }
  });

  next();
}

module.exports = requestLogger;
