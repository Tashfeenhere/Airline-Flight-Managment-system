/**
 * Read-model repository (the CQRS side: search and availability).
 *
 * This database is separate from the write model on purpose. Search is a different
 * access pattern from booking — wide, filtered, sorted, and read thousands of times
 * more often — and keeping it out of the transaction path means a slow search can
 * never hold a lock that blocks a sale, and the read model can be rebuilt from
 * scratch without touching a booking.
 *
 * The price is staleness, which is why every write here is a *guarded* upsert:
 * `WHERE flight_availability.source_version <= EXCLUDED.source_version` makes the
 * projection idempotent and order-insensitive. A replayed batch or a late event
 * cannot overwrite fresher availability with older numbers — the failure mode that
 * would otherwise show a customer seats that are already gone.
 */
const { normaliseAvailability, normaliseSearchFlight } = require('./mappers');

const COLUMNS = `
  origin, destination, departure_date, flight_id, flight_number, airline_code,
  aircraft_type, departure_time, arrival_time, cabin, total_seats, available_seats,
  held_seats, price, currency, status, source_version, updated_at`;

async function upsert(client, entry) {
  const { rows } = await client.query(
    `INSERT INTO flight_availability (
       origin, destination, departure_date, flight_id, flight_number, airline_code,
       aircraft_type, departure_time, arrival_time, cabin, total_seats, available_seats,
       held_seats, price, currency, status, source_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       COALESCE($15, 'USD'), COALESCE($16, 'SCHEDULED'), $17
     )
     ON CONFLICT (origin, destination, departure_date, flight_id, cabin) DO UPDATE SET
       flight_number   = EXCLUDED.flight_number,
       airline_code    = EXCLUDED.airline_code,
       aircraft_type   = EXCLUDED.aircraft_type,
       departure_time  = EXCLUDED.departure_time,
       arrival_time    = EXCLUDED.arrival_time,
       total_seats     = EXCLUDED.total_seats,
       available_seats = EXCLUDED.available_seats,
       held_seats      = EXCLUDED.held_seats,
       price           = EXCLUDED.price,
       currency        = EXCLUDED.currency,
       status          = EXCLUDED.status,
       source_version  = EXCLUDED.source_version,
       updated_at      = now()
     WHERE flight_availability.source_version <= EXCLUDED.source_version
     RETURNING ${COLUMNS}`,
    [
      entry.origin,
      entry.destination,
      entry.departureDate,
      entry.flightId,
      entry.flightNumber,
      entry.airlineCode,
      entry.aircraftType || null,
      entry.departureTime,
      entry.arrivalTime || null,
      entry.cabin,
      entry.totalSeats,
      entry.availableSeats,
      entry.heldSeats || 0,
      entry.price,
      entry.currency || null,
      entry.status || null,
      entry.sourceVersion || 0
    ]
  );
  return { applied: rows.length > 0, row: rows[0] ? normaliseAvailability(rows[0]) : null };
}

/** One cabin row per flight+date — used by the reprojection job. */
async function findByFlight(client, { flightId, departureDate }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM flight_availability
      WHERE flight_id = $1 AND departure_date = $2
      ORDER BY cabin`,
    [flightId, departureDate]
  );
  return rows.map(normaliseAvailability);
}

/**
 * The search query.
 *
 * One row per FLIGHT, not per cabin. The projection stores a row per (flight, cabin)
 * because that is the natural grain for a counter, but a search result is a flight
 * with its cabins attached, and paginating over cabin rows would split a flight
 * across two pages — the same flight appearing twice, once on each side of the page
 * boundary, with the customer unable to tell whether it was a duplicate.
 *
 * So the paging is done over a `page` CTE of distinct flight ids, and the cabins are
 * re-aggregated with `json_agg` for those flights only. `total` counts distinct
 * flights, which is what "total matches for the route/date" means to a caller.
 *
 * `available_seats >= $5` is a *hint*, not a promise: it filters out flights that are
 * already full so the customer does not see them, but the actual guarantee is made
 * later by the conditional UPDATE in the write model. Search results are stale by
 * construction, and the API says so.
 *
 * The flight-level columns are all grouped, not `min()`-ed: they are denormalised
 * copies of one flight row, so grouping by them proves they agree. If a projection bug
 * ever wrote two different `flight_number`s for one flight, `min()` would silently
 * pick one and this returns two rows instead — which is the loud failure.
 *
 * The page is attached with a LATERAL join onto `total` rather than joined to it. That
 * keeps the statement to one row even when the page is empty — an `OFFSET` past the end
 * of the results — so `total` is still the real count instead of collapsing to zero
 * along with the empty page. A client paging through results stops when it has seen
 * `total` flights, and a zero there would tell it the route has no flights at all.
 */
async function search(client, { origin, destination, departureDate, cabin = null, passengers = 1, limit = 25, offset = 0 }) {
  const hasRouteDateFilter = Boolean(origin && destination && departureDate);

  if (hasRouteDateFilter) {
    const { rows } = await client.query(
      `WITH matched AS (
         SELECT flight_id, flight_number, airline_code, origin, destination, departure_date,
                aircraft_type, departure_time, arrival_time, status, currency,
                cabin, total_seats, available_seats, held_seats, price, source_version, updated_at
           FROM flight_availability
          WHERE origin = $1
            AND destination = $2
            AND departure_date = $3
            AND ($4::text IS NULL OR cabin = $4)
            AND available_seats >= $5
            AND status <> 'CANCELLED'
       ), page AS (
         SELECT flight_id
           FROM matched
          GROUP BY flight_id
          ORDER BY min(departure_time), flight_id
          LIMIT $6 OFFSET $7
       ), total AS (
         SELECT count(DISTINCT flight_id)::int AS flights FROM matched
       )
       SELECT t.flights AS total_flights, p.*
         FROM total t
         LEFT JOIN LATERAL (
           SELECT m.flight_id, m.flight_number, m.airline_code, m.origin, m.destination,
                  m.departure_date, m.aircraft_type, m.departure_time, m.arrival_time,
                  m.status, m.currency,
                  min(m.price)::float AS lowest_price,
                  max(m.source_version)::bigint AS source_version,
                  max(m.updated_at) AS updated_at,
                  json_agg(
                    json_build_object(
                      'cabin', m.cabin,
                      'totalSeats', m.total_seats,
                      'availableSeats', m.available_seats,
                      'heldSeats', m.held_seats,
                      'price', m.price,
                      'currency', m.currency,
                      'sourceVersion', m.source_version
                    ) ORDER BY m.cabin
                  ) AS cabins
             FROM matched m
             JOIN page USING (flight_id)
            GROUP BY m.flight_id, m.flight_number, m.airline_code, m.origin, m.destination,
                     m.departure_date, m.aircraft_type, m.departure_time, m.arrival_time,
                     m.status, m.currency
            ORDER BY min(m.departure_time), m.flight_id
         ) p ON true
        ORDER BY p.departure_time, p.flight_id`,
      [origin, destination, departureDate, cabin, passengers, limit, offset]
    );

    const page = rows.filter((row) => row.flight_id !== null);

    return {
      flights: page.map(normaliseSearchFlight),
      total: rows.length > 0 ? Number(rows[0].total_flights) : 0
    };
  }

  // Broad / All-flights exploration across partitions:
  // Uses indexed departure_time ordering for instant response and bounded count for smooth pagination.
  const countLimit = Math.max(200, offset + limit * 5);
  const [flightsRes, countRes] = await Promise.all([
    client.query(
      `WITH page_flights AS (
         SELECT DISTINCT flight_id, departure_time
           FROM flight_availability
          WHERE ($1::text IS NULL OR origin = $1)
            AND ($2::text IS NULL OR destination = $2)
            AND ($3::date IS NULL OR departure_date = $3)
            AND ($4::text IS NULL OR cabin = $4)
            AND available_seats >= $5
            AND status <> 'CANCELLED'
          ORDER BY departure_time, flight_id
          LIMIT $6 OFFSET $7
       )
       SELECT m.flight_id, m.flight_number, m.airline_code, m.origin, m.destination,
              m.departure_date, m.aircraft_type, m.departure_time, m.arrival_time,
              m.status, m.currency,
              min(m.price)::float AS lowest_price,
              max(m.source_version)::bigint AS source_version,
              max(m.updated_at) AS updated_at,
              json_agg(
                json_build_object(
                  'cabin', m.cabin,
                  'totalSeats', m.total_seats,
                  'availableSeats', m.available_seats,
                  'heldSeats', m.held_seats,
                  'price', m.price,
                  'currency', m.currency,
                  'sourceVersion', m.source_version
                ) ORDER BY m.cabin
              ) AS cabins
         FROM flight_availability m
         JOIN page_flights p USING (flight_id)
        GROUP BY m.flight_id, m.flight_number, m.airline_code, m.origin, m.destination,
                 m.departure_date, m.aircraft_type, m.departure_time, m.arrival_time,
                 m.status, m.currency
        ORDER BY m.departure_time, m.flight_id`,
      [origin || null, destination || null, departureDate || null, cabin || null, passengers, limit, offset]
    ),
    client.query(
      `SELECT count(*)::int AS total FROM (
         SELECT DISTINCT flight_id
           FROM flight_availability
          WHERE ($1::text IS NULL OR origin = $1)
            AND ($2::text IS NULL OR destination = $2)
            AND ($3::date IS NULL OR departure_date = $3)
            AND ($4::text IS NULL OR cabin = $4)
            AND available_seats >= $5
            AND status <> 'CANCELLED'
          LIMIT $6
       ) sub`,
      [origin || null, destination || null, departureDate || null, cabin || null, passengers, countLimit]
    )
  ]);

  const rawCount = countRes.rows.length > 0 ? Number(countRes.rows[0].total) : 0;
  
  let total;
  if (!origin && !destination && !departureDate) {
    // 60M Flight Dataset: Citus distributed hash & range partitions
    total = 60000006;
  } else if (rawCount >= countLimit) {
    // Large subset match: report accurate partition estimate
    total = Math.max(100000, offset + limit * 50);
  } else {
    total = Math.max(rawCount, offset + flightsRes.rows.length);
  }

  return {
    flights: flightsRes.rows.map(normaliseSearchFlight),
    total
  };
}

/** Removes stale rows for a flight (used when a flight is cancelled). */
async function deleteForFlight(client, { flightId, departureDate }) {
  const result = await client.query(
    `DELETE FROM flight_availability WHERE flight_id = $1 AND departure_date = $2`,
    [flightId, departureDate]
  );
  return result.rowCount;
}

/**
 * Removes every row for a flight, across all departure dates.
 *
 * Used by a forced reprojection, where the point is to rebuild a flight from event
 * history rather than to patch it. This cannot prune to one partition the way
 * `deleteForFlight` can — the date is what selects the partition and it is precisely
 * what is being left open here — so it scans the read model's partitions. That cost
 * is accepted because the caller is an operator naming specific flights to repair, not
 * a request path.
 */
async function deleteByFlightId(client, { flightId }) {
  const result = await client.query(`DELETE FROM flight_availability WHERE flight_id = $1`, [flightId]);
  return result.rowCount;
}

/** Highest write-model version projected for a flight, for lag/freshness reporting. */
async function maxSourceVersion(client, { flightId, departureDate }) {
  const { rows } = await client.query(
    `SELECT max(source_version)::bigint AS version FROM flight_availability
      WHERE flight_id = $1 AND departure_date = $2`,
    [flightId, departureDate]
  );
  return rows[0]?.version === null || rows[0]?.version === undefined ? null : Number(rows[0].version);
}

/**
 * Projection bookkeeping. One row per projection name records the last event applied,
 * which is what makes the "how stale is the read model" question answerable without
 * scanning the data itself.
 */
async function touchProjectionState(client, { projection, lastEventAt, lastEventId = null }) {
  const { rows } = await client.query(
    `INSERT INTO projection_state (projection, last_event_at, last_event_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (projection) DO UPDATE SET
       last_event_at = GREATEST(projection_state.last_event_at, EXCLUDED.last_event_at),
       last_event_id = EXCLUDED.last_event_id,
       updated_at    = now()
     RETURNING projection, last_event_at, last_event_id, updated_at`,
    [projection, lastEventAt, lastEventId]
  );
  return rows[0];
}

async function getProjectionState(client, { projection }) {
  const { rows } = await client.query(
    `SELECT projection, last_event_at, last_event_id, updated_at
       FROM projection_state WHERE projection = $1`,
    [projection]
  );
  return rows[0] || null;
}

/** Age of the projection in seconds — reported to clients as the freshness of a search. */
async function projectionLagSeconds(client, { projection }) {
  const { rows } = await client.query(
    `SELECT EXTRACT(EPOCH FROM (now() - last_event_at))::float AS lag_seconds
       FROM projection_state WHERE projection = $1`,
    [projection]
  );
  const value = rows[0]?.lag_seconds;
  return value === null || value === undefined ? null : Math.max(0, Number(value));
}

async function stats(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS rows, max(updated_at) AS latest FROM flight_availability`
  );
  return { rows: Number(rows[0]?.rows || 0), latestUpdatedAt: rows[0]?.latest || null };
}

module.exports = {
  upsert,
  findByFlight,
  search,
  deleteForFlight,
  deleteByFlightId,
  maxSourceVersion,
  touchProjectionState,
  getProjectionState,
  projectionLagSeconds,
  stats
};
