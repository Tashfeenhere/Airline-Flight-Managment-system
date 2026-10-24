/**
 * Admin endpoints: topology, flight upsert, partition maintenance, reprojection,
 * the oversell audit and outbox backlog.
 *
 * Everything here is an operational action on the whole cluster, which is why the
 * routes are behind `requireRole('ADMIN')` and why each handler reports what it did
 * in full rather than a bare "ok". An operator running a retention pass needs to see
 * which partitions went, and an operator replaying a projection needs the numbers —
 * both are the kind of thing that is invisible right up until it is a incident.
 */
const pool = require('../db/pool');
const citus = require('../db/citus');
const partitions = require('../db/partitions');
const env = require('../config/env');
const errors = require('../utils/errors');
const { toIsoString } = require('../repositories/mappers');
const flightService = require('../services/flightService');
const projectionService = require('../services/projectionService');
const inventoryRepository = require('../repositories/inventoryRepository');
const outboxRepository = require('../repositories/outboxRepository');
const { ok } = require('../http/respond');

async function topology(req, res) {
  return ok(res, await citus.topologyReport(pool.writePool));
}

/**
 * Creates or updates a flight and its inventory.
 *
 * `departureDate` is derived from `departureTime` when the caller does not send it,
 * and the derivation is the UTC calendar date because `ck_flights_departure_date`
 * requires exactly that. Sending a mismatched pair is not corrected here — the
 * constraint rejects it — because silently rewriting a caller's date is how a flight
 * ends up in a partition nobody expected. A bulk loader that already knows the date
 * (the natural case: it is iterating a schedule file) should send it, both to avoid
 * the derivation and to make the partition month explicit.
 */
async function upsertFlight(req, res) {
  const body = req.body;
  const departureDate = body.departureDate || utcDateOf(body.departureTime, 'departureTime');

  const result = await flightService.upsertFlight({
    flightId: body.flightId || null,
    // Flight designators and IATA codes are uppercase by definition, and the schema
    // accepts either case, so they are canonicalised here: importing "pk124" once by
    // hand and "PK124" from the schedule file should not produce two flights.
    flightNumber: String(body.flightNumber).toUpperCase(),
    airlineCode: String(body.airlineCode).toUpperCase(),
    origin: body.origin,
    destination: body.destination,
    departureDate,
    departureTime: body.departureTime,
    arrivalTime: body.arrivalTime,
    aircraftType: body.aircraftType,
    basePrice: body.basePrice,
    currency: body.currency ? String(body.currency).toUpperCase() : null,
    status: body.status || null,
    cabins: body.cabins
  });

  const { created, ...flight } = result;
  return ok(res, { created, flight });
}

/**
 * The UTC calendar date of an instant.
 *
 * `new Date('nonsense').toISOString()` throws a RangeError, which the error handler
 * would report as an opaque 500 for what is plainly a bad request. The route's pattern
 * already rejects malformed instants, so this is the second line: it keeps the
 * derivation honest for any caller that reaches the controller with a body the
 * validator did not produce.
 */
function utcDateOf(value, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new errors.ValidationError(`${field} must be a valid ISO-8601 instant`, { field, value });
  }
  return parsed.toISOString().slice(0, 10);
}

/**
 * One partition maintenance pass over both databases.
 *
 * The response names the partitions rather than counting them, because the count the
 * SQL helper returns cannot be checked against anything: if a partition were ever
 * created under a name the planner does not predict, the count would still look
 * healthy while retention silently stopped matching. `horizon` is included for the
 * same reason — it is the answer to "what does the cluster actually have now", which
 * a caller needs before deciding whether the pass did what they meant.
 */
async function maintainPartitions(req, res) {
  const body = req.body || {};

  const result = await partitions.maintain({
    monthsAhead: body.monthsAhead === undefined ? env.PARTITION_MONTHS_AHEAD : body.monthsAhead,
    monthsBehind: body.monthsBehind === undefined ? env.PARTITION_MONTHS_BEHIND : body.monthsBehind,
    retentionMonths: body.retentionMonths === undefined ? null : body.retentionMonths,
    dryRun: body.dryRun === true,
    force: body.force === true,
    // Passed through, never defaulted here: `partitions.maintain` owns the default and
    // the validation, and a second opinion about what 'drop' means is how a caller who
    // asked for 'detach' ends up with a dropped table.
    mode: body.mode === undefined ? 'drop' : body.mode,
    target: 'all'
  });

  if (result.skipped) {
    // Not an error: losing the race to a concurrent maintenance pass is normal, and a
    // second pass would be a no-op or a DDL conflict. The caller is told nothing was
    // changed so they can retry rather than assume the horizon was rolled forward.
    return ok(res, {
      ensured: [],
      dropped: [],
      dryRun: body.dryRun === true,
      skipped: true,
      reason: result.reason,
      message: result.message
    });
  }

  return ok(res, {
    ensured: result.ensured.map((entry) => entry.name),
    dropped: result.dropped.map((entry) => entry.name),
    dryRun: result.dryRun,
    // Reported because "dropped" alone does not say whether the table was removed or
    // detached, and that is the difference between reclaiming disk and keeping an
    // archive an operator can still query.
    mode: body.mode === undefined ? 'drop' : body.mode,
    blocked: result.blocked,
    horizon: result.horizon,
    retentionCutoff: result.retentionCutoff,
    generatedAt: result.generatedAt
  });
}

/** Left end of a replay window when the caller names none: the beginning of history. */
const REPLAY_FROM = '1970-01-01T00:00:00.000Z';

async function reproject(req, res) {
  const body = req.body || {};
  const from = body.from || REPLAY_FROM;
  const to = body.to || new Date().toISOString();
  const flightIds = Array.isArray(body.flightIds) && body.flightIds.length > 0 ? body.flightIds : null;

  if (new Date(from).getTime() > new Date(to).getTime()) {
    throw new errors.ValidationError('from must not be later than to', { from, to });
  }

  const result = await projectionService.reprojectAvailability({
    since: from,
    until: to,
    flightIds,
    force: body.force === true
  });

  return ok(res, {
    projected: result.projected,
    written: result.written,
    skipped: result.skipped,
    batches: result.batches,
    // Omitted rather than defaulted when the projection has never recorded a watermark:
    // the contract types this as an integer, and reporting 0 would claim the read model
    // is perfectly fresh when the honest answer is "unknown".
    ...(result.lagSeconds === null ? {} : { lagMs: Math.round(result.lagSeconds * 1000) }),
    window: { from, to },
    flightIds,
    forced: body.force === true
  });
}

/**
 * The oversell audit.
 *
 * Answers 200 even when it finds violations. The audit's job is to report, and a 5xx
 * would replace the findings with an error body — an operator would learn that
 * *something* is wrong and lose the row that says what. The alarm the contract
 * mentions is the `INVENTORY_INVARIANT_VIOLATION` metric and the non-empty findings,
 * both of which a monitoring system can act on without the endpoint refusing to
 * answer.
 */
async function auditInventory(req, res) {
  const body = req.body || {};

  const result = await inventoryRepository.audit(pool.writePool, {
    flightId: body.flightId || null,
    departureDate: body.departureDate || null,
    cabin: body.cabin || null,
    limit: body.limit === undefined ? 100 : body.limit
  });

  return ok(res, {
    checked: result.checkedRows,
    // The full count, not the length of the page below it: a caller must be able to
    // tell "one violation" from "four hundred, here are the first hundred".
    oversoldCount: result.violationCount,
    truncated: result.violationCount > result.violations.length,
    findings: result.violations.map((violation) => ({
      flightId: violation.flightId,
      departureDate: violation.departureDate,
      cabin: violation.cabin,
      violation: violation.violation,
      booked: violation.booked,
      capacity: violation.capacity,
      available: violation.available,
      held: violation.heldSeats,
      delta: violation.delta
    }))
  });
}

async function outboxStats(req, res) {
  const stats = await outboxRepository.stats(pool.writePool);

  return ok(res, {
    pending: stats.pending,
    published: stats.published,
    failed: stats.failed,
    total: stats.total,
    maxAttempts: stats.maxAttempts,
    oldestEventAgeMs: stats.oldestEventAgeMs,
    oldestEventAt: toIsoString(stats.oldestPendingAt),
    lastPublishedAt: toIsoString(stats.lastPublishedAt),
    byEventType: stats.byEventType
  });
}

module.exports = { topology, upsertFlight, maintainPartitions, reproject, auditInventory, outboxStats };
