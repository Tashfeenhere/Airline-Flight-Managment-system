#!/usr/bin/env node
/**
 * `node scripts/citus-init.js` — converge a plain PostgreSQL cluster onto the intended
 * Citus topology, idempotently.
 *
 * The operational problem this solves
 * -----------------------------------
 * Distribution is decided at *migration* time: `db/migrations/003-005,010` call the
 * `src/db/citus.js` helpers, and those helpers only distribute when Citus is installed
 * *and* at least one worker is already registered. That ordering is easy to get wrong —
 * start the coordinator, run `db:migrate`, then register workers, and every table is
 * still a local table. Re-running `db:migrate` does not fix it: the tables already
 * exist, so the `CREATE TABLE IF NOT EXISTS` blocks are skipped and their distribution
 * step never runs. The schema is correct, the data is correct, and every booking is
 * silently a distributed transaction across shards — the exact bug that turns a
 * single-worker commit into 2PC. This script exists to close that gap.
 *
 * What it does
 * ------------
 *   1. Reports whether the `citus` extension is present at all. A vanilla PostgreSQL
 *      (the local `.pgdata` cluster, CI) has no Citus and needs none: it is a fully
 *      supported single-node configuration, so this degrades to a clear message rather
 *      than an error.
 *   2. Registers worker nodes (`--add-worker host:port`, repeatable; falls back to
 *      `CITUS_WORKER_HOSTS` from the environment when no flag is given).
 *   3. Promotes the small dimension tables to Citus *reference* tables and the large
 *      tables to *distributed* tables with the intended distribution column:
 *        - by `flight_id`: flights, flight_inventory, bookings, payments, booking_outbox
 *          — all in ONE co-location group so a booking that touches every one of them
 *          still commits as a single local transaction on a single worker.
 *        - by `user_id`: user_bookings, refresh_tokens — the per-user access paths.
 *   4. Prints the resulting topology (table, kind, distribution column, co-location
 *      group) and checks it against the intent, because a silent misdistribution is
 *      invisible until it is an incident.
 *
 * Idempotence is the contract: every step is a guarded check-then-act. On a cluster
 * that is already configured every action reports "already ...", no DDL is issued, and
 * the run ends with "already configured".
 *
 * DDL discipline
 * --------------
 * Citus rejects `create_distributed_table` / `create_reference_table` / `citus_add_node`
 * inside a transaction block, so every statement here is issued as a single autocommit
 * statement through `pool.writePool`. Nothing in this file opens a transaction, and the
 * `src/db/citus.js` helpers obey the same rule.
 *
 * Talk to the coordinator, not PgBouncer
 * --------------------------------------
 * Like `npm run db:migrate` (see the `migrate` service in docker-compose.yml), this
 * script must reach the Citus coordinator directly. PgBouncer is transaction pooling for
 * application queries and is not the DDL endpoint; if `PGBOUNCER_URL` is set in the
 * environment, unset it for this run so the pool resolves `CITUS_COORDINATOR_URL`.
 *
 * Usage:
 *   node scripts/citus-init.js                             # converge, then print topology
 *   node scripts/citus-init.js --add-worker worker3:5432   # register a worker, then converge
 *   node scripts/citus-init.js --verify                    # report only; change nothing
 *   node scripts/citus-init.js --dry-run                   # show the plan; change nothing
 *   node scripts/citus-init.js --json                      # one machine-readable object
 *   node scripts/citus-init.js --help
 *
 * Exit codes:
 *   0  success (including the supported "single-node, Citus absent" configuration)
 *   1  failure or a check failed (the topology does not match the intent)
 *   2  usage error (unknown option, or a malformed --add-worker value)
 */
'use strict';

const env = require('../src/config/env');
const pool = require('../src/db/pool');
const citus = require('../src/db/citus');

// Small, shared dimensions: replicated in full to every worker so any distributed query
// can join them locally. Order matters — a FK target must already be a reference table
// before the table that references it is promoted (seat_map_templates -> aircraft_types,
// cabins), so this mirrors the order in db/migrations/008.
const REFERENCE_TABLES = Object.freeze([
  'airlines',
  'airports',
  'cabins',
  'aircraft_types',
  'seat_map_templates',
  'users'
]);

// The booking path. `flights` is the anchor: distributing it with an explicit shard count
// creates the co-location group, and every later table joins it *by name*. Getting this
// list wrong (or missing a `colocateWith`) is what splits a booking across shards, so the
// verification below checks the group explicitly rather than trusting the DDL.
const FLIGHT_TABLES = Object.freeze([
  { table: 'flights', column: 'flight_id', colocateWith: null },
  { table: 'flight_inventory', column: 'flight_id', colocateWith: 'flights' },
  { table: 'bookings', column: 'flight_id', colocateWith: 'flights' },
  { table: 'payments', column: 'flight_id', colocateWith: 'flights' },
  { table: 'booking_outbox', column: 'flight_id', colocateWith: 'flights' }
]);

// Per-user access paths. `user_bookings` is the secondary index behind "my bookings";
// `refresh_tokens` is the rotating-token table. Different distribution key from the
// booking tables is precisely why the projection is asynchronous — but the two share one
// group with each other so a token rotation is one single-shard transaction.
const USER_TABLES = Object.freeze([
  { table: 'user_bookings', column: 'user_id', colocateWith: null },
  { table: 'refresh_tokens', column: 'user_id', colocateWith: 'user_bookings' }
]);

const ALL_TABLE_NAMES = Object.freeze([
  ...REFERENCE_TABLES,
  ...FLIGHT_TABLES.map((spec) => spec.table),
  ...USER_TABLES.map((spec) => spec.table)
]);

// Citus's default port; used when a worker target omits it.
const DEFAULT_CITUS_PORT = 5432;

const OUTCOME_LABELS = Object.freeze({
  done: '[ DONE ]',
  skipped: '[  OK  ]',
  planned: '[ PLAN ]',
  verify: '[CHECK ]',
  warn: '[ WARN ]',
  error: '[ FAIL ]'
});

const USAGE =
  'Usage: node scripts/citus-init.js [--add-worker host:port]... [--verify] [--dry-run] [--json] [--help]\n';

const HELP = `
citus-init - converge the write database onto the intended Citus topology.

Registers worker nodes, promotes the reference tables and distributes the large tables
into their co-location groups, then prints and checks the resulting topology. Every step
is idempotent: on an already-configured cluster it reports "already configured" and
issues no DDL. A cluster without Citus (vanilla PostgreSQL / the local .pgdata cluster)
is a supported single-node configuration and degrades to a clear message.

${USAGE}
Options:
  --add-worker <host:port>  Register a Citus worker node. Repeatable. Falls back to the
                            CITUS_WORKER_HOSTS environment list when omitted.
  --verify                  Report and check the topology only; change nothing.
                            Exits 1 when the topology does not match the intent.
  --dry-run                 Print the actions that would be taken; change nothing.
  --json                    Emit a single machine-readable JSON object.
  -h, --help                Show this message.

Exit codes: 0 success, 1 failure or a failed check, 2 usage error.
`;

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function action(kind, target, outcome, message) {
  return { kind, target, outcome, message: String(message) };
}

/**
 * Parses `--add-worker` / `CITUS_WORKER_HOSTS` entries as `host[:port]`.
 *
 * A missing port defaults to 5432 (Citus's own default) because CITUS_WORKER_HOSTS is
 * named for hosts; a bare hostname is the common case. Anything non-numeric after the
 * last colon is rejected here rather than reaching a query — a malformed target is an
 * operator typo, and a usage error is the honest answer.
 */
function parseWorkerTarget(raw) {
  const value = String(raw).trim();
  if (!value) throw new Error('empty worker target (expected host:port)');

  const separator = value.lastIndexOf(':');
  let host = value;
  let port = DEFAULT_CITUS_PORT;

  if (separator !== -1) {
    host = value.slice(0, separator);
    const portText = value.slice(separator + 1);
    if (!/^\d+$/.test(portText)) {
      throw new Error(`invalid port '${portText}' in '${value}' (expected host:port)`);
    }
    port = Number.parseInt(portText, 10);
  }

  if (!host) throw new Error(`missing host in '${value}' (expected host:port)`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`port out of range in '${value}' (expected 1-65535)`);
  }

  return { host, port, label: `${host}:${port}` };
}

function parseArgs(argv) {
  const args = {
    addWorkers: [],
    verify: false,
    dryRun: false,
    json: false,
    help: false,
    error: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--add-worker') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) args.error = '--add-worker requires a host:port value';
      else args.addWorkers.push(value);
    } else if (arg.startsWith('--add-worker=')) {
      args.addWorkers.push(arg.slice('--add-worker='.length));
    } else if (arg.startsWith('-')) {
      args.error = `Unknown option '${arg}'`;
    } else {
      args.error = `Unexpected argument '${arg}'`;
    }
  }

  return args;
}

/** The Citus extension version, or null when the extension is not installed. */
async function citusVersion(client) {
  const { rows } = await client.query(
    "SELECT extversion FROM pg_extension WHERE extname = 'citus'"
  );
  return rows[0] ? rows[0].extversion : null;
}

/** Registered nodes from the Citus catalog, in a shape the report can print directly. */
async function loadNodes(client) {
  const { rows } = await client.query(
    `SELECT nodeid, groupid, nodename, nodeport, noderole, nodecluster, isactive
       FROM pg_dist_node
      ORDER BY nodeid`
  );
  return rows.map((row) => ({
    nodeid: Number(row.nodeid),
    groupid: Number(row.groupid),
    nodename: row.nodename,
    nodeport: Number(row.nodeport),
    noderole: row.noderole,
    nodecluster: row.nodecluster,
    isactive: Boolean(row.isactive)
  }));
}

/**
 * Reads, in one place, the two catalog facts every decision in this script needs:
 * which tables exist, and which of them Citus has already placed.
 *
 * `column_to_column_name` is Citus's own translator for the packed `partkey` node tree;
 * it is guarded behind the `partmethod = 'n'` case because a reference table's partkey is
 * NULL and calling the function on it would be an error. Restricting to our known table
 * names keeps the query indexable and immune to schema-shadowing surprises.
 */
async function loadTopology(client) {
  const existingRows = (
    await client.query(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname = current_schema()
          AND c.relname = ANY($1::text[])`,
      [ALL_TABLE_NAMES]
    )
  ).rows;

  const distributedRows = (
    await client.query(
      `SELECT c.relname AS table_name,
              p.partmethod,
              p.colocationid,
              CASE WHEN p.partmethod = 'n' THEN NULL
                   ELSE column_to_column_name(p.logicalrelid, p.partkey::text) END AS distribution_column
         FROM pg_dist_partition p
         JOIN pg_class c ON c.oid = p.logicalrelid
        WHERE c.relname = ANY($1::text[])`,
      [ALL_TABLE_NAMES]
    )
  ).rows;

  return {
    existing: new Set(existingRows.map((row) => row.table_name)),
    distributed: new Map(
      distributedRows.map((row) => [
        row.table_name,
        {
          partmethod: row.partmethod,
          colocationId: row.colocationid === null ? null : Number(row.colocationid),
          distributionColumn: row.distribution_column || null
        }
      ])
    )
  };
}

/** The report's view of one table: 'absent' | 'local' | 'reference' | 'distributed'. */
function tableView(topology, name) {
  if (!topology.existing.has(name)) {
    return { name, kind: 'absent', distributionColumn: null, colocationId: null, partmethod: null };
  }
  const placement = topology.distributed.get(name);
  if (!placement) {
    return { name, kind: 'local', distributionColumn: null, colocationId: null, partmethod: null };
  }
  if (placement.partmethod === 'n') {
    return { name, kind: 'reference', distributionColumn: null, colocationId: placement.colocationId, partmethod: 'n' };
  }
  return {
    name,
    kind: 'distributed',
    distributionColumn: placement.distributionColumn,
    colocationId: placement.colocationId,
    partmethod: placement.partmethod
  };
}

function buildTableViews(topology) {
  return ALL_TABLE_NAMES.map((name) => tableView(topology, name));
}

/** Actual co-location grouping for a set of specs, so a split is visible, not assumed. */
function groupByColocation(topology, specs) {
  const byId = new Map();
  for (const spec of specs) {
    const view = tableView(topology, spec.table);
    if (view.kind !== 'distributed' || view.colocationId === null) continue;
    if (!byId.has(view.colocationId)) byId.set(view.colocationId, []);
    byId.get(view.colocationId).push(spec.table);
  }
  return [...byId.entries()].map(([colocationId, tables]) => ({ colocationId, tables }));
}

function buildGroups(topology) {
  return {
    flight: groupByColocation(topology, FLIGHT_TABLES),
    user: groupByColocation(topology, USER_TABLES)
  };
}

/** True when a table is distributed now or was distributed earlier in this same run. */
function isDistributed(ctx, name) {
  if (ctx.distributedUpToDate.has(name)) return true;
  return tableView(ctx.topology, name).kind === 'distributed';
}

/**
 * Registers one worker node, idempotently.
 *
 * `citus_add_node` has no wrapper in src/db/citus.js — workers are a one-time cluster
 * operation, not a per-table placement decision — so this is the single statement the
 * script issues itself. It is issued on a plain autocommit connection: Citus rejects node
 * management inside a transaction block. The catalog is re-read after a successful add so
 * a repeated target on the same command line is recognised rather than re-added.
 */
async function ensureWorker(client, target, ctx) {
  const registered = ctx.nodes.find(
    (node) => node.nodename === target.host && node.nodeport === target.port
  );

  if (registered) {
    ctx.actions.push(
      action(
        'worker',
        target.label,
        'skipped',
        `already registered (group ${registered.groupid}, ${registered.isactive ? 'active' : 'inactive'}, role ${registered.noderole})`
      )
    );
    return;
  }

  if (ctx.mode === 'verify') {
    ctx.actions.push(action('worker', target.label, 'warn', 'NOT registered'));
    return;
  }

  if (ctx.changeNothing) {
    ctx.actions.push(action('worker', target.label, 'planned', 'would be added as a Citus worker node'));
    return;
  }

  try {
    const { rows } = await client.query('SELECT citus_add_node($1, $2) AS nodeid', [
      target.host,
      target.port
    ]);
    ctx.actions.push(
      action('worker', target.label, 'done', `added as node ${rows[0].nodeid}; new shards may be placed on it`)
    );
    ctx.nodes = await loadNodes(client);
  } catch (err) {
    ctx.actions.push(action('worker', target.label, 'error', err.message));
  }
}

/**
 * Promotes one dimension table to a Citus reference table.
 *
 * A table that is already distributed is refused rather than converted: reference tables
 * have no distribution column, so flipping one back would move data and is not something
 * an init script should decide. That is a loud, manual intervention.
 */
async function ensureReferenceTable(client, table, ctx) {
  const view = tableView(ctx.topology, table);

  if (view.kind === 'absent') {
    ctx.actions.push(action('reference', table, 'warn', 'table does not exist yet — run `npm run db:migrate` first'));
    return;
  }
  if (view.kind === 'reference') {
    ctx.actions.push(action('reference', table, 'skipped', 'already a reference table'));
    return;
  }
  if (view.kind === 'distributed') {
    ctx.actions.push(
      action('reference', table, 'error', `already distributed by '${view.distributionColumn}'; refusing to convert — resolve manually`)
    );
    return;
  }
  if (ctx.changeNothing) {
    ctx.actions.push(action('reference', table, 'planned', 'would become a Citus reference table'));
    return;
  }

  try {
    await citus.makeReference(client, table);
    ctx.actions.push(action('reference', table, 'done', 'promoted to a Citus reference table'));
  } catch (err) {
    ctx.actions.push(action('reference', table, 'error', err.message));
  }
}

/**
 * Distributes one large table by its intended column, into its intended co-location group.
 *
 * The anchor table (no `colocateWith`) is distributed with the configured shard count,
 * which is what creates the group; every other table joins it by name. A dependent is
 * refused when its anchor is not distributed — that would quietly create a *new* group
 * and re-split the booking path — and a table already distributed by a different column
 * is refused outright, because a wrong distribution column is the silent bug this script
 * exists to catch.
 */
async function ensureDistributed(client, spec, ctx) {
  const view = tableView(ctx.topology, spec.table);

  if (view.kind === 'absent') {
    ctx.actions.push(action('distributed', spec.table, 'warn', 'table does not exist yet — run `npm run db:migrate` first'));
    return;
  }
  if (view.kind === 'reference') {
    ctx.actions.push(action('distributed', spec.table, 'error', 'is a reference table; expected a distributed table — resolve manually'));
    return;
  }
  if (view.kind === 'distributed') {
    if (view.distributionColumn !== spec.column) {
      ctx.actions.push(
        action('distributed', spec.table, 'error', `already distributed by '${view.distributionColumn}', expected '${spec.column}' — resolve manually`)
      );
      return;
    }
    ctx.actions.push(
      action('distributed', spec.table, 'skipped', `already distributed by ${spec.column} (colocation ${view.colocationId})`)
    );
    return;
  }

  // Local table: distribute it.
  if (spec.colocateWith && !isDistributed(ctx, spec.colocateWith)) {
    ctx.actions.push(
      action('distributed', spec.table, 'error', `cannot colocate with '${spec.colocateWith}' — it is not distributed`)
    );
    return;
  }

  if (ctx.changeNothing) {
    ctx.actions.push(
      action(
        'distributed',
        spec.table,
        'planned',
        spec.colocateWith
          ? `would be distributed by ${spec.column}, colocated with '${spec.colocateWith}'`
          : `would be distributed by ${spec.column} (new co-location group, ${citus.shardCount} shards)`
      )
    );
    // A later table may colocate with this one in the same dry run.
    ctx.distributedUpToDate.add(spec.table);
    return;
  }

  const options = spec.colocateWith
    ? { colocateWith: spec.colocateWith }
    : { shardCount: citus.shardCount };

  try {
    await citus.distribute(client, spec.table, spec.column, options);
    ctx.distributedUpToDate.add(spec.table);
    ctx.actions.push(
      action(
        'distributed',
        spec.table,
        'done',
        spec.colocateWith
          ? `distributed by ${spec.column} into the '${spec.colocateWith}' co-location group`
          : `distributed by ${spec.column} (new co-location group, ${citus.shardCount} shards)`
      )
    );
  } catch (err) {
    ctx.actions.push(action('distributed', spec.table, 'error', err.message));
  }
}

/** Whether a set of tables share exactly one co-location group. */
function checkColocation(topology, specs, label) {
  const missing = [];
  const ids = new Set();

  for (const spec of specs) {
    const view = tableView(topology, spec.table);
    if (view.kind !== 'distributed' || view.colocationId === null) missing.push(spec.table);
    else ids.add(view.colocationId);
  }

  if (missing.length > 0) {
    return { ok: false, detail: `not distributed: ${missing.join(', ')}` };
  }
  if (ids.size !== 1) {
    return {
      ok: false,
      detail: `split across colocation ids ${[...ids].join(', ')} — a ${label} transaction would need 2PC`
    };
  }
  return { ok: true, detail: `all ${specs.length} tables in colocation ${[...ids][0]}` };
}

/**
 * Turns each operator-requested worker target into its own check.
 *
 * `activeWorkers` counts what is registered, so a worker that was asked for and never made
 * it into `pg_dist_node` disappears into a smaller number rather than a failure — the
 * report would look healthy on a topology that does not match the request. `--verify` is
 * defined to exit 1 when the topology does not match the intent, and a requested node that
 * is absent from the catalog is exactly that, so the target is checked explicitly instead
 * of surviving only as a 'warn' action the exit code ignores. Presence, not liveness, is
 * the test here: a registered-but-inactive worker is still a worker the operator got into
 * the cluster, and the `citus.workers` check already reports the active-node count.
 */
function workerChecks(nodes, workerTargets) {
  return workerTargets.map((target) => {
    const node = nodes.find(
      (candidate) => candidate.nodename === target.host && candidate.nodeport === target.port
    );
    return {
      name: `worker.${target.label}`,
      ok: Boolean(node),
      detail: node
        ? `registered (group ${node.groupid}, ${node.isactive ? 'active' : 'inactive'}, role ${node.noderole})`
        : 'requested worker is not registered in pg_dist_node'
    };
  });
}

function buildChecks(topology, { activeWorkers, hasWorkers, nodes, workerTargets }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail) });

  add(
    'citus.workers',
    hasWorkers,
    hasWorkers ? `${activeWorkers} active primary node(s)` : 'no active primary nodes registered'
  );

  checks.push(...workerChecks(nodes, workerTargets));

  for (const table of REFERENCE_TABLES) {
    const view = tableView(topology, table);
    add(`reference.${table}`, view.kind === 'reference', view.kind === 'reference' ? 'reference table' : `is ${view.kind}`);
  }

  for (const spec of FLIGHT_TABLES) {
    const view = tableView(topology, spec.table);
    const ok = view.kind === 'distributed' && view.distributionColumn === spec.column;
    add(
      `distributed.${spec.table}`,
      ok,
      ok
        ? `by ${spec.column} (colocation ${view.colocationId})`
        : `is ${view.kind}${view.distributionColumn ? ` by ${view.distributionColumn}` : ''}`
    );
  }
  const flightGroup = checkColocation(topology, FLIGHT_TABLES, 'booking');
  add('colocation.flight_group', flightGroup.ok, flightGroup.detail);

  for (const spec of USER_TABLES) {
    const view = tableView(topology, spec.table);
    const ok = view.kind === 'distributed' && view.distributionColumn === spec.column;
    add(
      `distributed.${spec.table}`,
      ok,
      ok
        ? `by ${spec.column} (colocation ${view.colocationId})`
        : `is ${view.kind}${view.distributionColumn ? ` by ${view.distributionColumn}` : ''}`
    );
  }
  const userGroup = checkColocation(topology, USER_TABLES, 'per-user');
  add('colocation.user_group', userGroup.ok, userGroup.detail);

  // The runbook (docs/RUNBOOK.md section 4) requires the per-user tables to sit in a
  // colocation group *different* from the booking group. `checkColocation` alone cannot
  // see that: it only proves each set is internally one id, so flights, flight_inventory,
  // bookings, payments, booking_outbox, user_bookings and refresh_tokens can ALL share the
  // single default group (both anchors are `uuid` columns distributed with the same shard
  // count, which is exactly what Citus's default colocation joins) and both checks above
  // still pass. That shared id is the silent misdistribution: a `user_id` write would be
  // co-located onto the `flight_id` shards by the wrong key. Comparing the two id SETS is
  // therefore the real invariant.
  //
  // Guarded on `hasWorkers` because a cluster with no active workers is the supported
  // single-node configuration where nothing is distributed and one group is expected, not
  // a fault — the same `hasWorkers` distinction the `citus.workers` check uses. (This
  // branch is only reached once distribution is possible, so the guard also documents that
  // the check is a multi-node invariant rather than a single-node false alarm.)
  if (hasWorkers) {
    const flightIds = new Set(groupByColocation(topology, FLIGHT_TABLES).map((group) => group.colocationId));
    const userIds = new Set(groupByColocation(topology, USER_TABLES).map((group) => group.colocationId));
    const shared = [...userIds].filter((id) => flightIds.has(id));
    add(
      'colocation.distinct',
      shared.length === 0,
      shared.length === 0
        ? `per-user group ${[...userIds].join(', ')} differs from booking group ${[...flightIds].join(', ')}`
        : `per-user tables share colocation ${shared.join(', ')} with the booking group — a user_id write would 2PC across the booking shards`
    );
  }

  return checks;
}

/**
 * The whole run. Returns a report object whose `exitCode` the caller uses; it never
 * throws for an expected operational state — only for an unreachable database or a
 * genuinely unexpected error, which the top level turns into a clean failure.
 */
async function buildReport({ mode, workerTargets }) {
  const client = pool.writePool;

  const ctx = {
    mode,
    changeNothing: mode !== 'apply',
    actions: [],
    nodes: [],
    topology: { existing: new Set(), distributed: new Map() },
    distributedUpToDate: new Set()
  };

  const report = {
    generatedAt: new Date().toISOString(),
    nodeId: env.NODE_ID,
    mode,
    database: null,
    citus: {
      installed: false,
      available: false,
      version: null,
      activeWorkers: 0,
      shardCount: citus.shardCount
    },
    nodes: [],
    tables: [],
    groups: { flight: [], user: [] },
    actions: [],
    checks: [],
    changed: false,
    healthy: false,
    exitCode: 0,
    message: null
  };

  const capabilities = await pool.probeCapabilities(client);
  report.citus.installed = capabilities.citusInstalled;
  report.citus.available = capabilities.citusAvailable;

  try {
    const { rows } = await client.query('SELECT current_database() AS db');
    report.database = rows[0] ? rows[0].db : null;
  } catch (err) {
    report.database = null;
  }

  // ---- Degrade: no Citus at all --------------------------------------------
  if (!capabilities.citusInstalled) {
    if (!capabilities.citusAvailable) {
      // The production schema is identical either way; only the placement differs. This
      // is the local dev / CI configuration, so it is a pass, printed as such.
      report.message =
        'Citus is not available on this server — running as single-node PostgreSQL (supported). ' +
        'Tables are ordinary local tables; no distribution is applied.';
      report.checks.push({
        name: 'citus.single-node',
        ok: true,
        detail: 'citus extension not available on this server'
      });
      report.healthy = true;
      report.exitCode = 0;
    } else {
      report.message =
        'Citus is available on this server but not enabled in this database. Run `npm run db:setup` ' +
        '(or `CREATE EXTENSION citus`) and re-run.';
      report.checks.push({
        name: 'citus.extension',
        ok: false,
        detail: 'installed=false, available=true'
      });
      report.healthy = false;
      report.exitCode = 1;
    }
    return report;
  }

  report.citus.version = await citusVersion(client);

  // ---- Workers --------------------------------------------------------------
  let state = await citus.distributionState(client);
  ctx.nodes = await loadNodes(client);

  for (const target of workerTargets) {
    await ensureWorker(client, target, ctx);
  }

  // A worker added above changes whether the cluster can distribute at all, so the
  // capability has to be re-read rather than assumed.
  if (mode === 'apply' && workerTargets.length > 0) {
    state = await citus.distributionState(client);
    ctx.nodes = await loadNodes(client);
  }

  report.citus.activeWorkers = state.activeWorkers;
  report.nodes = ctx.nodes;

  // In a dry run the workers have not actually been added, but the tables that *would* be
  // distributed can still be planned — that is the whole point of a dry run.
  const planningAddsWorkers = mode === 'dry-run' && workerTargets.length > 0;
  const canDistribute = state.canDistribute || planningAddsWorkers;

  ctx.topology = await loadTopology(client);

  // ---- Degrade: Citus installed, but a single node ---------------------------
  if (!canDistribute) {
    report.tables = buildTableViews(ctx.topology);
    report.groups = buildGroups(ctx.topology);
    report.actions = ctx.actions;

    // A requested worker that failed to register (or, under --verify, is simply absent)
    // leaves `activeWorkers` at zero, so control lands here looking like an ordinary
    // single-node cluster. The reassuring single-node message and exit 0 are only honest
    // when nothing the operator asked for failed: an explicit `--add-worker` that threw is
    // a failure, and under --verify an unregistered requested node is a topology that does
    // not match the intent. Reporting either as the supported single-node result would
    // launder a real failure into success, contradicting the header's exit-1 contract.
    const missingWorkers = workerTargets.filter(
      (target) => !ctx.nodes.some((n) => n.nodename === target.host && n.nodeport === target.port)
    );
    const actionFailed = ctx.actions.some((entry) => entry.outcome === 'error');

    if (actionFailed || missingWorkers.length > 0) {
      report.checks.push({
        name: 'citus.workers',
        ok: false,
        detail: '0 active primary nodes — a requested worker is not registered'
      });
      report.checks.push(...workerChecks(ctx.nodes, workerTargets));
      report.healthy = false;
      report.exitCode = 1;
      report.message = actionFailed
        ? 'Worker registration failed (see the failed action above) — the cluster is still single-node.'
        : 'A requested worker is not registered (see the failed worker checks) — the topology does not match the intent.';
      return report;
    }

    report.message =
      'Citus is installed but no active primary worker nodes are registered — distributed tables ' +
      'stay local. This is a supported single-node configuration; add a worker with ' +
      '--add-worker <host:port> when you are ready to distribute.';
    report.checks.push({
      name: 'citus.workers',
      ok: true,
      detail: '0 active primary nodes — single-node (supported)'
    });
    report.healthy = true;
    report.exitCode = 0;
    return report;
  }

  // ---- Converge --------------------------------------------------------------
  if (mode !== 'verify') {
    for (const table of REFERENCE_TABLES) {
      await ensureReferenceTable(client, table, ctx);
    }
    for (const spec of FLIGHT_TABLES) {
      await ensureDistributed(client, spec, ctx);
    }
    for (const spec of USER_TABLES) {
      await ensureDistributed(client, spec, ctx);
    }
  }

  // Re-read after any DDL so the report and the checks describe the cluster as it is now,
  // not as it was believed to be before the run.
  if (mode === 'apply' && ctx.actions.some((entry) => entry.outcome === 'done')) {
    ctx.topology = await loadTopology(client);
  }

  report.actions = ctx.actions;
  report.tables = buildTableViews(ctx.topology);
  report.groups = buildGroups(ctx.topology);
  report.changed = ctx.actions.some((entry) => entry.outcome === 'done');

  if (mode === 'dry-run') {
    report.healthy = true;
    report.exitCode = 0;
    report.message = 'Dry run — no changes were made. Planned actions are listed above.';
    return report;
  }

  report.checks = buildChecks(ctx.topology, {
    activeWorkers: state.activeWorkers,
    hasWorkers: state.activeWorkers > 0,
    nodes: ctx.nodes,
    workerTargets
  });

  const hadError = ctx.actions.some((entry) => entry.outcome === 'error');
  report.healthy = report.checks.every((check) => check.ok) && !hadError;
  report.exitCode = report.healthy ? 0 : 1;
  report.message = report.healthy
    ? report.changed
      ? 'Topology converged.'
      : 'Topology already configured — no changes made.'
    : 'Topology does not match the intended configuration (see the failed checks).';

  return report;
}

function renderHuman(report) {
  const lines = [];
  const push = (line = '') => lines.push(line);

  push('=== Citus topology - scripts/citus-init.js ===');
  push(
    `generated ${report.generatedAt}   node ${report.nodeId}   db ${report.database || '?'}   mode ${report.mode}`
  );
  push('');

  push('Citus');
  if (!report.citus.installed) {
    push(`  installed=no   available=${report.citus.available ? 'yes' : 'no'}   shardCount=${report.citus.shardCount}`);
  } else {
    push(
      `  citus ${report.citus.version || '?'}   installed=yes   activeNodes=${report.citus.activeWorkers}` +
        `   shardCount=${report.citus.shardCount}`
    );
    if (report.nodes.length === 0) {
      push('  no nodes registered');
    } else {
      for (const node of report.nodes) {
        const role = node.groupid === 0 ? 'coordinator' : node.noderole;
        push(
          `  node ${pad(`${node.nodename}:${node.nodeport}`, 24)} group=${pad(node.groupid, 3)}` +
            ` role=${pad(role, 12)} ${node.isactive ? 'ACTIVE' : 'INACTIVE'}`
        );
      }
    }
  }
  push('');

  if (report.tables.length > 0) {
    push('Tables');
    push(`  ${pad('TABLE', 22)} ${pad('KIND', 12)} ${pad('DIST COLUMN', 14)} COLOCATION`);
    for (const table of report.tables) {
      push(
        `  ${pad(table.name, 22)} ${pad(table.kind, 12)}` +
          ` ${pad(table.distributionColumn || '-', 14)} ${table.colocationId === null ? '-' : table.colocationId}`
      );
    }
    push('');
  }

  if (report.groups.flight.length > 0 || report.groups.user.length > 0) {
    push('Co-location groups');
    for (const [label, groups] of [
      ['flight', report.groups.flight],
      ['user', report.groups.user]
    ]) {
      if (groups.length === 0) {
        push(`  ${pad(label, 8)} (none)`);
        continue;
      }
      for (const group of groups) {
        push(`  ${pad(label, 8)} colocation ${pad(group.colocationId, 4)}: ${group.tables.join(', ')}`);
      }
    }
    push('');
  }

  if (report.actions.length > 0) {
    push('Actions');
    for (const entry of report.actions) {
      push(
        `  ${pad(OUTCOME_LABELS[entry.outcome] || entry.outcome, 9)}` +
          ` ${pad(entry.kind, 12)} ${pad(entry.target, 22)} ${entry.message}`
      );
    }
    push('');
  }

  if (report.checks.length > 0) {
    push('Checks');
    for (const check of report.checks) {
      push(`  ${check.ok ? 'OK  ' : 'FAIL'} ${pad(check.name, 30)} ${check.detail}`);
    }
    push('');
  }

  push(`RESULT: ${report.message || (report.exitCode === 0 ? 'ok' : 'failed')}`);
  return lines.join('\n');
}

function output(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderHuman(report)}\n`);
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n${USAGE}`);
    return 2;
  }

  let workerTargets;
  try {
    workerTargets =
      args.addWorkers.length > 0
        ? args.addWorkers.map(parseWorkerTarget)
        : env.CITUS_WORKER_HOSTS.map(parseWorkerTarget);
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    return 2;
  }

  // --verify is the stricter, read-only mode; it wins when both are given.
  const mode = args.verify ? 'verify' : args.dryRun ? 'dry-run' : 'apply';

  const report = await buildReport({ mode, workerTargets });
  output(report, args.json);
  return report.exitCode;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`citus-init failed: ${err.message}\n`);
    if (process.env.DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Reached on success, failure and early return alike: an operator script must never
    // leave an idle pooled connection holding the process open.
    await pool.close();
  });
