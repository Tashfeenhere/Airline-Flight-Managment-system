/**
 * Constraint-name resolution for partitioned tables.
 *
 * A unique index declared on a partitioned table is inherited by every partition, and
 * PostgreSQL generates the child index names itself:
 *
 *     CREATE UNIQUE INDEX uq_live_seat ON bookings (...)
 *       -> bookings_p202611_flight_id_departure_date_seat_number_idx
 *       -> bookings_p202612_flight_id_departure_date_seat_number_idx
 *
 * When a row violates the constraint, the error names the CHILD index — the name the
 * application chose appears nowhere in it. So `err.constraint === 'uq_live_seat'` is
 * false on every partitioned table, which is all of them here, and any code that maps
 * SQLSTATE 23505 to a business error by index name silently stops working.
 *
 * The fix is to ask the catalog: `pg_inherits` records which index is the child of
 * which. Resolving through it means the same code works whether the table is
 * partitioned (child name), distributed (Citus names children similarly), or plain
 * (identity mapping).
 *
 * Two independent mechanisms, because the catalog lookup can fail for reasons that have
 * nothing to do with the bug being diagnosed — restricted permissions on pg_catalog in a
 * locked-down deployment, a connection that is already dead when the error is being
 * classified. When the lookup misses, the error's `detail` field is matched on column
 * names instead. `detail` is localized by `lc_messages`, which is why it is the
 * fallback and not the primary: under a non-English locale it will not match, and the
 * primary path must be the one that always works.
 */
const logger = require('../utils/logger');

/** child index name -> parent index name. Grows as new monthly partitions appear. */
const childToParent = new Map();

/** Parent indexes that are not partitioned indexes still map to themselves. */
const identity = new Map();

let lastLoadedAt = 0;
const RELOAD_INTERVAL_MS = 60_000;

/**
 * Reads the index inheritance tree.
 *
 * Scoped to indexes, not constraints, because that is what the error reports. A
 * partitioned index has no rows in `pg_constraint` unless it is backing a constraint,
 * and partial unique indexes (which is what makes a seat unique only while the booking
 * is live) are not constraints at all — they are raw indexes.
 */
async function loadIndexLineage(client) {
  const { rows } = await client.query(`
    SELECT child.relname  AS child_index,
           parent.relname AS parent_index
      FROM pg_inherits i
      JOIN pg_class child  ON child.oid  = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
     WHERE child.relkind  = 'i'
       AND parent.relkind = 'i'
  `);

  childToParent.clear();
  for (const row of rows) childToParent.set(row.child_index, row.parent_index);

  // Every partitioned parent maps to itself, so a violation reported with the parent's
  // own name (which happens when the insert targets the parent directly) resolves too.
  const { rows: parents } = await client.query(`
    SELECT c.relname AS name
      FROM pg_class c
     WHERE c.relkind = 'i' AND c.relispartition = false
  `);
  identity.clear();
  for (const row of parents) identity.set(row.name, row.name);

  lastLoadedAt = Date.now();
  return childToParent.size;
}

/**
 * Maps a reported index name to the name the application knows it by.
 *
 * @returns {Promise<string|null>} the parent index name, or null if unknown.
 */
async function resolveIndexName(client, reportedName) {
  if (!reportedName) return null;

  if (childToParent.has(reportedName)) return childToParent.get(reportedName);
  if (identity.has(reportedName)) return identity.get(reportedName);

  // A miss is expected the first time and whenever a new month's partition is created
  // while the process is running — the lineage map was built before that partition
  // existed. Reloading on a miss (rate-limited so a burst of violations cannot turn into
  // a burst of catalog scans) makes it self-healing rather than requiring a restart.
  if (Date.now() - lastLoadedAt > RELOAD_INTERVAL_MS) {
    try {
      await loadIndexLineage(client);
      if (childToParent.has(reportedName)) return childToParent.get(reportedName);
      if (identity.has(reportedName)) return identity.get(reportedName);
    } catch (err) {
      logger.warn('Could not refresh index lineage', { error: err.message });
    }
  }

  return null;
}

/**
 * Column signatures, as they appear in a unique violation's `detail` text:
 *
 *   Key (flight_id, departure_date, seat_number)=(…) already exists.
 *
 * Ordered most-specific first, because `booking_reference` and `booking_id` both appear
 * in indexes on `bookings` and the distinguishing token is the full column name.
 */
const DETAIL_SIGNATURES = Object.freeze([
  { tokens: ['seat_number'], constraint: 'uq_live_seat' },
  { tokens: ['idempotency_key'], constraint: 'uq_booking_idempotency' },
  { tokens: ['booking_reference'], constraint: 'uq_booking_reference' },
  { tokens: ['email'], constraint: 'uq_users_email' },
  { tokens: ['flight_id', 'departure_date', 'booking_id'], constraint: 'bookings_pkey' }
]);

/** Best-effort classification from the error's `detail` text (locale-dependent). */
function classifyFromDetail(detail) {
  if (!detail || typeof detail !== 'string') return null;
  const haystack = detail.toLowerCase();
  for (const signature of DETAIL_SIGNATURES) {
    if (signature.tokens.every((token) => haystack.includes(token))) return signature.constraint;
  }
  return null;
}

/**
 * Classifies a SQLSTATE 23505.
 *
 * @returns {Promise<{ constraint: string|null, via: 'catalog'|'detail'|'unresolved' }>}
 *   `constraint` is the application-level index name, or null when neither mechanism
 *   could identify it — which the caller must treat as "unknown conflict", never as
 *   "no conflict".
 */
async function classifyUniqueViolation(client, err) {
  if (!err || err.code !== '23505') return { constraint: null, via: 'unresolved' };

  if (client) {
    try {
      const resolved = await resolveIndexName(client, err.constraint);
      if (resolved) return { constraint: resolved, via: 'catalog' };
    } catch (err2) {
      logger.warn('Index name resolution failed', { error: err2.message, reported: err.constraint });
    }
  }

  const fromDetail = classifyFromDetail(err.detail);
  if (fromDetail) return { constraint: fromDetail, via: 'detail' };

  return { constraint: null, via: 'unresolved' };
}

/** Test seam: forces the next resolve to rebuild the lineage map. */
function resetIndexLineage() {
  childToParent.clear();
  identity.clear();
  lastLoadedAt = 0;
}

module.exports = {
  loadIndexLineage,
  resolveIndexName,
  classifyUniqueViolation,
  classifyFromDetail,
  resetIndexLineage,
  DETAIL_SIGNATURES
};
