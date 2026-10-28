/**
 * Database access layer for the write model (Citus coordinator) and the read model.
 *
 * Two pools, deliberately separate:
 *   - `writePool` -> Citus coordinator (or PgBouncer in front of it). Routing to the
 *     worker that owns a shard is Citus's job; the application only issues SQL.
 *   - `readPool`  -> the CQRS read model (search/availability projections).
 *
 * Splitting them lets the read model be scaled, lagged, or replaced with an
 * external store without touching the booking path.
 *
 * Transactions are the only correctness-critical primitive here: `withTransaction`
 * checks out ONE client, so every statement inside runs on the same worker and
 * therefore inside a single local ACID transaction (no 2PC) as long as the
 * statements share the distribution column value.
 */
const { Pool, types } = require('pg');
const env = require('../config/env');
const logger = require('../utils/logger');

// Return NUMERIC (OID 1700) as a JS number: this domain deals in money and seat
// counts, both far inside the safe-integer/double range, and strings would leak
// into API responses otherwise.
types.setTypeParser(1700, (value) => (value === null ? null : Number.parseFloat(value)));
// Return BIGINT (OID 20) as a number too (versions, counts).
types.setTypeParser(20, (value) => (value === null ? null : Number.parseInt(value, 10)));
// Return DATE (OID 1082) as the raw 'YYYY-MM-DD' string. The default parser builds a
// JS Date at *local* midnight, so a server west of UTC reading 2026-09-01 gets a
// value that renders as 2026-08-31 in UTC — and `departure_date` is the partition key
// and part of every primary key, so a one-day shift is not a cosmetic bug, it is a
// lookup that misses the row it just wrote. Keeping dates as strings end to end
// removes the question entirely.
types.setTypeParser(1082, (value) => value);

function buildPoolConfig(connectionString, { max, applicationName, statementTimeoutMs }) {
  const isPgBouncer = /pgbouncer|:6432/i.test(connectionString);
  const config = {
    connectionString,
    max,
    idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.PG_CONNECTION_TIMEOUT_MS,
    application_name: applicationName,
    maxLifetimeSeconds: env.PG_MAX_LIFETIME_SECONDS,
    // Defaults are fine for our row shapes but keep the name explicit so
    // PgBouncer transaction pooling stays safe (no named prepared statements).
    allowExitOnIdle: false
  };

  // PgBouncer transaction pooling mode rejects connection startup parameters
  // like statement_timeout and idle_in_transaction_session_timeout.
  if (!isPgBouncer) {
    if (statementTimeoutMs) config.statement_timeout = statementTimeoutMs;
    if (env.PG_IDLE_IN_TRANSACTION_TIMEOUT_MS) {
      config.idle_in_transaction_session_timeout = env.PG_IDLE_IN_TRANSACTION_TIMEOUT_MS;
    }
  }

  // `sslmode` in a URL does not map to libpq semantics in node-postgres, so make
  // the intent explicit instead of relying on the URL.
  if (/sslmode=(require|verify-ca|verify-full)/.test(connectionString)) {
    config.ssl = { rejectUnauthorized: /verify-(ca|full)/.test(connectionString) };
  }

  return config;
}

const writeConnectionString = env.PGBOUNCER_URL || env.CITUS_COORDINATOR_URL;

const writePool = new Pool(
  buildPoolConfig(writeConnectionString, {
    max: env.PG_POOL_MAX,
    applicationName: `${env.NODE_ID}-write`,
    statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS
  })
);

const readPool = new Pool(
  buildPoolConfig(env.READMODEL_URL, {
    max: env.READMODEL_POOL_MAX,
    applicationName: `${env.NODE_ID}-read`,
    statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS
  })
);

// Optional read replica for search. Reusing `readPool` when no replica is configured
// keeps a single pool (and a single set of connections) in the common case instead of
// opening an identical second pool to the same server.
const readReplicaPool = env.READMODEL_READ_URL
  ? new Pool(
      buildPoolConfig(env.READMODEL_READ_URL, {
        max: env.READMODEL_POOL_MAX,
        applicationName: `${env.NODE_ID}-read-replica`,
        statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS
      })
    )
  : readPool;

// A pool-level error means an IDLE client died (network blip, worker restart).
// Without a listener Node would crash the process on the unhandled 'error' event.
writePool.on('error', (err) => logger.error('Write pool idle client error', { error: err }));
readPool.on('error', (err) => logger.error('Read pool idle client error', { error: err }));
if (readReplicaPool !== readPool) {
  readReplicaPool.on('error', (err) => logger.error('Read replica pool idle client error', { error: err }));
}

let citusCapability = null;

/**
 * Detects once whether the connected server is Citus, with pg_partman and native
 * uuidv7 available. Used by migrations, health output and the status script so the
 * same code runs on a Citus cluster, a vanilla PostgreSQL 18, or CI.
 */
async function probeCapabilities(client = null) {
  if (citusCapability) return citusCapability;

  const executor = client || writePool;
  const { rows } = await executor.query(`
    SELECT
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citus')                           AS citus_installed,
      EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'citus')                   AS citus_available,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_partman')                      AS partman_installed,
      EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_partman')              AS partman_available,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7')                               AS native_uuidv7,
      current_setting('server_version_num')::int                                            AS server_version_num
  `);

  const row = rows[0] || {};
  citusCapability = {
    citusInstalled: Boolean(row.citus_installed),
    citusAvailable: Boolean(row.citus_available),
    partmanInstalled: Boolean(row.partman_installed),
    partmanAvailable: Boolean(row.partman_available),
    nativeUuidv7: Boolean(row.native_uuidv7),
    serverVersionNum: Number(row.server_version_num || 0)
  };
  return citusCapability;
}

function resetCapabilityCache() {
  citusCapability = null;
}

/**
 * Runs `fn(client)` inside a single database transaction.
 *
 * The client is returned to the pool on EVERY path — this function checks out exactly
 * one connection and there is exactly one `release` for it. Getting that wrong is not a
 * subtle bug: a transaction that forgets to release leaks a connection permanently, and
 * a pool with `max` connections then stops working entirely once `max` transactions
 * have run. The `finally` below is what makes "exactly once" structural rather than
 * something each exit path has to remember.
 *
 * Retries are deliberately NOT handled here — callers compose this with
 * `executeWithRetry` so that the *whole* transaction is replayed on a transient
 * failure (40001/40P01/connection loss), never just the last statement.
 */
async function withTransaction(fn, options = {}) {
  const pool = options.pool || writePool;
  const client = await pool.connect();

  try {
    await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
  } catch (err) {
    // Never started a transaction, so there is nothing to roll back — but the
    // connection may be the reason it failed, hence `release(err)`.
    client.release(err);
    throw err;
  }

  let releasedAsDamaged = false;

  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    let damage = null;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is unusable (e.g. the worker went away mid-transaction).
      // The original error is the one worth surfacing; this one just decides whether
      // the connection gets reused or destroyed.
      logger.warn('ROLLBACK failed; discarding connection', { error: rollbackErr.message });
      damage = rollbackErr;
    }
    // Releasing with an error destroys a possibly-broken connection instead of handing
    // it to the next caller.
    if (damage) {
      client.release(damage);
      releasedAsDamaged = true;
    }
    throw err;
  } finally {
    // Reached on the success path and after a successful rollback — a single release
    // for a single checkout. Damaged connections were already released above.
    if (!releasedAsDamaged) client.release();
  }
}

/** Convenience query against the write model (implicit single-statement txn). */
function query(text, params, options = {}) {
  const pool = options.pool || writePool;
  return pool.query(text, params);
}

/** Convenience query against the read model's primary (projection writes). */
function readQuery(text, params) {
  return readPool.query(text, params);
}

/** Convenience query for search traffic: the replica when one is configured. */
function readReplicaQuery(text, params) {
  return readReplicaPool.query(text, params);
}

/** Lightweight liveness probe used by /api/health. */
async function health() {
  const startedAt = Date.now();
  try {
    const probeReplica = readReplicaPool !== readPool;
    const [write, read, replica] = await Promise.allSettled([
      writePool.query('SELECT 1 AS ok'),
      readPool.query('SELECT 1 AS ok'),
      ...(probeReplica ? [readReplicaPool.query('SELECT 1 AS ok')] : [])
    ]);

    const capabilities = write.status === 'fulfilled' ? await probeCapabilities() : null;

    return {
      writeModel: write.status === 'fulfilled' ? 'CONNECTED' : 'DISCONNECTED',
      readModel: read.status === 'fulfilled' ? 'CONNECTED' : 'DISCONNECTED',
      ...(probeReplica
        ? {
            readReplica: replica.status === 'fulfilled' ? 'CONNECTED' : 'DISCONNECTED',
            ...(replica.status === 'rejected' ? { readReplicaError: replica.reason.message } : {})
          }
        : {}),
      latencyMs: Date.now() - startedAt,
      topology: capabilities
        ? {
            citus: capabilities.citusInstalled,
            pgPartman: capabilities.partmanInstalled,
            nativeUuidv7: capabilities.nativeUuidv7,
            serverVersionNum: capabilities.serverVersionNum
          }
        : null,
      ...(write.status === 'rejected' ? { writeError: write.reason.message } : {}),
      ...(read.status === 'rejected' ? { readError: read.reason.message } : {})
    };
  } catch (err) {
    return {
      writeModel: 'DISCONNECTED',
      readModel: 'DISCONNECTED',
      latencyMs: Date.now() - startedAt,
      error: err.message
    };
  }
}

async function close() {
  const pools = [writePool.end(), readPool.end()];
  if (readReplicaPool !== readPool) pools.push(readReplicaPool.end());
  await Promise.allSettled(pools);
}

module.exports = {
  writePool,
  readPool,
  readReplicaPool,
  writeConnectionString,
  withTransaction,
  query,
  readQuery,
  readReplicaQuery,
  health,
  probeCapabilities,
  resetCapabilityCache,
  close
};
