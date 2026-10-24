/**
 * HTTP request metrics.
 *
 * The `route` label must be the *pattern* (`/api/flights/:flightId`), never the
 * concrete path. A path with an id in it is unbounded — at 50M flights, one series
 * per flight id is not a metric, it is a memory leak with a query interface — so the
 * label is built from `req.baseUrl + req.route.path`, which is the template Express
 * matched.
 *
 * A request that matched no route has no template, and it must still be counted:
 * dropping it would make a flood of 404s invisible in exactly the graph an operator
 * would look at. Every unmatched request collapses into the single `unmatched` label
 * instead, which is bounded by construction.
 */
const metrics = require('../observability/metrics');

const UNMATCHED = 'unmatched';

function routeLabel(req) {
  if (!req.route || !req.route.path) return UNMATCHED;
  const base = req.baseUrl || '';
  const path = req.route.path === '/' ? '' : req.route.path;
  return `${base}${path}` || '/';
}

function httpMetrics(req, res, next) {
  if (!metrics.metricsEnabled) return next();

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status: String(res.statusCode)
    };

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    // Guarded like every other metric call in this codebase: a metrics failure must
    // never turn a successful response into a 500, and `finish` runs after the
    // response has already been written in any case.
    try {
      metrics.httpRequestsTotal.inc(labels);
      metrics.httpRequestDurationMs.observe(labels, durationMs);
    } catch (err) {
      // Intentionally swallowed — see above.
    }
  });

  next();
}

module.exports = httpMetrics;
module.exports.routeLabel = routeLabel;
module.exports.UNMATCHED = UNMATCHED;
