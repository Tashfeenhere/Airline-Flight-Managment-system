/**
 * Centralized environment configuration.
 *
 * Every tunable is read exactly once, coerced to the right type, and exposed as a
 * frozen object. Secrets are never logged: `describe()` prints a redacted view that
 * is safe to emit at startup.
 */
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config();
} else {
  // In test mode, allow .env for DB credentials if not explicitly set in process.env, but do not override test-specific settings
  require('dotenv').config();
}

function readString(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return String(raw).trim();
}

function readInt(name, fallback) {
  const raw = readString(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, received: ${raw}`);
  }
  return parsed;
}

function readFloat(name, fallback) {
  const raw = readString(name);
  if (raw === null) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, received: ${raw}`);
  }
  return parsed;
}

function readBool(name, fallback) {
  const raw = readString(name);
  if (raw === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function readList(name, fallback = []) {
  const raw = readString(name);
  if (raw === null) return fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const NODE_ENV = readString('NODE_ENV', 'development');
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

/**
 * Dev defaults: a local PostgreSQL cluster reached over TCP with the throwaway
 * credentials created by `npm run db:local:start`. Override with real URLs in
 * every deployed environment.
 */
const LOCAL_COORDINATOR_URL =
  'postgres://airline:airline@127.0.0.1:55432/airline_inventory';
const LOCAL_READMODEL_URL = 'postgres://airline:airline@127.0.0.1:55432/airline_read';

const env = Object.freeze({
  NODE_ENV,
  isProduction,
  isTest,
  NODE_ID: readString('NODE_ID', 'api-local'),
  PORT: readInt('PORT', 3000),
  SWAGGER_ENABLED: readBool('SWAGGER_ENABLED', true),

  // ---- Write model (Citus coordinator) -------------------------------------
  CITUS_COORDINATOR_URL: readString('CITUS_COORDINATOR_URL', LOCAL_COORDINATOR_URL),
  // Optional PgBouncer (transaction pooling) endpoint used by the API tier.
  PGBOUNCER_URL: readString('PGBOUNCER_URL', null),
  PG_POOL_MAX: readInt('PG_POOL_MAX', 20),
  PG_IDLE_TIMEOUT_MS: readInt('PG_IDLE_TIMEOUT_MS', 30000),
  PG_CONNECTION_TIMEOUT_MS: readInt('PG_CONNECTION_TIMEOUT_MS', 10000),
  PG_STATEMENT_TIMEOUT_MS: readInt('PG_STATEMENT_TIMEOUT_MS', 15000),
  PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: readInt('PG_IDLE_IN_TRANSACTION_TIMEOUT_MS', 30000),
  PG_MAX_LIFETIME_SECONDS: readInt('PG_MAX_LIFETIME_SECONDS', 1800),
  // Citus shard count for the co-located booking tables (ignored when Citus is
  // not active). Workers are registered by scripts/citus-init.js.
  CITUS_SHARD_COUNT: readInt('CITUS_SHARD_COUNT', 32),
  CITUS_WORKER_HOSTS: readList('CITUS_WORKER_HOSTS', []),

  // ---- Read model (search/availability projection) -------------------------
  // READMODEL_URL is the primary: the projector writes projections and bookkeeping
  // here. READMODEL_READ_URL is the optional read replica that serves search; when
  // unset, reads and writes share the primary. Pointing search at a replica keeps
  // wide scans off the database that is applying outbox batches (the lag it adds is
  // already reported to clients via x-read-model-lag-ms).
  READMODEL_URL: readString('READMODEL_URL', LOCAL_READMODEL_URL),
  READMODEL_READ_URL: readString('READMODEL_READ_URL', null),
  READMODEL_POOL_MAX: readInt('READMODEL_POOL_MAX', 20),
  READMODEL_LAG_SLA_SECONDS: readInt('READMODEL_LAG_SLA_SECONDS', 60),

  // ---- Redis (optional: an in-process driver is used when unset) ----------
  REDIS_URL: readString('REDIS_URL', null),
  REDIS_KEY_PREFIX: readString('REDIS_KEY_PREFIX', 'airline'),
  REDIS_CONNECT_TIMEOUT_MS: readInt('REDIS_CONNECT_TIMEOUT_MS', 2000),

  // ---- Booking behaviour ---------------------------------------------------
  BOOKING_HOLD_TTL_SECONDS: readInt('BOOKING_HOLD_TTL_SECONDS', 600),
  DEFAULT_CABIN: readString('DEFAULT_CABIN', 'ECONOMY'),
  // 'requested' = a specific seat may be supplied and is reserved atomically;
  // 'lazy'      = seats are assigned later (check-in style), bookings hold only counts.
  SEAT_ASSIGNMENT_MODE: readString('SEAT_ASSIGNMENT_MODE', 'requested'),
  // 'single'   = one counter row per (flight, cabin);
  // 'sharded'  = capacity split across N counter rows to relieve hot-row contention.
  INVENTORY_STRATEGY: readString('INVENTORY_STRATEGY', 'single'),
  INVENTORY_SHARD_COUNT: readInt('INVENTORY_SHARD_COUNT', 8),

  // ---- Payments (simulated gateway) ---------------------------------------
  PAYMENT_PROVIDER: readString('PAYMENT_PROVIDER', 'SIMULATED'),
  PAYMENT_FAILURE_RATE: readFloat('PAYMENT_FAILURE_RATE', 0),
  PAYMENT_LATENCY_MS: readInt('PAYMENT_LATENCY_MS', 0),
  // When true the saga runs inline so POST /api/bookings still answers 201 CONFIRMED.
  BOOKING_SAGA_INLINE: readBool('BOOKING_SAGA_INLINE', true),

  // ---- Auth ----------------------------------------------------------------
  JWT_ACCESS_SECRET: readString('JWT_ACCESS_SECRET', 'dev-only-access-secret-change-me'),
  JWT_REFRESH_SECRET: readString('JWT_REFRESH_SECRET', 'dev-only-refresh-secret-change-me'),
  JWT_ACCESS_TTL: readString('JWT_ACCESS_TTL', '15m'),
  JWT_REFRESH_TTL_SECONDS: readInt('JWT_REFRESH_TTL_SECONDS', 30 * 24 * 3600),
  JWT_ISSUER: readString('JWT_ISSUER', 'distributed-airline-inventory'),
  JWT_AUDIENCE: readString('JWT_AUDIENCE', 'airline-api'),
  AUTH_RATE_LIMIT_PER_MIN: readInt('AUTH_RATE_LIMIT_PER_MIN', 30),
  API_RATE_LIMIT_PER_MIN: readInt('API_RATE_LIMIT_PER_MIN', 600),
  RATE_LIMIT_ENABLED: readBool('RATE_LIMIT_ENABLED', !isTest),
  // Booking attribution: when false, callers may book with only `passengerId`
  // (guest attribution) — keeps the original prototype contract usable.
  REQUIRE_AUTH_FOR_BOOKING: readBool('REQUIRE_AUTH_FOR_BOOKING', false),
  // Two-Factor Authentication & Gmail configuration
  REQUIRE_2FA: isTest ? readBool('TEST_REQUIRE_2FA', false) : readBool('REQUIRE_2FA', true),
  GMAIL_USER: readString('GMAIL_USER', ''),
  GMAIL_APP_PASSWORD: readString('GMAIL_APP_PASSWORD', ''),
  // Well-known identity that owns bookings made without a bearer token.
  GUEST_USER_ID: readString('GUEST_USER_ID', '00000000-0000-7000-8000-000000000001'),

  // ---- Retry / concurrency -------------------------------------------------
  MAX_RETRIES: readInt('MAX_RETRIES', 4),
  RETRY_INITIAL_DELAY_MS: readInt('RETRY_INITIAL_DELAY_MS', 15),
  RETRY_MAX_DELAY_MS: readInt('RETRY_MAX_DELAY_MS', 200),

  // ---- Background workers --------------------------------------------------
  WORKERS_ENABLED: readBool('WORKERS_ENABLED', true),
  OUTBOX_POLL_INTERVAL_MS: readInt('OUTBOX_POLL_INTERVAL_MS', 1000),
  OUTBOX_BATCH_SIZE: readInt('OUTBOX_BATCH_SIZE', 200),
  OUTBOX_MAX_ATTEMPTS: readInt('OUTBOX_MAX_ATTEMPTS', 10),
  REAPER_INTERVAL_MS: readInt('REAPER_INTERVAL_MS', 30000),
  REAPER_BATCH_SIZE: readInt('REAPER_BATCH_SIZE', 200),
  // How far back the hold reaper will look for expired holds. Bounds the partition
  // scan: a hold on a flight that departed weeks ago is history, and re-reading every
  // past month on every tick would make the job slower every day the system runs.
  REAPER_LOOKBACK_DAYS: readInt('REAPER_LOOKBACK_DAYS', 2),
  // The saga reconciler drives PENDING bookings that the inline path did not finish —
  // because BOOKING_SAGA_INLINE=false, because the request's process died mid-saga, or
  // because a payment provider call timed out. `SAGA_STALE_SECONDS` is how long a
  // booking may sit PENDING before the reconciler assumes nobody is coming back for it.
  SAGA_INTERVAL_MS: readInt('SAGA_INTERVAL_MS', 15000),
  SAGA_BATCH_SIZE: readInt('SAGA_BATCH_SIZE', 100),
  SAGA_STALE_SECONDS: readInt('SAGA_STALE_SECONDS', 60),
  SAGA_ENABLED: readBool('SAGA_ENABLED', true),
  // How long a shutdown waits for an in-flight worker pass to settle before closing the
  // pools. Exiting immediately is safe (the claims make it so) but finishing is free.
  WORKER_SHUTDOWN_GRACE_MS: readInt('WORKER_SHUTDOWN_GRACE_MS', 2000),
  // Optional metrics/liveness listener for a worker-only process. Zero disables it.
  // Without this, a deployment that runs workers separately from the API has nowhere
  // for Prometheus to scrape `airline_outbox_*` or `airline_read_model_lag_seconds`:
  // those gauges are written by the worker process itself.
  WORKER_METRICS_PORT: readInt('WORKER_METRICS_PORT', 0),

  // ---- Partition lifecycle -------------------------------------------------
  PARTITION_MONTHS_AHEAD: readInt('PARTITION_MONTHS_AHEAD', 6),
  PARTITION_MONTHS_BEHIND: readInt('PARTITION_MONTHS_BEHIND', 1),
  PARTITION_RETENTION_MONTHS: readInt('PARTITION_RETENTION_MONTHS', 24),

  // ---- Observability -------------------------------------------------------
  METRICS_ENABLED: readBool('METRICS_ENABLED', true),
  LOG_LEVEL: readString('LOG_LEVEL', isTest ? 'error' : 'info'),
  TRUST_PROXY: readString('TRUST_PROXY', null),
  CORS_ORIGINS: readList('CORS_ORIGINS', ['*'])
});

/**
 * Redacted view safe for structured startup logs.
 */
function describe() {
  const redactUrl = (url) => {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.password) parsed.password = '***';
      return parsed.toString();
    } catch (err) {
      return '<unparseable-url>';
    }
  };

  return {
    nodeEnv: env.NODE_ENV,
    nodeId: env.NODE_ID,
    port: env.PORT,
    writeModel: redactUrl(env.PGBOUNCER_URL || env.CITUS_COORDINATOR_URL),
    readModel: redactUrl(env.READMODEL_URL),
    redis: env.REDIS_URL ? redactUrl(env.REDIS_URL) : 'in-process-fallback',
    inventoryStrategy: env.INVENTORY_STRATEGY,
    seatAssignmentMode: env.SEAT_ASSIGNMENT_MODE,
    holdTtlSeconds: env.BOOKING_HOLD_TTL_SECONDS,
    sagaInline: env.BOOKING_SAGA_INLINE,
    requireAuthForBooking: env.REQUIRE_AUTH_FOR_BOOKING,
    workersEnabled: env.WORKERS_ENABLED
  };
}

module.exports = env;
module.exports.describe = describe;
