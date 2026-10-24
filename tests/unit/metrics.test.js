/**
 * Unit tests for the Prometheus metrics module.
 *
 * These tests pin down two properties the rest of the service depends on:
 *
 *   1. the exporter text and the bounded label sets are a *contract* — other
 *      modules call these names and an operator's dashboards are built on them, so
 *      a rename or an added high-cardinality label must fail here first; and
 *   2. telemetry can never take down a request path — when metrics are disabled
 *      the record helpers are silent no-ops and the scrape endpoint refuses
 *      politely instead of exposing a healthy-looking empty body.
 *
 * `src/config/env.js` reads and freezes `process.env` at require time, so each
 * scenario resets the Jest module registry and re-requires the module under the
 * flag it wants to exercise.
 */
'use strict';

const METRICS_PATH = '../../src/observability/metrics';

/** Every metric the module promises to expose, by exported name. */
const METRIC_EXPORTS = [
  'httpRequestsTotal',
  'httpRequestDurationMs',
  'bookingsTotal',
  'bookingSagaStepsTotal',
  'inventoryReservationsTotal',
  'inventorySeatsGauge',
  'outboxEventsProcessedTotal',
  'outboxPendingGauge',
  'outboxLagSeconds',
  'reaperExpiredTotal',
  'dbQueryDurationMs',
  'dbErrorsTotal',
  'readModelLagSeconds',
  'cacheOpsTotal',
  'activeHoldsGauge'
];

/** The exact Prometheus metric names those exports must render under. */
const METRIC_NAMES = [
  'airline_http_requests_total',
  'airline_http_request_duration_ms',
  'airline_bookings_total',
  'airline_booking_saga_steps_total',
  'airline_inventory_reservations_total',
  'airline_inventory_available_seats',
  'airline_outbox_events_total',
  'airline_outbox_pending_events',
  'airline_outbox_lag_seconds',
  'airline_reaper_expired_bookings_total',
  'airline_db_query_duration_ms',
  'airline_db_errors_total',
  'airline_read_model_lag_seconds',
  'airline_cache_ops_total',
  'airline_active_holds'
];

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  METRICS_ENABLED: process.env.METRICS_ENABLED
};

function restoreVar(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Re-requires the metrics module with a chosen NODE_ENV / METRICS_ENABLED so each
 * test starts from a clean registry that reflects exactly that configuration.
 */
function loadMetrics({ nodeEnv, enabled }) {
  jest.resetModules();
  process.env.NODE_ENV = nodeEnv;
  process.env.METRICS_ENABLED = enabled ? 'true' : 'false';
  // eslint-disable-next-line global-require
  return require(METRICS_PATH);
}

/** Minimal Express-like response double that records what the handler wrote. */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.headers['content-type'] = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    }
  };
}

afterEach(() => {
  restoreVar('NODE_ENV', ORIGINAL_ENV.NODE_ENV);
  restoreVar('METRICS_ENABLED', ORIGINAL_ENV.METRICS_ENABLED);
  jest.resetModules();
});

describe('metrics (METRICS_ENABLED=true, NODE_ENV=test)', () => {
  let metrics;

  beforeEach(() => {
    metrics = loadMetrics({ nodeEnv: 'test', enabled: true });
  });

  test('reports itself enabled and exposes a single prom-client registry', () => {
    expect(metrics.metricsEnabled).toBe(true);
    expect(metrics.registry).toBeDefined();
    expect(typeof metrics.registry.metrics).toBe('function');
    expect(typeof metrics.registry.contentType).toBe('string');
  });

  test('exposes every documented metric and renders its name in the exporter text', async () => {
    // Exercise the record helpers first: a counter with no observations still
    // renders its HELP/TYPE line, but invoking the helpers proves the whole
    // increment path works end to end.
    metrics.recordBooking('CONFIRMED', 'SUCCESS');
    metrics.recordSagaStep('RESERVED', 'SUCCESS');
    metrics.recordInventoryReservation('ECONOMY', 'SUCCESS');

    const text = await metrics.renderMetrics();
    expect(typeof text).toBe('string');

    for (const name of METRIC_NAMES) {
      expect(text).toContain(name);
    }
    for (const exportName of METRIC_EXPORTS) {
      expect(metrics[exportName]).toBeDefined();
      expect(typeof metrics[exportName].labels).toBe('function');
    }
  });

  test('records a booking outcome that is visible in the exporter text', async () => {
    metrics.recordBooking('CONFIRMED', 'SUCCESS');
    const text = await metrics.renderMetrics();
    expect(text).toMatch(/airline_bookings_total\{[^}]*result="SUCCESS"[^}]*\}\s+1/);
    expect(text).toContain('status="CONFIRMED"');
  });

  test('labels are bounded: no booking/user/flight id outside inventorySeatsGauge', () => {
    const forbidden = ['booking_id', 'user_id', 'flight_id'];

    for (const exportName of METRIC_EXPORTS) {
      const metric = metrics[exportName];
      const offenders = metric.labelNames.filter((label) => forbidden.includes(label));

      if (exportName === 'inventorySeatsGauge') {
        // The single, deliberately admin-set exception.
        expect(metric.labelNames).toEqual(['flight_id', 'cabin']);
      } else {
        expect(offenders).toEqual([]);
      }
    }
  });

  test('timeDb observes latency and returns the wrapped result', async () => {
    const result = await metrics.timeDb('write', 'insert_booking', async () => 'ok');
    expect(result).toBe('ok');

    const text = await metrics.renderMetrics();
    expect(text).toContain('airline_db_query_duration_ms');
    expect(text).toContain('pool="write"');
    expect(text).toContain('operation="insert_booking"');
  });

  test('timeDb records the error count and rethrows without swallowing', async () => {
    const failure = Object.assign(new Error('serialization failure'), { code: '40001' });

    await expect(
      metrics.timeDb('write', 'insert_booking', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    const text = await metrics.renderMetrics();
    expect(text).toMatch(/airline_db_errors_total\{[^}]*code="40001"[^}]*\}\s+1/);
  });

  test('timeDb buckets an unusual error code as UNKNOWN to keep cardinality bounded', async () => {
    const failure = Object.assign(new Error('weird'), { code: 'x'.repeat(200) });

    await expect(
      metrics.timeDb('read', 'select_flight', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    const text = await metrics.renderMetrics();
    expect(text).toContain('code="UNKNOWN"');
    expect(text).not.toContain('x'.repeat(200));
  });

  test('clearInventoryGauges removes every label set', async () => {
    metrics.inventorySeatsGauge.labels({ flight_id: 'F-1', cabin: 'ECONOMY' }).set(42);
    let text = await metrics.renderMetrics();
    expect(text).toContain('flight_id="F-1"');

    metrics.clearInventoryGauges();
    text = await metrics.renderMetrics();
    expect(text).not.toContain('flight_id="F-1"');
  });

  test('metricsHandler writes 200 with the registry content type', async () => {
    const req = {};
    const res = makeRes();

    await metrics.metricsHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(metrics.registry.contentType);
    expect(typeof res.body).toBe('string');
    expect(res.body).toContain('airline_bookings_total');
  });
});

describe('metrics (METRICS_ENABLED=false, NODE_ENV=test)', () => {
  let metrics;

  beforeEach(() => {
    metrics = loadMetrics({ nodeEnv: 'test', enabled: false });
  });

  test('reports itself disabled', () => {
    expect(metrics.metricsEnabled).toBe(false);
  });

  test('record helpers never throw when metrics are disabled', () => {
    expect(() => metrics.recordBooking('CONFIRMED', 'SUCCESS')).not.toThrow();
    expect(() => metrics.recordSagaStep('RESERVED', 'SUCCESS')).not.toThrow();
    expect(() => metrics.recordInventoryReservation('ECONOMY', 'SUCCESS')).not.toThrow();
    expect(() => metrics.clearInventoryGauges()).not.toThrow();
  });

  test('timeDb still runs the wrapped work and still rethrows failures', async () => {
    await expect(metrics.timeDb('read', 'select', async () => 7)).resolves.toBe(7);

    const failure = new Error('boom');
    await expect(
      metrics.timeDb('read', 'select', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });

  test('metricsHandler answers 404 text/plain "metrics disabled"', async () => {
    const res = makeRes();

    await metrics.metricsHandler({}, res);

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('metrics disabled');
  });

  test('does not collect default runtime metrics while disabled', async () => {
    const text = await metrics.renderMetrics();
    expect(text).not.toContain('airline_process_');
  });
});

describe('default runtime metric collection', () => {
  test('is quiet under the test environment even when enabled', async () => {
    const metrics = loadMetrics({ nodeEnv: 'test', enabled: true });
    const text = await metrics.renderMetrics();
    expect(text).not.toContain('airline_process_');
  });

  test('is collected for an enabled, non-test process', async () => {
    const metrics = loadMetrics({ nodeEnv: 'development', enabled: true });
    const text = await metrics.renderMetrics();
    expect(text).toContain('airline_process_cpu_user_seconds_total');
  });
});
