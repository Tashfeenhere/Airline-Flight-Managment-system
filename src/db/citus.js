/**
 * Citus topology helpers.
 *
 * The application never hand-routes shards — Citus routes each statement from the
 * distribution column. These helpers exist so *migrations* can adapt to whatever
 * cluster they are applied to:
 *
 *   - Citus installed and at least one active worker registered -> distribute the
 *     big tables and replicate the small ones (production topology).
 *   - Otherwise (vanilla PostgreSQL 18 for local dev/CI) -> create the same tables
 *     as ordinary local tables and skip the distribution step.
 *
 * The schema is identical either way; only the placement differs. That is what
 * lets the test suite run without Docker while production runs distributed.
 */
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Introspects the cluster once per call site. Cheap enough to run during
 * migrations, where correctness matters more than a round trip.
 *
 * The Citus catalog tables are queried only when the extension is actually
 * installed: PostgreSQL plans the whole statement even for an untaken CASE branch,
 * so referencing `pg_dist_node` unconditionally fails on vanilla PostgreSQL.
 */
async function distributionState(client) {
  const installed = await client.query(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citus') AS ok"
  );

  const citusInstalled = Boolean(installed.rows[0]?.ok);
  let activeWorkers = 0;

  if (citusInstalled) {
    const workers = await client.query(
      "SELECT count(*)::int AS n FROM pg_dist_node WHERE isactive AND noderole = 'primary'"
    );
    activeWorkers = Number(workers.rows[0]?.n || 0);
  }

  return {
    citusInstalled,
    activeWorkers,
    canDistribute: citusInstalled && activeWorkers > 0
  };
}

/**
 * Distributes a table by `distributionColumn`.
 *
 * `colocateWith` is what makes the booking path a single-worker transaction: every
 * table in the same co-location group places rows with the same distribution value
 * on the same shard, so a booking touches exactly one worker and commits with a
 * plain local transaction — no two-phase commit.
 */
async function distribute(client, table, distributionColumn, options = {}) {
  const state = await distributionState(client);
  if (!state.canDistribute) {
    logger.info(
      `Skipping distribution of '${table}' — Citus not active ` +
        `(installed=${state.citusInstalled}, activeWorkers=${state.activeWorkers}); ` +
        'table remains a local table.'
    );
    return { distributed: false, reason: 'citus-unavailable' };
  }

  const args = [`'${table}'`, `'${distributionColumn}'`];
  if (options.colocateWith) {
    args.push(`colocate_with => '${options.colocateWith}'`);
  } else if (options.shardCount) {
    args.push(`shard_count => ${options.shardCount}`);
  }

  await client.query(`SELECT create_distributed_table(${args.join(', ')});`);
  logger.info(`Distributed '${table}' by '${distributionColumn}'`, {
    colocateWith: options.colocateWith || null
  });
  return { distributed: true };
}

/** Replicates a small table to every worker so joins stay local. */
async function makeReference(client, table) {
  const state = await distributionState(client);
  if (!state.canDistribute) {
    return { reference: false, reason: 'citus-unavailable' };
  }
  await client.query(`SELECT create_reference_table('${table}');`);
  logger.info(`Created reference table '${table}'`);
  return { reference: true };
}

/**
 * Citus restricts how much of the cluster a single DDL/DML statement may touch.
 * `citus.max_intermediate_result_size` and friends are cluster-level; this reports
 * the placement topology for `npm run db:status`.
 */
async function describeTopology(client) {
  const state = await distributionState(client);
  if (!state.citusInstalled) {
    return { citus: false, ...state };
  }

  const [nodes, tables, shards] = await Promise.all([
    client.query('SELECT nodename, nodeport, noderole, isactive FROM pg_dist_node ORDER BY nodeid'),
    client.query(`
      SELECT logicalrelid::text AS table_name,
             partmethod,
             colocationid,
             CASE WHEN partkey IS NULL THEN NULL ELSE NULL END AS unused
        FROM pg_dist_partition
       ORDER BY logicalrelid::text
    `),
    client.query('SELECT count(*)::int AS shard_count FROM pg_dist_shard')
  ]);

  return {
    citus: true,
    ...state,
    nodes: nodes.rows,
    distributedTables: tables.rows,
    shardCount: shards.rows[0]?.shard_count ?? 0
  };
}

/** Shard placement map: which worker holds how many shards of a given table. */
async function shardPlacement(client, table) {
  const state = await distributionState(client);
  if (!state.citusInstalled) return [];

  const { rows } = await client.query(
    `SELECT nodename, nodeport, count(*)::int AS shards
       FROM citus_shards
      WHERE table_name = $1::regclass
      GROUP BY nodename, nodeport
      ORDER BY nodename`,
    [table]
  );
  return rows;
}

/** Citus stores the partition method as a single character. */
const PARTITION_METHOD = Object.freeze({ h: 'hash', a: 'append', r: 'range', n: 'single' });

/** Per-table shard listing is capped so a topology call cannot return megabytes. */
const SHARDS_PER_TABLE_LIMIT = 100;

/**
 * The full topology report behind `GET /api/admin/topology`.
 *
 * Assembled here rather than in the controller because every field is a fact about
 * this cluster's catalogs, and the mapping from `pg_dist_partition.partmethod` to a
 * human strategy name (or from `pg_dist_node.groupid = 0` to "the coordinator") is
 * knowledge about Citus, not about HTTP.
 *
 * The undistributed branch is not a degraded placeholder. A single PostgreSQL server
 * running this schema IS a valid deployment — the tests and CI use exactly that — and
 * the honest description of it is a one-node cluster whose tables are local, which is
 * what Citus itself calls the `single` strategy. Returning an empty object would make
 * the endpoint useless in the environment where it is most likely to be called.
 */
async function topologyReport(client) {
  const state = await distributionState(client);

  const local = await client.query(
    `SELECT COALESCE(inet_server_addr()::text, 'localhost') AS host,
            COALESCE(inet_server_port(), 5432)::int       AS port`
  );
  const localNode = local.rows[0] || { host: 'localhost', port: 5432 };

  if (!state.citusInstalled) {
    return {
      coordinator: { nodeId: 1, host: localNode.host, port: localNode.port, isActive: true, role: 'primary' },
      workers: [],
      shards: [],
      distribution: { strategy: 'single', shardCount: 0, colocationGroups: 0 },
      citus: false,
      generatedAt: new Date().toISOString()
    };
  }

  const [nodes, tables, shardRows] = await Promise.all([
    client.query(
      `SELECT nodeid, groupid, nodename, nodeport, noderole, isactive
         FROM pg_dist_node
        ORDER BY groupid, nodeid`
    ),
    client.query(
      `SELECT logicalrelid::text AS table_name, partmethod, colocationid
         FROM pg_dist_partition
        ORDER BY logicalrelid::text`
    ),
    client.query(
      `SELECT t.relname          AS table_name,
              s.shardid          AS shard_id,
              s.shardminvalue    AS shard_min_value,
              s.shardmaxvalue    AS shard_max_value,
              n.nodeid           AS node_id
         FROM pg_dist_shard s
         JOIN pg_dist_placement p ON p.shardid = s.shardid
         JOIN pg_dist_node n      ON n.groupid = p.groupid
         JOIN pg_class t          ON t.oid = s.logicalrelid
        ORDER BY t.relname, s.shardid`
    )
  ]);

  const coordinatorRow = nodes.rows.find((row) => Number(row.groupid) === 0);
  const coordinator = coordinatorRow
    ? {
        nodeId: Number(coordinatorRow.nodeid),
        host: coordinatorRow.nodename,
        port: Number(coordinatorRow.nodeport),
        isActive: Boolean(coordinatorRow.isactive),
        role: coordinatorRow.noderole === 'secondary' ? 'secondary' : 'primary'
      }
    : { nodeId: 1, host: localNode.host, port: localNode.port, isActive: true, role: 'primary' };

  const workers = nodes.rows
    .filter((row) => Number(row.groupid) !== 0)
    .map((row) => ({
      nodeId: Number(row.nodeid),
      groupId: Number(row.groupid),
      host: row.nodename,
      port: Number(row.nodeport),
      isActive: Boolean(row.isactive),
      // Derived from `noderole` rather than read from `pg_dist_node.isprimary`:
      // `noderole` has been in the catalog since Citus 9.5 and says the same thing, so
      // the query keeps working on an older cluster instead of failing on a missing
      // column.
      isPrimary: row.noderole === 'primary'
    }));

  const perTable = new Map();
  let truncated = false;
  for (const row of shardRows.rows) {
    const list = perTable.get(row.table_name) || [];
    if (list.length >= SHARDS_PER_TABLE_LIMIT) {
      truncated = true;
      continue;
    }
    list.push({
      table: row.table_name,
      shardId: Number(row.shard_id),
      shardName: `${row.table_name}_${row.shard_id}`,
      nodeId: Number(row.node_id),
      shardMinValue: row.shard_min_value,
      shardMaxValue: row.shard_max_value
    });
    perTable.set(row.table_name, list);
  }

  const colocationGroups = new Set(tables.rows.map((row) => row.colocationid)).size;
  const strategies = new Set(tables.rows.map((row) => PARTITION_METHOD[row.partmethod] || 'single'));
  // Distinct shard ids, not placement rows: a replicated shard has one placement per
  // replica, and "shard count" means shards.
  const shardCount = new Set(shardRows.rows.map((row) => Number(row.shard_id))).size;

  return {
    coordinator,
    workers,
    shards: [...perTable.values()].flat(),
    distribution: {
      // One strategy per cluster in every layout this application supports; when the
      // tables somehow disagree, 'single' is the truthful summary because that is what
      // an unmapped partmethod means.
      strategy: strategies.size === 1 ? [...strategies][0] : 'single',
      shardCount,
      colocationGroups
    },
    citus: true,
    activeWorkers: state.activeWorkers,
    ...(truncated ? { shardsTruncated: true, shardsPerTableLimit: SHARDS_PER_TABLE_LIMIT } : {}),
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  distributionState,
  distribute,
  makeReference,
  describeTopology,
  topologyReport,
  shardPlacement,
  shardCount: env.CITUS_SHARD_COUNT
};
