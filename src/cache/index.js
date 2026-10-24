/**
 * Cache facade.
 *
 * One interface over two drivers: shared Redis when REDIS_URL is configured, an
 * in-process Map otherwise. Callers never branch on which one is active — they ask
 * for a key and either get an answer or `null`.
 *
 * Degradation policy: if Redis is configured but unreachable, the facade logs once
 * and keeps serving from the in-process driver. Every use of the cache in this
 * system is an optimization or a way to avoid duplicate work, never the sole
 * guarantor of correctness (the database constraints are), so degrading is safe
 * where failing would not be.
 *
 * Values are JSON-encoded by the `*Json` helpers; the raw helpers deal in strings so
 * the lock paths can compare values exactly.
 */
const env = require('../config/env');
const logger = require('../utils/logger');
const metrics = require('../observability/metrics');
const { MemoryDriver } = require('./memoryDriver');

/** Keys used by the system, in one place so they cannot drift between writers. */
const KEYS = Object.freeze({
  IDEMPOTENCY: (scope, key) => `idem:${scope}:${key}`,
  BOOKING_LOCK: (key) => `booking:lock:${key}`,
  RATE_LIMIT: (bucket, identifier) => `rl:${bucket}:${identifier}`,
  FLIGHT_HOT: (flightId) => `flight:hot:${flightId}`
});

let activeDriver = null;
let driverKind = null;

function buildDriver() {
  if (!env.REDIS_URL) {
    return { driver: new MemoryDriver(), downgraded: false };
  }

  try {
    const { RedisDriver } = require('./redisDriver');
    return {
      driver: new RedisDriver(env.REDIS_URL, {
        prefix: env.REDIS_KEY_PREFIX,
        connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS
      }),
      downgraded: false
    };
  } catch (err) {
    // ioredis missing or the URL is malformed: a cache must never be a hard
    // dependency of the process starting.
    logger.warn('Redis driver unavailable; using the in-process cache', { error: err.message });
    return { driver: new MemoryDriver(), downgraded: true };
  }
}

function getDriver() {
  if (!activeDriver) {
    const built = buildDriver();
    activeDriver = built.driver;
    driverKind = built.downgraded ? 'memory' : built.driver.kind;
    logger.info('Cache driver selected', {
      driver: driverKind,
      distributed: activeDriver.isDistributed
    });
  }
  return activeDriver;
}

/** Wraps a driver call so a Redis outage degrades instead of propagating. */
async function attempt(op, fn) {
  try {
    const result = await fn();
    metrics.cacheOpsTotal.inc({ op, driver: driverKind || 'unknown', result: 'success' });
    return result;
  } catch (err) {
    metrics.cacheOpsTotal.inc({ op, driver: driverKind || 'unknown', result: 'error' });
    logger.warn(`Cache ${op} failed`, { error: err.message });
    return null;
  }
}

async function get(key) {
  return attempt('get', () => getDriver().get(key));
}

async function set(key, value, ttlSeconds = null) {
  const result = await attempt('set', () => getDriver().set(key, value, ttlSeconds));
  return result !== null;
}

async function del(key) {
  const result = await attempt('del', () => getDriver().del(key));
  return result === true;
}

async function setNx(key, value, ttlSeconds = null) {
  const result = await attempt('setNx', () => getDriver().setNx(key, value, ttlSeconds));
  // A null result means the cache itself failed. Reporting "not acquired" is the
  // conservative answer: the caller then relies on the database constraint instead
  // of assuming it holds a lock it does not have.
  return result === true;
}

async function delIfValue(key, expectedValue) {
  const result = await attempt('delIfValue', () => getDriver().delIfValue(key, expectedValue));
  return result === true;
}

async function incr(key, ttlSeconds = null) {
  const result = await attempt('incr', () => getDriver().incr(key, ttlSeconds));
  return result === null ? null : Number(result);
}

async function ttl(key) {
  const result = await attempt('ttl', () => getDriver().ttl(key));
  return result === null ? -2 : Number(result);
}

async function getJson(key) {
  const raw = await get(key);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    // A corrupt value is treated as a miss; the producer will rewrite it.
    logger.warn('Discarding unparseable cache value', { key });
    return null;
  }
}

async function setJson(key, value, ttlSeconds = null) {
  return set(key, JSON.stringify(value), ttlSeconds);
}

async function ping() {
  try {
    return { ok: true, driver: driverKind || 'uninitialised', response: await getDriver().ping() };
  } catch (err) {
    return { ok: false, driver: driverKind || 'uninitialised', error: err.message };
  }
}

/** Health/status view that never reveals the connection string. */
function describe() {
  return {
    driver: driverKind || (env.REDIS_URL ? 'redis' : 'memory'),
    distributed: Boolean(activeDriver?.isDistributed),
    configured: Boolean(env.REDIS_URL)
  };
}

async function close() {
  if (activeDriver) {
    await activeDriver.close();
    activeDriver = null;
    driverKind = null;
  }
}

/**
 * Test hook: forces a fresh driver on the next call. Used by the integration suite
 * so a test that closes the cache cannot poison the next file's `beforeAll`.
 */
function reset() {
  activeDriver = null;
  driverKind = null;
}

module.exports = {
  KEYS,
  get,
  set,
  del,
  setNx,
  delIfValue,
  incr,
  ttl,
  getJson,
  setJson,
  ping,
  describe,
  close,
  reset,
  get kind() {
    return driverKind || (env.REDIS_URL ? 'redis' : 'memory');
  }
};
