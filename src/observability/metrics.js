/**
 * Prometheus metrics for the airline inventory service.
 *
 * Why this module exists
 * ----------------------
 * A booking is a saga that crosses several tiers — the API process, the Citus
 * coordinator, the outbox relay, the hold reaper, the cache driver — so when a
 * booking stalls there is no single log line that says where it stopped. These
 * metrics are the small, cheap set of time series that answer the questions an
 * on-call engineer actually asks during an incident: are bookings succeeding, is
 * the saga compensating, are we refusing the last seat, is the outbox draining,
 * is the read model stale, and are database calls slow or erroring.
 *
 * Label cardinality is treated here as a correctness concern, not a nicety. A
 * Prometheus series is keyed by its *whole* label set, so a single label over an
 * unbounded domain — a booking id, a user id — multiplies one series into one per
 * row and can take the scrape target down with it. Every label in this file is
 * therefore a bounded enum (`status`, `result`, `cabin`, `event_type`, `method`,
 * `route`, `pool`, `operation`, `driver`, `projection`) or a short, deliberately
 * chosen dimension.
 *
 * `flight_id` is the one bounded-but-unbounded-in-principle dimension, and it is
 * confined to `inventorySeatsGauge`. That gauge is written only by explicit
 * admin/audit calls — never on the hot booking path — and can be cleared wholesale
 * with `clearInventoryGauges()`, so a long-lived process cannot accumulate a
 * series per flight it has ever seen. Booking, reservation and saga outcomes are
 * recorded as counters instead, which stay bounded no matter how many flights the
 * service serves.
 *
 * Every mutation is wrapped so monitoring can never become a source of request
 * failures: when `METRICS_ENABLED` is false the record helpers are silent no-ops,
 * and a prom-client exception is logged at debug and dropped rather than allowed
 * to escape. `timeDb` deliberately does *not* swallow the error it is measuring —
 * it records the failure and rethrows, because a swallowed database error would
 * turn a visible outage into silent data loss.
 */
const {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics
} = require('prom-client');
const env = require('../config/env');
const logger = require('../utils/logger');
const { HTTP_STATUS } = require('../config/constants');

const NS_PER_MS = 1e6;

// One registry for the whole process. A second registry would need a second
// scrape endpoint and would silently split the counters, so there is exactly one.
const registry = new Registry();

const metricsEnabled = env.METRICS_ENABLED === true;

// Runtime gauges (GC, event loop, memory, CPU) are useful but noisy in unit tests
// and unnecessary when metrics are switched off, so they are collected only for a
// real, metrics-enabled, non-test process.
if (metricsEnabled && !env.isTest) {
  collectDefaultMetrics({ register: registry, prefix: 'airline_' });
}

/**
 * Bounded HTTP metrics.
 *
 * `route` must be the *route pattern* (`/api/flights/:id`), never the concrete
 * path: a path with an id in it is unbounded and would create a series per URL
 * requested. The HTTP middleware is responsible for normalising the route.
 */
const httpRequestsTotal = new Counter({
  name: 'airline_http_requests_total',
  help: 'Total HTTP requests handled, by method, route pattern and response status.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry]
});

/**
 * Buckets are spread from 5ms to 5s so the tail of a slow request (a saga that
 * fell back to its slow path) is still visible, while the p50 sits in a usable
 * bucket.
 */
const httpRequestDurationMs = new Histogram({
  name: 'airline_http_request_duration_ms',
  help: 'HTTP request latency in milliseconds, by method, route pattern and response status.',
  labelNames: ['method', 'route', 'status'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry]
});

/**
 * Booking outcomes. `status` is the booking lifecycle state (a fixed enum) and
 * `result` is the outcome of the attempt that produced it — both bounded, which
 * is what makes this safe to label when ids are not.
 */
const bookingsTotal = new Counter({
  name: 'airline_bookings_total',
  help: 'Booking attempts by resulting booking status and outcome.',
  labelNames: ['status', 'result'],
  registers: [registry]
});

/** Per-step saga outcomes: which step, and whether it succeeded, failed or compensated. */
const bookingSagaStepsTotal = new Counter({
  name: 'airline_booking_saga_steps_total',
  help: 'Booking saga step executions, by step name and result.',
  labelNames: ['step', 'result'],
  registers: [registry]
});

/** Inventory reservations by cabin (a fixed enum) and outcome. */
const inventoryReservationsTotal = new Counter({
  name: 'airline_inventory_reservations_total',
  help: 'Inventory reservations attempted, by cabin and result.',
  labelNames: ['cabin', 'result'],
  registers: [registry]
});

/**
 * Remaining seats per (flight, cabin).
 *
 * This is the only metric that carries a flight dimension. It is set by explicit
 * admin/audit tooling rather than per request, because a gauge per flight would
 * otherwise grow without bound as the schedule evolves; `clearInventoryGauges()`
 * lets that tooling drop the label sets for flights it no longer tracks.
 */
const inventorySeatsGauge = new Gauge({
  name: 'airline_inventory_available_seats',
  help: 'Available seats observed per flight and cabin (set by admin/audit calls only).',
  labelNames: ['flight_id', 'cabin'],
  registers: [registry]
});

/** Outbox relay progress, split by event type (a fixed enum) and result. */
const outboxEventsProcessedTotal = new Counter({
  name: 'airline_outbox_events_total',
  help: 'Outbox events processed, by event type and result.',
  labelNames: ['event_type', 'result'],
  registers: [registry]
});

/** Backlog depth. A rising gauge is the earliest signal the relay is falling behind. */
const outboxPendingGauge = new Gauge({
  name: 'airline_outbox_pending_events',
  help: 'Unpublished outbox events currently waiting to be relayed.',
  registers: [registry]
});

/** Age of the oldest unpublished outbox event, in seconds. */
const outboxLagSeconds = new Gauge({
  name: 'airline_outbox_lag_seconds',
  help: 'Age in seconds of the oldest unpublished outbox event.',
  registers: [registry]
});

/** Bookings reclaimed by the hold reaper (expired PENDING holds). */
const reaperExpiredTotal = new Counter({
  name: 'airline_reaper_expired_bookings_total',
  help: 'PENDING bookings expired by the hold reaper.',
  registers: [registry]
});

/**
 * Database latency, labelled by connection pool and logical operation. Buckets
 * start at 1ms: a single-statement point read on a healthy cluster lives there,
 * and coarser buckets would hide exactly the regression worth alerting on.
 */
const dbQueryDurationMs = new Histogram({
  name: 'airline_db_query_duration_ms',
  help: 'Database query latency in milliseconds, by pool and operation.',
  labelNames: ['pool', 'operation'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry]
});

/**
 * Database errors by pool and SQLSTATE/error code. The raw `code` is already a
 * short, fixed-vocabulary string; `dbErrorCode` still buckets anything unusual as
 * UNKNOWN so a caller cannot accidentally widen the label domain.
 */
const dbErrorsTotal = new Counter({
  name: 'airline_db_errors_total',
  help: 'Database errors, by pool and error code.',
  labelNames: ['pool', 'code'],
  registers: [registry]
});

/** Read-model projection lag, per projection (a small fixed set of names). */
const readModelLagSeconds = new Gauge({
  name: 'airline_read_model_lag_seconds',
  help: 'Read-model projection lag in seconds, by projection.',
  labelNames: ['projection'],
  registers: [registry]
});

/** Cache operations, split by operation, driver (redis/in-process) and result. */
const cacheOpsTotal = new Counter({
  name: 'airline_cache_ops_total',
  help: 'Cache operations, by op, driver and result.',
  labelNames: ['op', 'driver', 'result'],
  registers: [registry]
});

/** Live (PENDING) holds currently consuming inventory. */
const activeHoldsGauge = new Gauge({
  name: 'airline_active_holds',
  help: 'Reservation holds currently active (PENDING).',
  registers: [registry]
});

/**
 * Runs a metric mutation, dropping (and debug-logging) any error it raises.
 *
 * This is the single guard that keeps telemetry off the failure path: a bad label
 * value or a registry problem must degrade observability, never the request.
 */
function safeMetric(op) {
  if (!metricsEnabled) return;
  try {
    op();
  } catch (err) {
    logger.debug('Metric update failed; telemetry dropped', { error: err });
  }
}

/**
 * Reduces an arbitrary error `code` to a bounded label value.
 *
 * SQLSTATEs and Node error codes are short and drawn from a fixed vocabulary, but
 * nothing stops caller code from throwing an object with a long, per-invocation
 * `code`. Anything that does not look like a code is bucketed as UNKNOWN so the
 * `airline_db_errors_total` series count stays bounded.
 */
function dbErrorCode(error) {
  const raw = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Za-z0-9_]{1,24}$/.test(raw) ? raw : 'UNKNOWN';
}

/**
 * Times a database call and records its latency and any failure.
 *
 * Used by both pools with an explicit `pool` label ('write' / 'read') so a slow
 * read replica is distinguishable from a slow coordinator. The error is recorded
 * and then rethrown unchanged — swallowing it here would hide a real outage.
 */
async function timeDb(pool, operation, fn) {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await fn();
    const durationMs = Number(process.hrtime.bigint() - startedAt) / NS_PER_MS;
    safeMetric(() => dbQueryDurationMs.observe({ pool, operation }, durationMs));
    return result;
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / NS_PER_MS;
    safeMetric(() => {
      // A failed query's latency is still worth knowing — timeouts show up here
      // just before the error counter spikes.
      dbQueryDurationMs.observe({ pool, operation }, durationMs);
      dbErrorsTotal.inc({ pool, code: dbErrorCode(err) });
    });
    throw err;
  }
}

/** Records a booking outcome. No-op when metrics are disabled. */
function recordBooking(status, result) {
  safeMetric(() => bookingsTotal.inc({ status, result }));
}

/** Records a booking saga step outcome. No-op when metrics are disabled. */
function recordSagaStep(step, result) {
  safeMetric(() => bookingSagaStepsTotal.inc({ step, result }));
}

/** Records an inventory reservation outcome. No-op when metrics are disabled. */
function recordInventoryReservation(cabin, result) {
  safeMetric(() => inventoryReservationsTotal.inc({ cabin, result }));
}

/**
 * Drops every (flight, cabin) series from the inventory gauge.
 *
 * Called by the admin/audit tooling after it has refreshed the gauge for the
 * flights it tracks, so a stale label set for a flight that left the schedule
 * does not linger for the lifetime of the process.
 */
function clearInventoryGauges() {
  safeMetric(() => inventorySeatsGauge.reset());
}

/** Renders the registry in the Prometheus text exposition format. */
function renderMetrics() {
  return registry.metrics();
}

/**
 * Express handler for the scrape endpoint.
 *
 * When metrics are disabled the endpoint answers 404 rather than an empty body:
 * a monitoring system probing a deliberately-off port should see the feature is
 * off, not a healthy-looking zero. Rendering failures are caught so a scrape
 * cannot crash the request path.
 */
async function metricsHandler(req, res) {
  if (!metricsEnabled) {
    res.status(HTTP_STATUS.NOT_FOUND).type('text/plain').send('metrics disabled');
    return;
  }

  try {
    const body = await renderMetrics();
    res.setHeader('Content-Type', registry.contentType);
    res.status(HTTP_STATUS.OK).send(body);
  } catch (err) {
    logger.error('Failed to render Prometheus metrics', { error: err });
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).type('text/plain').send('metrics unavailable');
  }
}

module.exports = {
  registry,
  metricsEnabled,
  renderMetrics,
  metricsHandler,
  httpRequestsTotal,
  httpRequestDurationMs,
  bookingsTotal,
  bookingSagaStepsTotal,
  inventoryReservationsTotal,
  inventorySeatsGauge,
  outboxEventsProcessedTotal,
  outboxPendingGauge,
  outboxLagSeconds,
  reaperExpiredTotal,
  dbQueryDurationMs,
  dbErrorsTotal,
  readModelLagSeconds,
  cacheOpsTotal,
  activeHoldsGauge,
  timeDb,
  recordBooking,
  recordSagaStep,
  recordInventoryReservation,
  clearInventoryGauges
};
