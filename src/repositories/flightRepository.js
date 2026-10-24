/**
 * Flight repository (write model).
 *
 * Two things about this table shape the SQL here:
 *
 * 1. `flights` is PARTITION BY RANGE (departure_date) *and* distributed by
 *    `flight_id`. Every statement that can supply `departure_date` does, because the
 *    partition key is what turns a lookup into a single-partition, single-shard
 *    index probe. A lookup by `flight_id` alone still routes to one worker (the hash
 *    range is the same on every partition) but has to open that worker's partition
 *    for each month — so `findById` is the primary path and `findAnyById` exists only
 *    for the cases where the caller genuinely does not know the date.
 * 2. `departure_date` is not independently writable: `ck_flights_departure_date`
 *    requires it to equal the UTC date of `departure_time`. Inserts therefore derive
 *    nothing and pass both, letting the constraint reject a mismatch instead of
 *    letting a row land in the wrong month.
 */
const { normaliseFlight } = require('./mappers');

const COLUMNS = `
  flight_id, flight_number, airline_code, origin, destination, departure_date,
  departure_time, arrival_time, aircraft_type, base_price, currency, status,
  created_at, updated_at`;

/** The columns an upsert writes, and the values it writes them from. */
const UPSERT_COLUMNS = `
  flight_id, flight_number, airline_code, origin, destination, departure_date,
  departure_time, arrival_time, aircraft_type, base_price, currency, status`;

function upsertValues(flight) {
  return [
    flight.flightId || null,
    flight.flightNumber,
    flight.airlineCode,
    flight.origin,
    flight.destination,
    flight.departureDate,
    flight.departureTime,
    flight.arrivalTime,
    flight.aircraftType,
    flight.basePrice,
    flight.currency || null,
    flight.status || null
  ];
}

/**
 * Inserts a flight, or updates it in place when the same (flight_id, departure_date)
 * already exists. Upsert rather than insert-or-fail because flight schedules are
 * re-imported routinely: the same flight is published, revised, and republished.
 *
 * `created` distinguishes the two outcomes, which an operator wants to see ("did this
 * import add anything?") and which cannot be answered by looking at the row: an
 * updated row and an inserted row carry the same columns. The usual way to ask
 * PostgreSQL is `RETURNING (xmax = 0)`, and on this table that is not available —
 * `flights` is partitioned, and PostgreSQL rejects system columns in the RETURNING
 * list of a partitioned table with SQLSTATE 0A000 ("cannot retrieve a system column in
 * this context"). Comparing `created_at` and `updated_at` instead does not survive the
 * trip either: both the driver's Date and `toISOString()` are millisecond-resolution,
 * and a bulk re-import genuinely does update a row inside the same millisecond it was
 * inserted, which would report a fresh insert.
 *
 * So the two outcomes are separated by asking for them separately. `DO NOTHING`
 * returns no row exactly when a conflicting row already existed, and the caller's
 * transaction then updates it. Both statements run on the same connection inside the
 * transaction `upsertFlight` opened, so the row is locked from the first statement
 * onwards and no other writer can slip between them. The cost is a second round trip
 * on the update path only; the insert path — the bulk loader's common case — stays one
 * statement.
 *
 * `created` is an extra property on the returned object rather than part of the flight
 * shape; `serializeFlight` whitelists its fields, so it cannot leak into a response
 * that did not ask for it.
 */
async function upsert(client, flight) {
  const inserted = await client.query(
    `INSERT INTO flights (${UPSERT_COLUMNS})
     VALUES (
       COALESCE($1::uuid, app_uuidv7()), $2, $3, $4, $5, $6, $7, $8, $9, $10,
       COALESCE($11, 'USD'), COALESCE($12, 'SCHEDULED')
     )
     ON CONFLICT (flight_id, departure_date) DO NOTHING
     RETURNING ${COLUMNS}`,
    upsertValues(flight)
  );

  if (inserted.rows.length > 0) {
    const saved = normaliseFlight(inserted.rows[0]);
    if (saved) saved.created = true;
    return saved;
  }

  // A conflict: the flight exists already (or a concurrent inserter committed one
  // while this statement waited on its lock — `DO NOTHING` waits, then declines).
  // Either way the row is now there, and this UPDATE is what applies the new values.
  //
  // The WHERE clause names the id rather than falling back to the insert's generated
  // one. It is only reachable when the caller supplied an id — an id the database
  // minted cannot collide — so there is no generated value to fall back to, and a
  // predicate that degraded to "the row with this departure_date" would rewrite every
  // flight that day. A null id here matches nothing and returns no row, which surfaces
  // as a loud failure rather than as silent mass corruption.
  const updated = await client.query(
    `UPDATE flights SET
       flight_number  = $2,
       airline_code   = $3,
       origin         = $4,
       destination    = $5,
       departure_time = $7,
       arrival_time   = $8,
       aircraft_type  = $9,
       base_price     = $10,
       currency       = COALESCE($11, currency),
       status         = COALESCE($12, status),
       updated_at     = now()
     WHERE flight_id = $1::uuid AND departure_date = $6
     RETURNING ${COLUMNS}`,
    upsertValues(flight)
  );

  const saved = normaliseFlight(updated.rows[0]);
  if (saved) saved.created = false;
  return saved;
}

/** Transposes a batch of flights into the parallel arrays `unnest` consumes. */
function upsertColumnArrays(flights) {
  return [
    flights.map((flight) => flight.flightId || null),
    flights.map((flight) => flight.flightNumber),
    flights.map((flight) => flight.airlineCode),
    flights.map((flight) => flight.origin),
    flights.map((flight) => flight.destination),
    flights.map((flight) => flight.departureDate),
    flights.map((flight) => flight.departureTime),
    flights.map((flight) => flight.arrivalTime),
    flights.map((flight) => flight.aircraftType),
    flights.map((flight) => flight.basePrice),
    flights.map((flight) => flight.currency || null),
    flights.map((flight) => flight.status || null)
  ];
}

/**
 * Upserts a batch of flights in ONE statement, by transposing the batch into parallel
 * arrays and letting `unnest` produce the rows.
 *
 * Deliberately not a loop of `upsert` calls: each call is a round trip, so the loop
 * costs one network wait per flight, and the caller who reaches for "many" is by
 * definition the caller with a lot of them. Inside one statement the rows are also one
 * snapshot, so a concurrent reader never sees half the batch.
 *
 * Two differences from the single-row `upsert`, both consequences of collapsing the
 * work into one statement, and both documented rather than hidden:
 *
 * 1. `created` is not reported. It needs `xmax`, and PostgreSQL refuses system columns
 *    in the RETURNING list of a partitioned table (SQLSTATE 0A000 — see `upsert`). A
 *    caller that needs insert-vs-update provenance calls `upsert` per row and pays the
 *    round trips for it.
 * 2. The batch applies the values it is given; it does not preserve an existing value
 *    when the input is null. `currency` and `status` are NOT NULL with defaults, and an
 *    INSERT reads a supplied NULL as a NULL rather than falling back to the default, so
 *    the statement coalesces them to 'USD' and 'SCHEDULED' on both paths — where
 *    `upsert` would have left an existing currency alone. A batch load supplies whole
 *    rows, so there is nothing to preserve; a caller patching one field wants `upsert`.
 *
 * This is not the path the ~50M-flight import uses. That is COPY from the Python
 * loaders, which bypasses this API and its outbox entirely and is documented in
 * docs/DATA_LOADING.md; `readmodel:reproject` is what makes those rows visible to
 * search. This function is for batches that came through the application.
 *
 * Rows should share a departure month where the caller can arrange it: `flights` is
 * partitioned by `departure_date`, so a batch spanning months opens a partition set in
 * each of them, and the arrays are held in memory rather than streamed.
 */
async function upsertMany(client, flights) {
  if (flights.length === 0) return [];

  const { rows } = await client.query(
    `INSERT INTO flights (${UPSERT_COLUMNS})
     SELECT COALESCE(f.flight_id, app_uuidv7()), f.flight_number, f.airline_code,
            f.origin, f.destination, f.departure_date, f.departure_time, f.arrival_time,
            f.aircraft_type, f.base_price,
            COALESCE(f.currency, 'USD'), COALESCE(f.status, 'SCHEDULED')
       FROM unnest(
              $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::date[],
              $7::timestamptz[], $8::timestamptz[], $9::text[], $10::numeric[],
              $11::text[], $12::text[]
            ) AS f(flight_id, flight_number, airline_code, origin, destination,
                   departure_date, departure_time, arrival_time, aircraft_type,
                   base_price, currency, status)
     ON CONFLICT (flight_id, departure_date) DO UPDATE SET
       flight_number  = EXCLUDED.flight_number,
       airline_code   = EXCLUDED.airline_code,
       origin         = EXCLUDED.origin,
       destination    = EXCLUDED.destination,
       departure_time = EXCLUDED.departure_time,
       arrival_time   = EXCLUDED.arrival_time,
       aircraft_type  = EXCLUDED.aircraft_type,
       base_price     = EXCLUDED.base_price,
       currency       = EXCLUDED.currency,
       status         = EXCLUDED.status,
       updated_at     = now()
     RETURNING ${COLUMNS}`,
    upsertColumnArrays(flights)
  );

  // One row per input row, in input order: `RETURNING` preserves the order rows were
  // produced, and the SELECT produces them by scanning the arrays in order. A caller
  // that needs to pair a result with its input (to report which rows failed) relies on
  // that, so the alternative — returning an unordered map — would be worse here.
  return rows.map(normaliseFlight);
}

/** Primary lookup: date known, so the plan is one partition and one shard. */
async function findById(client, { flightId, departureDate }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM flights
      WHERE flight_id = $1 AND departure_date = $2`,
    [flightId, departureDate]
  );
  return rows[0] ? normaliseFlight(rows[0]) : null;
}

/**
 * Lookup by id alone — for the public "get this flight" endpoint, which receives
 * only a flight id. Costs a pass over the flight's monthly partitions, all on the
 * same worker; a UUIDv7 flight id belongs to exactly one departure, so the LIMIT 1
 * is exact rather than arbitrary.
 */
async function findAnyById(client, { flightId }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM flights
      WHERE flight_id = $1
      ORDER BY departure_date
      LIMIT 1`,
    [flightId]
  );
  return rows[0] ? normaliseFlight(rows[0]) : null;
}

/** Route/date search against the write model. Used by tests, audits and reprojection. */
async function listByRoute(client, { origin, destination, departureDate, limit = 50, offset = 0 }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM flights
      WHERE origin = $1 AND destination = $2 AND departure_date = $3
        AND status <> 'CANCELLED'
      ORDER BY departure_time
      LIMIT $4 OFFSET $5`,
    [origin, destination, departureDate, limit, offset]
  );
  return rows.map(normaliseFlight);
}

/** Flights departing in a window — the reprojection job walks the write model this way. */
async function listByDateRange(client, { fromDate, toDate, limit = 500, offset = 0 }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM flights
      WHERE departure_date >= $1 AND departure_date <= $2
      ORDER BY departure_date, departure_time
      LIMIT $3 OFFSET $4`,
    [fromDate, toDate, limit, offset]
  );
  return rows.map(normaliseFlight);
}

async function updateStatus(client, { flightId, departureDate, status }) {
  const { rows } = await client.query(
    `UPDATE flights SET status = $3, updated_at = now()
      WHERE flight_id = $1 AND departure_date = $2
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, status]
  );
  return rows[0] ? normaliseFlight(rows[0]) : null;
}

/** Existence probe used by the booking path to reject unknown flights early. */
async function exists(client, { flightId, departureDate }) {
  const { rows } = await client.query(
    `SELECT 1 AS present FROM flights WHERE flight_id = $1 AND departure_date = $2`,
    [flightId, departureDate]
  );
  return rows.length > 0;
}

module.exports = {
  upsert,
  upsertMany,
  findById,
  findAnyById,
  listByRoute,
  listByDateRange,
  updateStatus,
  exists
};
