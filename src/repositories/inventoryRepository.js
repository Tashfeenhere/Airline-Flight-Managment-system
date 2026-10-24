/**
 * Inventory repository (write model) — the single place that decides whether a seat
 * can be sold.
 *
 * The design is a *counter per (flight, cabin)*, not a row per seat: at 50M flights
 * a seat-per-row model would be ~10 billion rows, and every booking would have to
 * find one specific free row. Instead `available_seats` is decremented under a row
 * lock, and the physical seat only materializes on the booking that holds it.
 *
 * THE INVARIANT — anti-oversell is this one statement, and nothing else:
 *
 *     UPDATE flight_inventory
 *        SET available_seats = available_seats - $n
 *      WHERE … AND available_seats >= $n
 *
 * PostgreSQL takes a row lock for the update and re-evaluates the predicate after
 * winning it, so two concurrent buyers of the last seat serialize: the first sees
 * `available_seats >= 1` and decrements, the second re-reads the *new* value, fails
 * the predicate, and updates zero rows. There is no read-then-write window to lose a
 * race in, which is why the application does not need (and must not use) a
 * `SELECT … FOR UPDATE` followed by an `UPDATE`.
 *
 * Accounting: a reservation moves one seat from `available_seats` to `held_seats`
 * (their sum is unchanged, so `inv_capacity` still holds). Confirming consumes the
 * hold (`held_seats` drops, so total minus available minus held is the number of
 * confirmed seats). Releasing puts it back. That gives the audit job two exact
 * equalities to check instead of one loose inequality.
 */
const { normaliseInventory } = require('./mappers');

const COLUMNS = `
  flight_id, departure_date, cabin, shard_no, total_seats, available_seats,
  held_seats, version, updated_at`;

/** Aggregate shape shared by the availability and seat-map reads. */
const CABIN_AGGREGATE = `
  cabin,
  SUM(total_seats)::int     AS total_seats,
  SUM(available_seats)::int AS available_seats,
  SUM(held_seats)::int      AS held_seats,
  MAX(version)::bigint      AS version,
  count(*)::int             AS shard_count`;

/**
 * Creates the counter row for a (flight, cabin) if it is absent. Capacity is the
 * total the cabin will ever sell; `available_seats` starts equal to it, because a
 * new flight has sold nothing.
 */
async function ensure(client, { flightId, departureDate, cabin, shardNo = 0, totalSeats }) {
  const { rows } = await client.query(
    `INSERT INTO flight_inventory (
       flight_id, departure_date, cabin, shard_no, total_seats, available_seats, held_seats
     ) VALUES ($1, $2, $3, $4, $5, $5, 0)
     ON CONFLICT (flight_id, departure_date, cabin, shard_no) DO NOTHING
     RETURNING ${COLUMNS}`,
    [flightId, departureDate, cabin, shardNo, totalSeats]
  );
  if (rows[0]) return normaliseInventory(rows[0]);
  return getShard(client, { flightId, departureDate, cabin, shardNo });
}

/** Convenience for seeding and the admin flight endpoint: one row per cabin. */
async function ensureForCabins(client, { flightId, departureDate, cabins }) {
  const rows = [];
  for (const entry of cabins) {
    rows.push(
      await ensure(client, {
        flightId,
        departureDate,
        cabin: entry.cabin,
        shardNo: entry.shardNo || 0,
        totalSeats: entry.totalSeats
      })
    );
  }
  return rows;
}

async function getShard(client, { flightId, departureDate, cabin, shardNo = 0 }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM flight_inventory
      WHERE flight_id = $1 AND departure_date = $2 AND cabin = $3 AND shard_no = $4`,
    [flightId, departureDate, cabin, shardNo]
  );
  return rows[0] ? normaliseInventory(rows[0]) : null;
}

/**
 * Reserves `count` seats.
 *
 * Returns `{ reserved, inventory, reason }` rather than throwing, because "no seats
 * left" is an expected business outcome on a hot flight, not an exception — the
 * caller decides how it maps to a response and whether it should try another shard.
 *
 * `expectedVersion` enables optimistic concurrency for callers that want to fail
 * loudly when someone else changed the counter between their read and their write
 * (the seat-map UI does this). It is a *supplement* to the predicate, never a
 * replacement: the `available_seats >= count` test is what makes oversell impossible
 * even when no version was supplied.
 */
async function reserve(client, { flightId, departureDate, cabin, shardNo = 0, count = 1, expectedVersion = null }) {
  const { rows } = await client.query(
    `UPDATE flight_inventory
        SET available_seats = available_seats - $5,
            held_seats      = held_seats + $5,
            version         = version + 1,
            updated_at      = now()
      WHERE flight_id = $1
        AND departure_date = $2
        AND cabin = $3
        AND shard_no = $4
        AND available_seats >= $5
        AND ($6::bigint IS NULL OR version = $6)
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, cabin, shardNo, count, expectedVersion]
  );

  if (rows[0]) {
    return { reserved: true, inventory: normaliseInventory(rows[0]), reason: null };
  }

  // Zero rows updated: work out which predicate failed so the caller can answer
  // SOLD_OUT, VERSION_CONFLICT or NOT_FOUND instead of a generic conflict. This read
  // is advisory only — the decision was already made by the UPDATE above.
  const current = await getShard(client, { flightId, departureDate, cabin, shardNo });
  if (!current) {
    return { reserved: false, inventory: null, reason: 'NO_INVENTORY' };
  }
  if (current.availableSeats < count) {
    return { reserved: false, inventory: current, reason: 'SOLD_OUT' };
  }
  if (expectedVersion !== null && Number(current.version) !== Number(expectedVersion)) {
    return { reserved: false, inventory: current, reason: 'VERSION_CONFLICT' };
  }
  return { reserved: false, inventory: current, reason: 'NOT_RESERVED' };
}

/**
 * Turns a hold into a sale: the seat leaves `held_seats` for good and total minus
 * available minus held grows by `count`.
 *
 * Guarded by `held_seats >= count` so a confirm can never drive the counters
 * negative, and returns false when the row no longer holds what the caller thinks it
 * does — which is how a confirm that races the hold reaper is detected.
 */
async function confirm(client, { flightId, departureDate, cabin, shardNo = 0, count = 1 }) {
  const { rows } = await client.query(
    `UPDATE flight_inventory
        SET held_seats = held_seats - $5,
            version    = version + 1,
            updated_at = now()
      WHERE flight_id = $1
        AND departure_date = $2
        AND cabin = $3
        AND shard_no = $4
        AND held_seats >= $5
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, cabin, shardNo, count]
  );
  return { confirmed: rows.length > 0, inventory: rows[0] ? normaliseInventory(rows[0]) : null };
}

/**
 * Returns a hold's seats to the pool (cancellation, expiry, or saga compensation).
 *
 * `held_seats >= count` is the guard that makes double-release impossible: the
 * second release of the same hold updates zero rows, because the first one already
 * moved those seats back to `available_seats`.
 */
async function release(client, { flightId, departureDate, cabin, shardNo = 0, count = 1 }) {
  const { rows } = await client.query(
    `UPDATE flight_inventory
        SET available_seats = available_seats + $5,
            held_seats      = held_seats - $5,
            version         = version + 1,
            updated_at      = now()
      WHERE flight_id = $1
        AND departure_date = $2
        AND cabin = $3
        AND shard_no = $4
        AND held_seats >= $5
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, cabin, shardNo, count]
  );
  return { released: rows.length > 0, inventory: rows[0] ? normaliseInventory(rows[0]) : null };
}

/**
 * Returns a *confirmed* seat to the pool — the cancellation path for a booking that
 * was already paid for.
 *
 * This is deliberately a different statement from `release`. A confirmed seat is not
 * held: it left `held_seats` when the payment was captured, so releasing it would find
 * nothing to move and silently do nothing. Reclaiming adds to `available_seats`, and
 * the guard `available + held + count <= total` is what makes a double reclaim
 * impossible — the second attempt updates zero rows instead of inventing a seat.
 */
async function reclaim(client, { flightId, departureDate, cabin, shardNo = 0, count = 1 }) {
  const { rows } = await client.query(
    `UPDATE flight_inventory
        SET available_seats = available_seats + $5,
            version         = version + 1,
            updated_at      = now()
      WHERE flight_id = $1
        AND departure_date = $2
        AND cabin = $3
        AND shard_no = $4
        AND available_seats + held_seats + $5 <= total_seats
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, cabin, shardNo, count]
  );
  return { reclaimed: rows.length > 0, inventory: rows[0] ? normaliseInventory(rows[0]) : null };
}

/** Per-cabin counters for a flight — the availability endpoint. */
async function listCabins(client, { flightId, departureDate }) {
  const { rows } = await client.query(
    `SELECT ${CABIN_AGGREGATE} FROM flight_inventory
      WHERE flight_id = $1 AND departure_date = $2
      GROUP BY cabin
      ORDER BY cabin`,
    [flightId, departureDate]
  );
  return rows.map((row) => ({
    cabin: row.cabin,
    totalSeats: Number(row.total_seats),
    availableSeats: Number(row.available_seats),
    heldSeats: Number(row.held_seats),
    confirmedSeats: Number(row.total_seats) - Number(row.available_seats) - Number(row.held_seats),
    version: Number(row.version),
    shardCount: Number(row.shard_count)
  }));
}

async function getCabin(client, { flightId, departureDate, cabin }) {
  const { rows } = await client.query(
    `SELECT ${CABIN_AGGREGATE} FROM flight_inventory
      WHERE flight_id = $1 AND departure_date = $2 AND cabin = $3
      GROUP BY cabin`,
    [flightId, departureDate, cabin]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    cabin: row.cabin,
    totalSeats: Number(row.total_seats),
    availableSeats: Number(row.available_seats),
    heldSeats: Number(row.held_seats),
    confirmedSeats: Number(row.total_seats) - Number(row.available_seats) - Number(row.held_seats),
    version: Number(row.version),
    shardCount: Number(row.shard_count)
  };
}

/** Every shard row for a cabin, so the sharded strategy can pick a victim. */
async function listShards(client, { flightId, departureDate, cabin }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM flight_inventory
      WHERE flight_id = $1 AND departure_date = $2 AND cabin = $3
      ORDER BY shard_no`,
    [flightId, departureDate, cabin]
  );
  return rows.map(normaliseInventory);
}

/**
 * The oversell audit.
 *
 * `bookings` and `flight_inventory` are co-located on the same distribution column,
 * so this join runs as a local join inside each shard — no cross-shard shuffle. The
 * two equalities it checks are the ones the accounting promises:
 *
 *   held_seats      == live PENDING bookings
 *   total - available - held == CONFIRMED bookings
 *
 * A row violating either means a release, a confirm or a reservation was applied
 * without its counterpart — the thing a seat-counting bug looks like in production.
 * The database CHECK constraints make a *negative* count impossible, but they cannot
 * detect drift between the two tables, which is exactly what this finds.
 */
async function audit(client, { flightId = null, departureDate = null, cabin = null, limit = 100 } = {}) {
  // The scope is applied to the inventory side, which is the driving table: every
  // finding is a counter row that disagrees with the bookings, so a counter outside
  // the scope can produce no in-scope finding. Filtering the bookings CTE instead
  // would be wrong — it would hide the bookings that cause a mismatch.
  const { rows } = await client.query(
    `WITH inv AS (
       SELECT flight_id, departure_date, cabin,
              SUM(total_seats)::int     AS total_seats,
              SUM(available_seats)::int AS available_seats,
              SUM(held_seats)::int      AS held_seats
         FROM flight_inventory
        WHERE ($1::uuid IS NULL OR flight_id = $1)
          AND ($2::date IS NULL OR departure_date = $2)
          AND ($3::text IS NULL OR cabin = $3)
        GROUP BY flight_id, departure_date, cabin
     ), live AS (
       SELECT flight_id, departure_date, cabin,
              count(*) FILTER (WHERE status = 'PENDING')::int   AS pending_bookings,
              count(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed_bookings
         FROM bookings
        WHERE status IN ('PENDING', 'CONFIRMED')
          AND flight_id IN (SELECT flight_id FROM inv)
        GROUP BY flight_id, departure_date, cabin
     )
     SELECT inv.flight_id,
            inv.departure_date,
            inv.cabin,
            inv.total_seats,
            inv.available_seats,
            inv.held_seats,
            (inv.total_seats - inv.available_seats - inv.held_seats) AS confirmed_seats,
            COALESCE(live.pending_bookings, 0)   AS pending_bookings,
            COALESCE(live.confirmed_bookings, 0) AS confirmed_bookings,
            CASE
              WHEN inv.available_seats < 0 OR inv.held_seats < 0 THEN 'NEGATIVE_COUNTER'
              WHEN inv.available_seats + inv.held_seats > inv.total_seats THEN 'OVERCAPACITY'
              WHEN inv.held_seats <> COALESCE(live.pending_bookings, 0) THEN 'HELD_MISMATCH'
              WHEN (inv.total_seats - inv.available_seats - inv.held_seats)
                   <> COALESCE(live.confirmed_bookings, 0) THEN 'CONFIRMED_MISMATCH'
              ELSE NULL
            END AS violation
       FROM inv
       LEFT JOIN live
         ON live.flight_id = inv.flight_id
        AND live.departure_date = inv.departure_date
        AND live.cabin = inv.cabin
      ORDER BY inv.departure_date, inv.flight_id, inv.cabin`,
    [flightId, departureDate, cabin]
  );

  const violations = rows.filter((row) => row.violation !== null);
  return {
    checkedRows: rows.length,
    violations: violations.slice(0, limit).map(describeViolation),
    violationCount: violations.length
  };
}

/**
 * Turns one divergent row into a finding, including the signed size of the
 * discrepancy.
 *
 * `delta` is computed per violation type because each invariant has its own two
 * sides and its own sign: a HELD_MISMATCH is `held - pending`, while a
 * CONFIRMED_MISMATCH is `confirmed - confirmedBookings`. Reporting a single
 * generic "difference" would leave an operator to work out which subtraction the
 * audit meant, and `booked = confirmed + held` is the number a person actually
 * reasons about (seats consumed) rather than `capacity - available`, which is the
 * same quantity expressed as a subtraction they have to do themselves.
 */
function describeViolation(row) {
  const totalSeats = Number(row.total_seats);
  const availableSeats = Number(row.available_seats);
  const heldSeats = Number(row.held_seats);
  const confirmedSeats = Number(row.confirmed_seats);
  const pendingBookings = Number(row.pending_bookings);
  const confirmedBookings = Number(row.confirmed_bookings);
  const booked = confirmedSeats + heldSeats;

  let delta;
  switch (row.violation) {
    case 'HELD_MISMATCH':
      delta = heldSeats - pendingBookings;
      break;
    case 'CONFIRMED_MISMATCH':
      delta = confirmedSeats - confirmedBookings;
      break;
    default:
      // NEGATIVE_COUNTER and OVERCAPACITY are both "more seats are spoken for than
      // exist", and both are measured against capacity.
      delta = booked - totalSeats;
  }

  return {
    flightId: row.flight_id,
    departureDate: row.departure_date,
    cabin: row.cabin,
    violation: row.violation,
    totalSeats,
    capacity: totalSeats,
    availableSeats,
    available: availableSeats,
    heldSeats,
    confirmedSeats,
    booked,
    delta,
    pendingBookings,
    confirmedBookings
  };
}

module.exports = {
  ensure,
  ensureForCabins,
  getShard,
  getCabin,
  listShards,
  listCabins,
  reserve,
  confirm,
  release,
  reclaim,
  audit,
  describeViolation
};
