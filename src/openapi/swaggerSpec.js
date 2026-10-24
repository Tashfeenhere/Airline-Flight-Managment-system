/**
 * The single assembled OpenAPI 3.0.3 document for the Distributed Airline
 * Inventory API.
 *
 * WHY this is a module rather than a checked-in `openapi.json`: the spec is
 * generated from the same frozen enums (`src/config/constants.js`) and the same
 * port/node identity (`src/config/env.js`) that the running server uses, so it
 * cannot silently drift from behaviour the way a hand-maintained YAML file does.
 * `swagger-ui-express` mounts this object directly:
 *
 *   app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(require('./openapi/swaggerSpec')));
 *   app.get('/api-docs.json', (req, res) => res.json(require('./openapi/swaggerSpec')));
 *
 * The shape is `{ openapi, info, servers, tags, security, paths, components }`
 * exactly as the OpenAPI 3.0.3 specification requires.
 */
'use strict';

const env = require('../config/env');
const { paths, components } = require('./paths');

const DESCRIPTION = [
  'Count-based seat inventory on distributed PostgreSQL (Citus), with an',
  'anti-oversell counter, a booking saga with simulated payments, a CQRS search',
  'read model and a user-sharded "my bookings" projection.',
  '',
  '**Conventions**',
  '',
  '- Every 2xx body is `{ "success": true, "data": ... }`. Every error body is',
  '  `{ "success": false, "error": { "code", "message", "details" }, "nodeId", "timestamp" }`.',
  '- Booking creation is idempotent: send an `Idempotency-Key` header. A retry with',
  '  the same key and body replays the original booking as `200`; the same key with a',
  '  different body is `409 IDEMPOTENCY_CONFLICT`.',
  '- Availability and search are deliberately different consistency levels: search',
  '  reads the lagged projection, availability reads the write model.',
  '- Auth uses a short-lived JWT access token and a long-lived rotating refresh',
  '  token with reuse detection.',
  '',
  'See `docs/API.md` for the full guide.',
].join('\n');

const spec = {
  openapi: '3.0.3',

  info: {
    title: 'Distributed Airline Inventory API',
    version: '2.0.0',
    description: DESCRIPTION,
    contact: { name: 'Platform Engineering' },
    license: { name: 'ISC' },
  },

  // Built from the running configuration so the "Try it out" base URL matches the
  // port the server is actually listening on (PORT defaults to 3000 in env.js).
  servers: [
    {
      url: `http://localhost:${env.PORT}`,
      description: `Local development (NODE_ID=${env.NODE_ID}, PORT=${env.PORT})`,
    },
    {
      url: '/',
      description: 'The host that served this document (reverse proxy / same origin).',
    },
    {
      url: 'https://api.airline-inventory.example.com',
      description: 'Production placeholder - replace with the real host per deployment.',
    },
  ],

  tags: [
    { name: 'auth', description: 'Registration, login and rotating refresh tokens.' },
    { name: 'flights', description: 'Public flight search, detail, seat maps and availability.' },
    { name: 'bookings', description: 'Idempotent booking creation, lookup and cancellation.' },
    { name: 'users', description: 'The authenticated caller\'s own resources.' },
    { name: 'health', description: 'Liveness and readiness probes plus a dependency report.' },
    { name: 'admin', description: 'Operator endpoints. Require the ADMIN role.' },
    { name: 'metrics', description: 'Prometheus scrape endpoint (text/plain, not JSON).' },
  ],

  // Authenticated by default. The handful of public operations opt out with
  // `security: []` (health, metrics, auth entry points, flight search/detail).
  security: [{ bearerAuth: [] }],

  paths,
  components,

  externalDocs: {
    description: 'Human-readable API guide and curl cookbook.',
    url: '/docs/API.md',
  },
};

// Expose the document both as the module root (`require('./swaggerSpec')`) and as
// a named `.spec` export so callers can destructure or namespace it. The property
// is defined non-enumerable on purpose: a plain `spec.spec = spec` self-reference
// would make the object circular and crash JSON.stringify the moment the raw spec
// is served at /api-docs.json.
Object.defineProperty(spec, 'spec', { value: spec, enumerable: false });

module.exports = spec;
