/**
 * Admin routes.
 *
 * Every route here is an operational action on the whole cluster — reading the shard
 * topology, creating flights, running DDL, replaying a projection, or reconciling
 * money and inventory. They are grouped behind `authenticate()` + `requireRole('ADMIN')`
 * applied once at the mount point rather than per route, so a new admin endpoint added
 * below cannot be published unauthenticated by forgetting two lines.
 *
 * `requireRole` returns 401 when there is no user and 403 when there is one with the
 * wrong role, which is the distinction the contract documents: an expired token is a
 * "log in again", a passenger's token is a "you will never be allowed".
 */
const express = require('express');
const controller = require('../controllers/adminController');
const validate = require('../middleware/validate');
const asyncHandler = require('../middleware/asyncHandler');
const { authenticate, requireRole } = require('../middleware/authenticate');
const { apiRateLimit } = require('../middleware/rateLimit');
const { CABINS, FLIGHT_STATUS, USER_ROLES } = require('../config/constants');

const router = express.Router();

/** An RFC 3339 instant with an explicit offset — see the note on `departureTime`. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/;

// Applied to every route in this file.
router.use(apiRateLimit, authenticate(), requireRole(USER_ROLES.ADMIN));

router.get('/topology', asyncHandler(controller.topology));

router.post(
  '/flights',
  validate({
    body: {
      // Optional. A bulk loader that supplies its own deterministic ids gets
      // idempotent re-imports; leaving it out makes the database mint a fresh
      // UUIDv7 and a re-run of the same import will create a second flight.
      flightId: { type: 'uuid' },
      // Codes are stored uppercase (IATA designators are uppercase by definition) and
      // accepted in either case here; the controller canonicalises.
      flightNumber: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 12, pattern: /^[A-Za-z0-9-]+$/ },
      airlineCode: { type: 'string', required: true, trim: true, minLength: 2, maxLength: 3, pattern: /^[A-Za-z0-9]+$/ },
      origin: { type: 'string', required: true, trim: true, pattern: /^[A-Za-z]{3}$/ },
      destination: { type: 'string', required: true, trim: true, pattern: /^[A-Za-z]{3}$/ },
      // The offset is mandatory, not cosmetic. `ck_flights_departure_date` requires
      // `departure_date` to be the UTC date of `departure_time`, and a local-time
      // string like "2026-11-03T06:30:00" is parsed in the *server's* zone, so the
      // date this endpoint derives from it would depend on where the process runs.
      departureTime: { type: 'string', required: true, pattern: INSTANT_RE },
      arrivalTime: { type: 'string', required: true, pattern: INSTANT_RE },
      // Optional, and declared here rather than merely accepted by the controller: the
      // validator builds the cleaned body from the schema's own keys, so a field the
      // controller reads but the schema omits is not "optional", it is *gone* — the
      // controller would fall back to deriving the date forever. This is the affordance
      // that lets a caller name the partition month explicitly, so it has to be here.
      departureDate: { type: 'date' },
      aircraftType: { type: 'string', required: true, trim: true, minLength: 1, maxLength: 40 },
      // Bounded at the column's own precision: numeric(10,2) has room for eight integer
      // digits, and a price past that is a SQLSTATE 22003 rather than a useful message.
      basePrice: { type: 'number', required: true, min: 0, max: 99999999.99 },
      currency: { type: 'string', trim: true, pattern: /^[A-Za-z]{3}$/ },
      status: { type: 'string', enum: Object.values(FLIGHT_STATUS) },
      cabins: {
        type: 'array',
        required: true,
        minLength: 1,
        maxLength: 12,
        items: {
          cabin: { type: 'string', required: true, enum: [...CABINS] },
          totalSeats: { type: 'integer', required: true, min: 0, max: 1000 },
          price: { type: 'number', min: 0, max: 99999999.99 }
        }
      }
    }
  }),
  asyncHandler(controller.upsertFlight)
);

router.post(
  '/partitions/maintain',
  validate({
    body: {
      monthsAhead: { type: 'integer', min: 0, max: 36 },
      monthsBehind: { type: 'integer', min: 0, max: 12 },
      retentionMonths: { type: 'integer', min: 1, max: 120 },
      dryRun: { type: 'boolean', default: false },
      // Not in the published schema yet, and reachable only by an operator: a DROP of a
      // partition that still holds rows is refused unless this is set, because that is
      // the difference between retention and data loss. `mode: 'detach'` is the other
      // safe escape — it lifts the partition out of the hierarchy and keeps the table.
      force: { type: 'boolean', default: false },
      mode: { type: 'string', enum: ['drop', 'detach'] }
    }
  }),
  asyncHandler(controller.maintainPartitions)
);

router.post(
  '/projections/reproject',
  validate({
    body: {
      flightIds: { type: 'array', maxLength: 500, items: { type: 'uuid' } },
      from: { type: 'string', pattern: INSTANT_RE },
      to: { type: 'string', pattern: INSTANT_RE },
      force: { type: 'boolean', default: false }
    }
  }),
  asyncHandler(controller.reproject)
);

router.post(
  '/inventory/audit',
  validate({
    body: {
      flightId: { type: 'uuid' },
      departureDate: { type: 'date' },
      cabin: { type: 'string', enum: [...CABINS] },
      limit: { type: 'integer', min: 1, max: 1000, default: 100 }
    }
  }),
  asyncHandler(controller.auditInventory)
);

router.get('/outbox/stats', asyncHandler(controller.outboxStats));

module.exports = { router, path: '/api/admin' };
