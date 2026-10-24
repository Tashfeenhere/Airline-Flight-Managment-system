/**
 * The HTTP surface, assembled in one place.
 *
 * Every router module exports `{ router, path }` rather than hard-coding its own mount
 * point. That is what lets this file be the single description of the API's shape — the
 * list below *is* the route table — and it is what lets the OpenAPI document's paths
 * (`/api/flights/{flightId}`) be checked against real mounts instead of hoped for.
 *
 * Order matters twice here:
 *
 *   - `/metrics` is not under `/api`, so it is mounted before the routers whose paths
 *     all begin with `/api`. It would still match either way, but keeping the odd one
 *     out first makes the exception visible.
 *   - `notFound` is last, and only last. Any handler registered after it would be
 *     unreachable, since it answers every request that fell through.
 */
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const spec = require('../openapi/swaggerSpec');
const notFound = require('../middleware/notFound');

const authRoutes = require('./authRoutes');
const flightRoutes = require('./flightRoutes');
const bookingRoutes = require('./bookingRoutes');
const userRoutes = require('./userRoutes');
const healthRoutes = require('./healthRoutes');
const adminRoutes = require('./adminRoutes');
const metricsRoutes = require('./metricsRoutes');

/** Mounted in this order; the array is the API's table of contents. */
const routers = [
  metricsRoutes,
  authRoutes,
  flightRoutes,
  bookingRoutes,
  userRoutes,
  healthRoutes,
  adminRoutes
];

function buildRouter() {
  const router = express.Router();

  for (const { router: child, path } of routers) {
    router.use(path, child);
  }

  // The document itself, and the browsable UI. Served from the same object the app
  // routes were written against, so what a client reads cannot drift from what the
  // handlers do without the diff being visible.
  router.get('/api-docs.json', (req, res) => res.json(spec));
  router.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Airline Inventory API',
      // The raw document is one link away, which is what a client generator wants;
      // burying it under the UI's own JS is how teams end up scraping the HTML.
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true }
    })
  );

  router.use(notFound);

  return router;
}

module.exports = buildRouter;
module.exports.routers = routers;
