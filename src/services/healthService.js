/**
 * Health and readiness.
 *
 * Three probes, three different questions, and conflating them is how a database blip
 * turns into a rolling restart of every pod:
 *
 *   liveness   is this process able to serve HTTP at all? Never touches a dependency,
 *              so a database outage cannot make the orchestrator kill a healthy process.
 *   readiness  can this node serve traffic *right now*? Both models must be reachable.
 *              This is what removes a node from the load balancer.
 *   health     the full report: what is reachable, how slow it was, and what the server
 *              supports. This is for a human or a dashboard, not for a probe.
 *
 * The capability block is worth having on a public health endpoint because the same
 * build runs on a Citus cluster, on vanilla PostgreSQL 18 and in CI, and "which of those
 * am I talking to?" is otherwise answerable only by opening a psql session.
 */
const pool = require('../db/pool');
const cache = require('../cache');
const env = require('../config/env');
const errors = require('../utils/errors');
const { version: VERSION } = require('../../package.json');

/** `redis: CONNECTED` means a real Redis; the memory driver is a fallback, not a failure. */
async function checkCache() {
  const described = cache.describe();

  if (!described.configured) {
    // No REDIS_URL at all. The in-process driver is a supported single-node
    // configuration — idempotency still works, it just cannot be shared across nodes —
    // so this is reported as a distinct state rather than as a failure.
    return { status: 'IN_PROCESS_FALLBACK', driver: described.driver, distributed: false };
  }

  const result = await cache.ping();
  return {
    status: result.ok ? 'CONNECTED' : 'DISCONNECTED',
    driver: described.driver,
    distributed: described.distributed,
    ...(result.ok ? {} : { error: result.error })
  };
}

/**
 * The full report.
 *
 * `DEGRADED` rather than `DOWN` when only the read model is unreachable: search stops
 * working, but booking, which reads the write model, does not. Calling that state DOWN
 * would take a node out of service for a dependency it does not need in order to sell
 * a seat.
 */
async function report() {
  const [probes, cacheCheck] = await Promise.all([pool.health(), checkCache()]);

  const checks = {
    writeModel: probes.writeModel,
    readModel: probes.readModel,
    // Present only when READMODEL_READ_URL points search at a replica.
    ...(probes.readReplica ? { readReplica: probes.readReplica } : {}),
    redis: cacheCheck.status
  };

  let status = 'UP';
  if (checks.writeModel !== 'CONNECTED') status = 'DOWN';
  else if (
    checks.readModel !== 'CONNECTED' ||
    checks.readReplica === 'DISCONNECTED' ||
    checks.redis === 'DISCONNECTED'
  ) {
    status = 'DEGRADED';
  }

  return {
    status,
    nodeId: env.NODE_ID,
    version: VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
    checks,
    latencyMs: probes.latencyMs,
    // Null when the write model is unreachable: there is nothing truthful to say about
    // the server's capabilities without the server.
    topology: probes.topology || null,
    cache: { driver: cacheCheck.driver, distributed: cacheCheck.distributed },
    ...(probes.writeError ? { writeError: probes.writeError } : {}),
    ...(probes.readError ? { readError: probes.readError } : {}),
    timestamp: new Date().toISOString()
  };
}

/** Liveness: no dependency is consulted, so this answers even during a total outage. */
function live() {
  return {
    status: 'UP',
    nodeId: env.NODE_ID,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  };
}

/**
 * Readiness: throws a 503 unless both models are reachable.
 *
 * The error carries the per-dependency checks so the operator reading a failed probe
 * sees *which* dependency is down without a second request.
 */
async function ready() {
  const health = await report();

  if (
    health.checks.writeModel === 'CONNECTED' &&
    health.checks.readModel === 'CONNECTED' &&
    health.checks.readReplica !== 'DISCONNECTED'
  ) {
    return health;
  }

  throw new errors.DatabaseUnavailableError('A required database dependency is unreachable', {
    checks: health.checks,
    status: health.status
  });
}

module.exports = { report, live, ready, checkCache };
