/**
 * Monthly partition maintenance.
 *
 * `bookings`, `payments`, `flights`, `flight_inventory` and `booking_outbox` are RANGE
 * partitioned by month, and `flight_availability` matches on the read side. Partitions
 * are not an optimization to be applied later: a booking writes into the partition its
 * `departure_date` falls in, and if that partition does not exist the INSERT fails. The
 * horizon is therefore a hard precondition of selling a seat, which is why it is rolled
 * forward on a schedule rather than left to whoever remembers.
 *
 * The DDL itself lives in the database as `app_ensure_month_partitions()` and
 * `app_drop_partitions_older_than()` (migration 001). That is deliberate: the function
 * that creates a partition must be the same one the migration and the bulk loader use,
 * or the naming convention drifts — and `app_drop_partitions_older_than` finds
 * partitions by name pattern, so a drifted name means retention silently stops
 * matching anything and the cluster grows forever.
 *
 * Two operational rules are enforced here rather than left to the caller:
 *
 *   - The whole pass runs under an advisory lock. Creating the same partition from two
 *     sessions is a race DDL cannot lose gracefully, and a cron tick overlapping a human
 *     running the same command is the ordinary way that happens.
 *   - A DROP is refused for a partition that still holds rows unless `force` is set. A
 *     retention policy that quietly deletes a month of live bookings is not a retention
 *     policy, and `mode: 'detach'` exists for when the data must be archived first.
 *
 * Nothing here opens a transaction. Citus rejects DDL inside a distributed transaction,
 * and each `CREATE TABLE ... PARTITION OF` is its own autocommitted statement — the same
 * reason migration 007 is marked `transactional: false`.
 */
const pool = require('./pool');
const env = require('../config/env');
const logger = require('../utils/logger');
const errors = require('../utils/errors');
const { withAdvisoryLock } = require('./locks');

/** Parents in the write model, partitioned by `departure_date`. */
const WRITE_PARENTS = Object.freeze([
  'flights',
  'flight_inventory',
  'bookings',
  'payments',
  'booking_outbox'
]);

/** Parents in the read model. Same months, different database. */
const READ_PARENTS = Object.freeze(['flight_availability']);

const LOCK_NAME = 'partition-maintenance';

/**
 * Matches the suffix `app_ensure_month_partitions` generates: `<parent>_pYYYYMM`.
 *
 * The six digits are captured as ONE group because `parseMonthSuffix` expects that
 * exact shape. Capturing year and month separately (the earlier form) made this
 * regex hand `parseMonthSuffix('2026')` its year, which parsed as month 0 and
 * returned null — so every partition was invisible to discovery, gap detection and
 * retention while direct catalog queries still showed them.
 */
const PARTITION_NAME_RE = /_p(\d{6})$/;

/**
 * @param {'all'|'write'|'read'} target
 * @returns {{ write: string[], read: string[] }}
 */
function parentsFor(target = 'all') {
  if (target === 'write') return { write: [...WRITE_PARENTS], read: [] };
  if (target === 'read') return { write: [], read: [...READ_PARENTS] };
  if (target === 'all') return { write: [...WRITE_PARENTS], read: [...READ_PARENTS] };
  throw new errors.ValidationError(`Unknown partition target: ${target}`, { target });
}

/** First instant of `monthOffset` months from `from`, in UTC. */
function shiftMonth(from, monthOffset) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + monthOffset, 1));
}

/** `2026-11-01T00:00:00Z` -> `202611`. */
function monthSuffix(date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}${month}`;
}

/** `202611` -> a Date at the first of that month, or null when unparseable. */
function parseMonthSuffix(suffix) {
  const year = Number(suffix.slice(0, 4));
  const month = Number(suffix.slice(4, 6));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

function partitionNameFor(parent, date) {
  return `${parent}_p${monthSuffix(date)}`;
}

/** `2026-11`, which is how an operator thinks about a horizon. */
function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Sums the non-null values, or null when every one of them is null. */
function sumOrNull(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

/**
 * Every partition the ensure window covers, whether or not it already exists.
 *
 * `app_ensure_month_partitions` returns only a count, which is enough to report but not
 * enough to dry-run — and "what will this actually do?" is the question an operator asks
 * before pointing a retention policy at production. Both derive the window and the name
 * the same way, so the plan and the execution cannot disagree about which months are
 * meant.
 */
function planWindow({ parents, monthsBehind, monthsAhead, now = new Date() }) {
  const firstMonth = shiftMonth(now, -monthsBehind);
  const planned = [];

  for (const parent of parents) {
    for (let offset = 0; offset <= monthsBehind + monthsAhead; offset += 1) {
      const start = shiftMonth(firstMonth, offset);
      planned.push({
        parent,
        name: partitionNameFor(parent, start),
        month: monthKey(start),
        from: start.toISOString().slice(0, 10),
        to: shiftMonth(start, 1).toISOString().slice(0, 10)
      });
    }
  }

  return planned;
}

/**
 * Existing partitions for one parent, oldest first.
 *
 * Read from `pg_inherits` rather than `pg_class WHERE relname LIKE 'parent_p%'`: a
 * `LIKE` match is how a hand-created archive table ends up dropped by someone else's
 * retention job.
 */
async function listPartitions(client, parent) {
  const { rows } = await client.query(
    `SELECT c.relname AS name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1
      ORDER BY c.relname`,
    [parent]
  );

  return rows
    .map((row) => {
      const match = PARTITION_NAME_RE.exec(row.name);
      const month = match ? parseMonthSuffix(match[1]) : null;
      return { parent, name: row.name, month: month ? monthKey(month) : null, start: month };
    })
    .filter((row) => row.start !== null)
    .sort((a, b) => a.start - b.start);
}

/** Existing partitions for several parents, as one list plus a `parent|name` set. */
async function listAll(client, parents) {
  const rows = [];
  for (const parent of parents) {
    rows.push(...(await listPartitions(client, parent)));
  }
  return { rows, names: new Set(rows.map((row) => `${row.parent}|${row.name}`)) };
}

/** The window minus what already exists — what a real run would create. */
async function planMissing(client, { parents, monthsBehind, monthsAhead, now = new Date() }) {
  const { names } = await listAll(client, parents);
  return planWindow({ parents, monthsBehind, monthsAhead, now }).filter(
    (entry) => !names.has(`${entry.parent}|${entry.name}`)
  );
}

/**
 * Which months are covered per parent, and where the gaps are.
 *
 * A gap is worse than a short horizon: it means a flight on that date cannot be sold at
 * all, and the failure surfaces only when someone tries. So coverage is reported as a
 * contiguous range plus the months missing inside it, not just the endpoints.
 */
async function partitionHorizon(client, parents) {
  const horizon = {};

  for (const parent of parents) {
    const partitions = await listPartitions(client, parent);
    const months = new Set(partitions.map((row) => row.month));
    const missing = [];

    if (partitions.length > 0) {
      const first = partitions[0].start;
      const last = partitions[partitions.length - 1].start;
      for (let cursor = first; cursor <= last; cursor = shiftMonth(cursor, 1)) {
        if (!months.has(monthKey(cursor))) missing.push(monthKey(cursor));
      }
    }

    horizon[parent] = {
      count: partitions.length,
      earliest: partitions[0] ? partitions[0].month : null,
      latest: partitions.length > 0 ? partitions[partitions.length - 1].month : null,
      missing,
      partitions: partitions.map((row) => row.name)
    };
  }

  return horizon;
}

/** Creates the partitions the window calls for, via the SQL helper. */
async function ensurePartitions(client, { parents, monthsBehind, monthsAhead }) {
  const created = [];

  for (const parent of parents) {
    const { rows } = await client.query(
      'SELECT app_ensure_month_partitions($1, $2, $3) AS created',
      [parent, monthsBehind, monthsAhead]
    );
    const count = Number(rows[0] ? rows[0].created : 0);
    created.push({ parent, created: count });

    if (count > 0) {
      logger.info('Created monthly partitions', { parent, created: count, monthsBehind, monthsAhead });
    }
  }

  return created;
}

/** Rows in one partition, used to decide whether a DROP is allowed. */
async function countRows(client, partitionName) {
  // The name comes from `listPartitions` (a pg_catalog read), never from user input, and
  // it is quoted as an identifier so a name cannot smuggle in SQL.
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${partitionName}"`);
  return Number(rows[0] ? rows[0].n : 0);
}

/**
 * Applies retention to one database's parents.
 *
 * The row-count guard is checked before each drop, never after: `DROP TABLE` is not
 * reversible, and the whole difference between "retention is working" and "retention
 * just deleted a month of live bookings" is whether the table was still being written
 * to. A blocked partition is reported rather than silently kept, so a retention policy
 * that never fires is visible instead of looking like a policy that works.
 */
async function dropPartitions(client, { parents, retentionMonths, force = false, mode = 'drop', dryRun = false, now = new Date() }) {
  if (mode !== 'drop' && mode !== 'detach') {
    throw new errors.ValidationError('mode must be "drop" or "detach"', { mode });
  }

  const cutoff = shiftMonth(now, -retentionMonths);
  const dropped = [];
  const blocked = [];

  for (const parent of parents) {
    const partitions = await listPartitions(client, parent);

    for (const partition of partitions) {
      if (partition.start >= cutoff) continue;

      if (!force) {
        const rows = await countRows(client, partition.name);
        if (rows > 0) {
          blocked.push({ parent, name: partition.name, month: partition.month, rows });
          continue;
        }
      }

      if (!dryRun) {
        if (mode === 'detach') {
          await client.query(`ALTER TABLE "${parent}" DETACH PARTITION "${partition.name}"`);
        } else {
          await client.query(`DROP TABLE "${partition.name}"`);
        }
        logger.warn(`Retention ${mode}ped partition`, {
          parent,
          partition: partition.name,
          month: partition.month,
          forced: force
        });
      }

      dropped.push({ parent, name: partition.name, month: partition.month, mode });
    }
  }

  return { dropped, blocked, cutoff: cutoff.toISOString().slice(0, 10) };
}

/**
 * Runs the whole pass against one database's parents.
 *
 * A dedicated connection is held for the duration so the pass does not interleave with
 * requests on the shared pool — DDL and partition creation are the last things that
 * should queue behind, or ahead of, somebody's booking.
 */
async function maintainOne({ database, parents, monthsBehind, monthsAhead, retentionMonths, force, mode, dryRun, now }) {
  const client = await database.connect();

  try {
    // The window is computed before the DDL in both modes, not just for a dry run.
    // The SQL helper returns a count, and a count cannot be checked against the names
    // this module predicts — which is the only way to notice that
    // `app_ensure_month_partitions` has started creating partitions under names the
    // retention planner will never match. Naming them here turns that silent drift
    // into a visible mismatch.
    const planned = await planMissing(client, { parents, monthsBehind, monthsAhead, now });
    const ensured = planned.map((entry) => ({
      parent: entry.parent,
      name: entry.name,
      month: entry.month,
      planned: dryRun
    }));

    let createdCount = null;
    if (!dryRun) {
      const counts = await ensurePartitions(client, { parents, monthsBehind, monthsAhead });
      createdCount = counts.reduce((total, entry) => total + entry.created, 0);

      if (createdCount !== planned.length) {
        logger.warn('Partition creation count does not match the planned window', {
          planned: planned.length,
          created: createdCount,
          parents
        });
      }
    }

    const horizon = await partitionHorizon(client, parents);

    if (retentionMonths === null || retentionMonths === undefined) {
      return { ensured, createdCount, plannedCount: planned.length, dropped: [], blocked: [], cutoff: null, horizon };
    }

    const retention = await dropPartitions(client, {
      parents,
      retentionMonths,
      force,
      mode,
      dryRun,
      now
    });

    return { ensured, createdCount, plannedCount: planned.length, ...retention, horizon };
  } finally {
    client.release();
  }
}

/**
 * One maintenance pass: roll the horizon forward, then apply retention.
 *
 * Returns a description of everything it did — or would do, under `dryRun` — so the CLI
 * and the admin endpoint report the same facts and a dry run can be diffed against the
 * real thing.
 *
 * A pass that finds the lock already held returns `{ skipped: true }` rather than
 * throwing: losing to a concurrent cron is normal, and an operator does not need a
 * stack trace to be told so.
 */
async function maintain({
  monthsAhead = env.PARTITION_MONTHS_AHEAD,
  monthsBehind = env.PARTITION_MONTHS_BEHIND,
  retentionMonths = null,
  target = 'all',
  dryRun = false,
  force = false,
  mode = 'drop',
  lockWait = false,
  now = new Date()
} = {}) {
  const parents = parentsFor(target);

  const run = async () => {
    const write = parents.write.length > 0
      ? await maintainOne({
          database: pool.writePool,
          parents: parents.write,
          monthsBehind,
          monthsAhead,
          retentionMonths,
          force,
          mode,
          dryRun,
          now
        })
      : null;

    const read = parents.read.length > 0
      ? await maintainOne({
          database: pool.readPool,
          parents: parents.read,
          monthsBehind,
          monthsAhead,
          retentionMonths,
          force,
          mode,
          dryRun,
          now
        })
      : null;

    return {
      dryRun,
      target,
      monthsBehind,
      monthsAhead,
      retentionMonths: retentionMonths === undefined ? null : retentionMonths,
      retentionCutoff: (write && write.cutoff) || (read && read.cutoff) || null,
      ensured: [...((write && write.ensured) || []), ...((read && read.ensured) || [])],
      // Null means "not applicable in this mode" (a dry run creates nothing), which is
      // different from zero.
      createdCount: sumOrNull([write && write.createdCount, read && read.createdCount]),
      plannedCount: ((write && write.plannedCount) || 0) + ((read && read.plannedCount) || 0),
      dropped: [...((write && write.dropped) || []), ...((read && read.dropped) || [])],
      blocked: [...((write && write.blocked) || []), ...((read && read.blocked) || [])],
      horizon: { ...((write && write.horizon) || {}), ...((read && read.horizon) || {}) },
      generatedAt: new Date().toISOString()
    };
  };

  // The lock is taken even for a dry run: a plan computed while another maintenance pass
  // is mid-flight describes a state that is already changing underneath it.
  const outcome = await withAdvisoryLock(LOCK_NAME, run, { wait: lockWait });
  if (!outcome.acquired) {
    return {
      skipped: true,
      reason: outcome.reason,
      message: 'Another partition maintenance pass is running; nothing was changed.',
      generatedAt: new Date().toISOString()
    };
  }

  return outcome.result;
}

module.exports = {
  WRITE_PARENTS,
  READ_PARENTS,
  LOCK_NAME,
  parentsFor,
  planWindow,
  listPartitions,
  planMissing,
  partitionHorizon,
  ensurePartitions,
  countRows,
  dropPartitions,
  maintain,
  monthKey,
  monthSuffix,
  partitionNameFor,
  shiftMonth
};
