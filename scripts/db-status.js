#!/usr/bin/env node
/**
 * `npm run db:status` — the read-only operational report an on-call engineer runs first.
 *
 * Why it exists: during an incident the first question is always "what is actually
 * reachable, and how far behind is it?". Answering that by hand means several psql
 * sessions across two databases, a catalog query for the Citus topology, and an outbox
 * scan — slow and error-prone at 3am. This script answers it in one command.
 *
 * The defining property is that it NEVER fails on a broken dependency. The read model
 * being down is *data in the report*, not a crash, because the script you reach for during
 * an outage must not itself become the outage. Every probe runs independently and catches
 * its own failure: a dead read database costs you the read-model section and nothing else.
 *
 * What it reports:
 *   - connectivity, latency and server version for the write (Citus) and read models
 *   - applied / pending / drifted migrations, tracked and reported per database
 *   - Citus version and topology (worker nodes, distributed tables, shard count) when Citus
 *     is present, via the src/db/citus.js helpers rather than hand-rolled catalog SQL
 *   - row counts and partition counts for every table in both models
 *   - the partition horizon: which monthly partitions exist for bookings/payments and
 *     whether the next N months (PARTITION_MONTHS_AHEAD) are pre-created. A missing month
 *     is the single most common cause of a failing bulk load — the insert fails loudly with
 *     "no partition of relation ... found for row" — so it is worth checking before it does
 *   - outbox backlog: pending events and the age of the oldest, which is the honest measure
 *     of read-model staleness
 *   - the oversell audit (inventoryRepository.audit): counter/bookings drift the CHECK
 *     constraints cannot catch, because they only bound a single row
 *
 * Nothing here writes to either database, so it is safe to run at any time, including while
 * a load is running.
 *
 * Exit codes:
 *   0  every check passed
 *   1  a check failed — unreachable database, pending or drifted migration, uncovered
 *      partition horizon, outbox beyond READMODEL_LAG_SLA_SECONDS, or any oversell violation
 *   2  usage error (unknown argument)
 *
 * Usage:
 *   node scripts/db-status.js            # human-readable report
 *   node scripts/db-status.js --json     # one JSON object, for monitoring/automation
 *   node scripts/db-status.js --help
 */
'use strict';

const env = require('../src/config/env');
const pool = require('../src/db/pool');
const citus = require('../src/db/citus');
const migrate = require('../src/db/migrate');
const outboxRepository = require('../src/repositories/outboxRepository');
const inventoryRepository = require('../src/repositories/inventoryRepository');
const availabilityRepository = require('../src/repositories/availabilityRepository');

// The horizon is "the next N months" for the tables a booking writes to. N mirrors the
// maintenance window the partition job uses, so a report that says "covered" means the
// same thing `npm run partitions:maintain` guarantees.
const HORIZON_MONTHS = env.PARTITION_MONTHS_AHEAD;
const HORIZON_PARENTS = ['bookings', 'payments'];

// The age at which outbox lag stops being "catching up" and becomes an incident. It is the
// same SLA the API advertises in x-read-model-lag-ms, so the check cannot disagree with the
// number clients are already being shown.
const OUTBOX_SLA_SECONDS = env.READMODEL_LAG_SLA_SECONDS;

// Enough sample violations to see a pattern, not so many that a corrupted table floods the
// report. `violationCount` is the true total regardless of this cap.
const AUDIT_SAMPLE_LIMIT = 50;

// Every table in each model, in dependency order so the report reads like the schema. Row
// counts are exact (not pg_class estimates): an operator needs the real number, and every
// count is individually guarded so one slow table cannot blank the section.
const WRITE_TABLES = [
  'airlines',
  'airports',
  'cabins',
  'aircraft_types',
  'seat_map_templates',
  'users',
  'flights',
  'flight_inventory',
  'bookings',
  'payments',
  'booking_outbox',
  'user_bookings',
  'refresh_tokens'
];
const READ_TABLES = ['flight_availability', 'projection_state'];

const WRITE_PARTITIONED = ['flights', 'flight_inventory', 'bookings', 'payments', 'booking_outbox'];
const READ_PARTITIONED = ['flight_availability'];

// Table names come from the whitelists above, never from user input, but the check keeps a
// future edit from turning a typo into SQL injection.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const USAGE =
  'Usage: node scripts/db-status.js [--json] [--help]\n' +
  '  --json   emit a single machine-readable JSON object\n' +
  '  --help   show this message\n';

const HELP = `
db-status - read-only operational report for the airline inventory databases.

Reports connectivity, migrations, Citus topology, per-table row/partition counts, the
bookings/payments partition horizon, outbox backlog and the oversell audit. It is safe to
run at any time: it never writes, and a broken dependency is reported rather than fatal.

${USAGE}
Exit codes: 0 healthy, 1 a check failed, 2 usage error.
`;

function parseArgs(argv) {
  const args = { json: false, help: false, error: null };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else args.error = `Unknown argument: ${arg}`;
  }
  return args;
}

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatNumber(value) {
  if (value === null || value === undefined) return 'n/a';
  return Number(value).toLocaleString('en-US');
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** `YYYYMM` keys for the current UTC month through `count` months ahead, inclusive. */
function monthKeysAhead(count, now = new Date()) {
  const keys = [];
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let index = 0; index <= count; index += 1) {
    const date = new Date(Date.UTC(year, month + index, 1));
    keys.push(`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

/**
 * One connection probe. `SELECT` instead of a bare `SELECT 1` so the same round trip also
 * identifies *which* database answered and which server version it is — the two facts that
 * disambiguate "the pool is misconfigured" from "the wrong database is up".
 */
async function probeConnection(targetPool) {
  const startedAt = Date.now();
  try {
    const { rows } = await targetPool.query(
      `SELECT current_database()                        AS database,
              current_setting('server_version')         AS server_version,
              current_setting('server_version_num')::int AS server_version_num`
    );
    const row = rows[0] || {};
    return {
      status: 'CONNECTED',
      latencyMs: Date.now() - startedAt,
      database: row.database || null,
      serverVersion: row.server_version || null,
      serverVersionNum: Number(row.server_version_num || 0)
    };
  } catch (err) {
    return { status: 'DOWN', latencyMs: Date.now() - startedAt, error: err.message };
  }
}

/**
 * Applied / pending / drifted migrations for one target database.
 *
 * Read straight from `schema_migrations` rather than through `migrate.status()`, because
 * that helper loops over both targets and throws on the first unreachable one — which would
 * take the *readable* database's report down with the unreachable one. The migration list
 * itself still comes from the registry (`migrate.migrationsForTarget`) and drift still uses
 * the runner's own checksum, so the answer is identical, only per-database.
 */
async function probeMigrations(target) {
  const targetPool = target === 'read' ? pool.readPool : pool.writePool;
  const expected = migrate.migrationsForTarget(target);

  let applied = new Map();
  let reachable = true;
  let error = null;

  try {
    const { rows } = await targetPool.query(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version'
    );
    applied = new Map(rows.map((row) => [row.version, row]));
  } catch (err) {
    // 42P01 = the table has never been created, i.e. nothing has been applied here yet.
    // That is a normal state on a fresh database, not a reachability failure.
    if (err.code !== '42P01') {
      reachable = false;
      error = err.message;
    }
  }

  const entries = expected.map((migration) => {
    const record = applied.get(migration.id);
    return {
      id: migration.id,
      name: migration.name,
      applied: Boolean(record),
      appliedAt: record ? record.applied_at : null,
      drifted: Boolean(record) && record.checksum !== migrate.checksumOf(migration)
    };
  });

  return {
    target,
    reachable,
    error,
    entries,
    pending: entries.filter((entry) => !entry.applied),
    drifted: entries.filter((entry) => entry.drifted),
    upToDate: reachable && entries.every((entry) => entry.applied)
  };
}

/** Citus topology via the citus.js helpers, plus the extension version they do not expose. */
async function probeCitus() {
  try {
    const topology = await citus.describeTopology(pool.writePool);
    let version = null;
    if (topology.citus) {
      const { rows } = await pool.writePool.query(
        "SELECT extversion FROM pg_extension WHERE extname = 'citus'"
      );
      version = rows[0] ? rows[0].extversion : null;
    }
    return { ...topology, version, error: null };
  } catch (err) {
    return { citus: false, reachable: false, error: err.message };
  }
}

/**
 * Every partition name in the connected database, grouped by parent table.
 *
 * One catalog query serves both the per-table partition count and the horizon check, and it
 * filters on `c.relispartition` so index partitions (which share pg_inherits) never inflate
 * a table's count.
 */
async function loadPartitions(targetPool) {
  const { rows } = await targetPool.query(`
    SELECT p.relname AS parent, c.relname AS partition
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE c.relispartition
       AND c.relkind = 'r'
       AND p.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
     ORDER BY p.relname, c.relname
  `);

  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.parent)) byParent.set(row.parent, []);
    byParent.get(row.parent).push(row.partition);
  }
  return byParent;
}

function partitionInfo(parent, partitionNames) {
  const months = partitionNames
    .map((name) => {
      const match = /_p(\d{6})$/.exec(name);
      return match ? match[1] : null;
    })
    .filter(Boolean)
    .sort();
  return {
    parent,
    count: partitionNames.length,
    earliestMonth: months[0] || null,
    latestMonth: months[months.length - 1] || null
  };
}

function buildHorizon(parent, partitionNames) {
  const existing = new Set(
    partitionNames
      .map((name) => {
        const match = /_p(\d{6})$/.exec(name);
        return match ? match[1] : null;
      })
      .filter(Boolean)
  );
  const expected = monthKeysAhead(HORIZON_MONTHS);
  const missing = expected.filter((month) => !existing.has(month));
  const sorted = [...existing].sort();
  return {
    parent,
    monthsAhead: HORIZON_MONTHS,
    existingCount: partitionNames.length,
    earliestMonth: sorted[0] || null,
    latestMonth: sorted[sorted.length - 1] || null,
    missingMonths: missing,
    covered: missing.length === 0
  };
}

/** Exact row count and partition count per table. Each table is guarded independently. */
async function probeTables(targetPool, tables) {
  let partitionsByParent = new Map();
  let catalogError = null;
  try {
    partitionsByParent = await loadPartitions(targetPool);
  } catch (err) {
    catalogError = err.message;
  }

  const result = {};
  for (const table of tables) {
    const entry = { rows: null, partitions: null, error: null };
    try {
      if (!SAFE_IDENTIFIER.test(table)) throw new Error(`unsafe table name '${table}'`);
      const { rows } = await targetPool.query(`SELECT count(*)::bigint AS n FROM ${table}`);
      entry.rows = Number(rows[0].n);
      // Only claim a partition count when the catalog actually loaded: reporting 0 because
      // the catalog query failed would look like "no partitions", which is a real incident.
      if (!catalogError) entry.partitions = (partitionsByParent.get(table) || []).length;
    } catch (err) {
      entry.error = err.message;
    }
    result[table] = entry;
  }

  return { tables: result, catalogError };
}

async function probePartitions(targetPool, partitionedParents) {
  const empty = () => ({ parent: null, count: null, earliestMonth: null, latestMonth: null, error: null });
  const perParent = {};
  for (const parent of partitionedParents) perParent[parent] = { ...empty(), parent };

  try {
    const byParent = await loadPartitions(targetPool);
    for (const parent of partitionedParents) {
      perParent[parent] = partitionInfo(parent, byParent.get(parent) || []);
    }
    const horizon = HORIZON_PARENTS.filter((parent) => partitionedParents.includes(parent)).map(
      (parent) => buildHorizon(parent, byParent.get(parent) || [])
    );
    return { perParent, horizon };
  } catch (err) {
    // The connection is up but the catalog is not readable (permissions, or a catalog that
    // will not answer). Report it per parent; an unreadable horizon must never look covered.
    for (const parent of partitionedParents) {
      perParent[parent] = { ...empty(), parent, error: err.message };
    }
    const horizon = HORIZON_PARENTS.filter((parent) => partitionedParents.includes(parent)).map(
      (parent) => ({
        parent,
        monthsAhead: HORIZON_MONTHS,
        existingCount: null,
        earliestMonth: null,
        latestMonth: null,
        missingMonths: [],
        covered: false,
        error: err.message
      })
    );
    return { perParent, horizon };
  }
}

async function probeOutbox() {
  try {
    const stats = await outboxRepository.stats(pool.writePool);
    return { reachable: true, error: null, ...stats };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

async function probeOversellAudit() {
  try {
    // One read-only transaction: the audit is two CTEs over bookings and flight_inventory,
    // and a single snapshot is what keeps them consistent with each other.
    const result = await pool.withTransaction(
      (client) => inventoryRepository.audit(client, { limit: AUDIT_SAMPLE_LIMIT }),
      { readOnly: true }
    );
    return { reachable: true, error: null, ...result };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

async function probeReadModel() {
  const connection = await probeConnection(pool.readPool);
  let projection = null;
  if (connection.status === 'CONNECTED') {
    try {
      const lagSeconds = await availabilityRepository.projectionLagSeconds(pool.readPool, {
        projection: 'flight_availability'
      });
      const state = await availabilityRepository.getProjectionState(pool.readPool, {
        projection: 'flight_availability'
      });
      projection = {
        name: 'flight_availability',
        lagSeconds,
        lastEventAt: state ? state.last_event_at : null,
        slaSeconds: env.READMODEL_LAG_SLA_SECONDS
      };
    } catch (err) {
      // The projection is unreadable (e.g. 42P01 on a read model that was never migrated),
      // so lagSeconds is genuinely unknown and the render shows 'n/a' for it. slaSeconds is
      // different: it is a configured constant, not a fact read from the database, so it is
      // known regardless of whether projection_state answered. The success branch above sets
      // it and the freshness line interpolates it unconditionally, so omitting it here made
      // that line print 'sla=undefined' whenever the read DB was up but this probe failed.
      projection = {
        name: 'flight_availability',
        lagSeconds: null,
        slaSeconds: env.READMODEL_LAG_SLA_SECONDS,
        error: err.message
      };
    }
  }
  return { connection, projection };
}

function unreachableMigrations(target, message) {
  return { target, reachable: false, error: message, entries: [], pending: [], drifted: [], upToDate: false };
}

async function buildReport() {
  const [writeConnection, readProbe] = await Promise.all([
    probeConnection(pool.writePool),
    probeReadModel()
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    nodeId: env.NODE_ID,
    config: {
      partitionMonthsAhead: env.PARTITION_MONTHS_AHEAD,
      partitionMonthsBehind: env.PARTITION_MONTHS_BEHIND,
      partitionRetentionMonths: env.PARTITION_RETENTION_MONTHS,
      outboxLagSlaSeconds: OUTBOX_SLA_SECONDS
    },
    connections: { write: writeConnection, read: readProbe.connection },
    readModel: readProbe.projection,
    migrations: { write: null, read: null },
    citus: null,
    tables: { write: null, read: null },
    partitions: { write: null, read: null },
    partitionHorizon: [],
    outbox: null,
    oversellAudit: null
  };

  // The write model is the authoritative one; every section derived from it is skipped —
  // but the report still renders — when it is down.
  if (writeConnection.status === 'CONNECTED') {
    report.migrations.write = await probeMigrations('write');
    report.citus = await probeCitus();
    report.tables.write = await probeTables(pool.writePool, WRITE_TABLES);
    report.partitions.write = await probePartitions(pool.writePool, WRITE_PARTITIONED);
    report.partitionHorizon = report.partitions.write.horizon;
    report.outbox = await probeOutbox();
    report.oversellAudit = await probeOversellAudit();
  } else {
    report.migrations.write = unreachableMigrations('write', 'write model unreachable');
    report.tables.write = { tables: {}, catalogError: 'write model unreachable' };
    report.partitions.write = { perParent: {}, horizon: [] };
    report.outbox = { reachable: false, error: 'write model unreachable' };
    report.oversellAudit = { reachable: false, error: 'write model unreachable' };
  }

  if (readProbe.connection.status === 'CONNECTED') {
    report.migrations.read = await probeMigrations('read');
    report.tables.read = await probeTables(pool.readPool, READ_TABLES);
    report.partitions.read = await probePartitions(pool.readPool, READ_PARTITIONED);
  } else {
    report.migrations.read = unreachableMigrations('read', 'read model unreachable');
    report.tables.read = { tables: {}, catalogError: 'read model unreachable' };
    report.partitions.read = { perParent: {}, horizon: [] };
  }

  return report;
}

function evaluateChecks(report) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail) });

  add(
    'write.connectivity',
    report.connections.write.status === 'CONNECTED',
    report.connections.write.status === 'CONNECTED'
      ? `${report.connections.write.latencyMs}ms`
      : report.connections.write.error || 'unreachable'
  );
  add(
    'read.connectivity',
    report.connections.read.status === 'CONNECTED',
    report.connections.read.status === 'CONNECTED'
      ? `${report.connections.read.latencyMs}ms`
      : report.connections.read.error || 'unreachable'
  );

  for (const target of ['write', 'read']) {
    const migration = report.migrations[target];
    const reachable = Boolean(migration && migration.reachable);
    add(
      `migrations.${target}`,
      reachable && migration.upToDate,
      reachable ? `pending=${migration.pending.length}` : migration?.error || 'unreachable'
    );
    add(
      `migrations.${target}.drift`,
      reachable && migration.drifted.length === 0,
      reachable ? `drifted=${migration.drifted.length}` : migration?.error || 'unreachable'
    );
  }

  for (const horizon of report.partitionHorizon) {
    add(
      `partitions.${horizon.parent}`,
      horizon.covered,
      horizon.error
        ? `unreadable: ${horizon.error}`
        : horizon.covered
          ? `covered through ${horizon.latestMonth}`
          : `missing=${horizon.missingMonths.join(',')}`
    );
  }

  const outbox = report.outbox;
  add(
    'outbox.backlog',
    Boolean(outbox && outbox.reachable) && Number(outbox.lagSeconds || 0) <= OUTBOX_SLA_SECONDS,
    outbox && outbox.reachable
      ? `pending=${outbox.pending} age=${Math.round(outbox.lagSeconds || 0)}s sla=${OUTBOX_SLA_SECONDS}s`
      : outbox?.error || 'unreachable'
  );

  const audit = report.oversellAudit;
  add(
    'oversell.audit',
    Boolean(audit && audit.reachable) && audit.violationCount === 0,
    audit && audit.reachable
      ? `${audit.violationCount} violations in ${audit.checkedRows} rows`
      : audit?.error || 'unreachable'
  );

  return checks;
}

function renderHuman(report) {
  const lines = [];
  const push = (line = '') => lines.push(line);

  push('=== Distributed Airline Inventory - Database Status ===');
  push(`generated ${iso(report.generatedAt)}   node ${report.nodeId}`);
  push('');

  push('Connections');
  for (const [label, connection] of [
    ['write model', report.connections.write],
    ['read model', report.connections.read]
  ]) {
    if (connection.status === 'CONNECTED') {
      push(
        `  ${pad(label, 12)} CONNECTED  ${pad(connection.latencyMs + 'ms', 7)}` +
          ` ${pad(connection.database || '?', 18)} PostgreSQL ${connection.serverVersion || '?'}`
      );
    } else {
      push(`  ${pad(label, 12)} DOWN       ${connection.error || 'unreachable'}`);
    }
  }
  push('');

  for (const target of ['write', 'read']) {
    const migration = report.migrations[target];
    push(`Migrations [${target}]`);
    if (!migration.reachable) {
      push(`  UNREACHABLE: ${migration.error}`);
    } else {
      for (const entry of migration.entries) {
        const mark = entry.drifted ? 'DRIFT' : entry.applied ? 'applied' : 'PENDING';
        const at = entry.applied ? iso(entry.appliedAt) : '';
        push(`  ${entry.id} ${pad(entry.name, 30)} ${pad(mark, 8)} ${at}`);
      }
      push(`  ${migration.pending.length} pending, ${migration.drifted.length} drifted`);
    }
    push('');
  }

  push('Citus');
  if (!report.citus) {
    push('  (not probed - write model unreachable)');
  } else if (report.citus.reachable === false || report.citus.error) {
    // A probe that threw is NOT the same finding as "Citus is absent", and the two must not
    // render alike. describeTopology only returns a citus:false shape when the extension is
    // genuinely missing; probeCitus's catch wraps a *failed* probe in
    // { citus:false, reachable:false, error }. Without this branch that object fell into the
    // 'tables are local' case below and told the on-call engineer the opposite of the truth
    // — on a real Citus cluster whose pg_dist_* catalog query timed out or was denied, the
    // report asserted the tables were local, with no hint the probe had broken. The message
    // and the unreachable flag survive in --json regardless; this is what makes the human
    // report agree with it.
    push(`  UNREADABLE: ${report.citus.error}`);
  } else if (!report.citus.citus) {
    push(`  Citus not active - tables are local (installed=${report.citus.citusInstalled})`);
  } else {
    push(
      `  citus ${report.citus.version || '?'}  activeWorkers=${report.citus.activeWorkers}` +
        `  shards=${report.citus.shardCount}`
    );
    const nodes = report.citus.nodes || [];
    if (nodes.length === 0) push('  no worker nodes registered');
    else {
      for (const node of nodes) {
        push(
          `  node ${pad(node.nodename + ':' + node.nodeport, 24)} ${pad(node.noderole, 8)}` +
            ` ${node.isactive ? 'active' : 'INACTIVE'}`
        );
      }
    }
    for (const table of report.citus.distributedTables || []) {
      push(
        `  distributed ${pad(table.table_name, 24)} colocation=${table.colocationid}` +
          ` method=${table.partmethod}`
      );
    }
  }
  push('');

  for (const [label, tables] of [
    ['write model', report.tables.write],
    ['read model', report.tables.read]
  ]) {
    push(`Tables [${label}]`);
    const names = Object.keys(tables.tables || {});
    if (names.length === 0) {
      push('  (unreachable)');
    } else {
      for (const name of names) {
        const info = tables.tables[name];
        const parts = info.partitions === null ? '' : `  ${info.partitions} partitions`;
        const err = info.error ? `  ERROR: ${info.error}` : '';
        push(`  ${pad(name, 20)} ${pad(formatNumber(info.rows), 16)} rows${parts}${err}`);
      }
      if (tables.catalogError) push(`  partition catalog: ${tables.catalogError}`);
    }
    push('');
  }

  push(`Partition horizon [${HORIZON_PARENTS.join(', ')}] - next ${HORIZON_MONTHS} months`);
  if (report.partitionHorizon.length === 0) {
    push('  (not probed - write model unreachable)');
  } else {
    for (const horizon of report.partitionHorizon) {
      if (horizon.error) {
        push(`  ${pad(horizon.parent, 10)} UNREADABLE ${horizon.error}`);
        continue;
      }
      push(
        `  ${pad(horizon.parent, 10)} ${pad(horizon.covered ? 'covered' : 'MISSING', 8)}` +
          ` earliest=${horizon.earliestMonth || 'none'} latest=${horizon.latestMonth || 'none'}` +
          (horizon.covered ? '' : ` missing=${horizon.missingMonths.join(',')}`)
      );
    }
  }
  push('');

  push('Outbox backlog');
  if (!report.outbox) {
    push('  (not probed)');
  } else if (!report.outbox.reachable) {
    push(`  UNREACHABLE: ${report.outbox.error}`);
  } else {
    push(
      `  pending=${report.outbox.pending} published=${report.outbox.published}` +
        ` oldestAge=${Math.round(report.outbox.lagSeconds || 0)}s` +
        ` maxAttempts=${report.outbox.maxAttempts} sla=${OUTBOX_SLA_SECONDS}s`
    );
  }
  push('');

  push('Oversell audit');
  if (!report.oversellAudit) {
    push('  (not probed)');
  } else if (!report.oversellAudit.reachable) {
    push(`  UNREACHABLE: ${report.oversellAudit.error}`);
  } else {
    push(`  ${report.oversellAudit.checkedRows} rows checked, ${report.oversellAudit.violationCount} violations`);
    for (const violation of report.oversellAudit.violations || []) {
      push(
        `    ${violation.violation} ${violation.flightId} ${violation.departureDate} ${violation.cabin}` +
          ` avail=${violation.availableSeats} held=${violation.heldSeats}` +
          ` confirmed=${violation.confirmedSeats} bookings(pending=${violation.pendingBookings},` +
          ` confirmed=${violation.confirmedBookings})`
      );
    }
  }
  push('');

  if (report.readModel) {
    push('Read model freshness');
    push(
      `  ${report.readModel.name} lag=${report.readModel.lagSeconds === null ? 'n/a' : Math.round(report.readModel.lagSeconds) + 's'}` +
        ` sla=${report.readModel.slaSeconds}s lastEventAt=${iso(report.readModel.lastEventAt) || 'none'}`
    );
    if (report.readModel.error) push(`  ERROR: ${report.readModel.error}`);
    push('');
  }

  push('Checks');
  for (const check of report.checks) {
    push(`  ${check.ok ? 'OK  ' : 'FAIL'} ${pad(check.name, 28)} ${check.detail}`);
  }
  push(report.healthy ? 'RESULT: healthy' : 'RESULT: CHECK FAILED');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.error) {
    process.stderr.write(`${args.error}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const report = await buildReport();
  const checks = evaluateChecks(report);
  report.checks = checks;
  report.healthy = checks.every((check) => check.ok);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(report)}\n`);
  }

  return report.healthy ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`db-status failed: ${err.message}\n`);
    if (process.env.DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Every exit path closes the pools: a script that leaves the process alive on an open
    // idle connection is a hung terminal the operator has to kill while already under stress.
    await pool.close();
  });
