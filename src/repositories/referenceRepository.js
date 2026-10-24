/**
 * Reference-data repository.
 *
 * These tables are small and read on nearly every request: airlines, airports,
 * cabins, aircraft types, and the seat-map templates. In Citus they are *reference
 * tables* (replicated to every worker), so a join against them is a local join on the
 * worker that already holds the flight — no network hop, no cross-shard transaction.
 * On vanilla PostgreSQL they are ordinary tables and nothing changes.
 *
 * The seat map deserves a note: it is stored as a template *per aircraft type*, not
 * per flight. Materializing seats per flight would be ~10 billion rows at 50M
 * flights, to describe something entirely derivable. A flight's seat map is therefore
 * computed: take the template for its aircraft type, subtract the seats that live
 * bookings actually hold.
 */
const { normaliseUser } = require('./mappers');

const SEAT_ORDER = `
  ORDER BY
    (regexp_replace(seat_number, '[^0-9]', '', 'g'))::int,
    regexp_replace(seat_number, '[^A-Za-z]', '', 'g')`;

async function listCabins(client) {
  const { rows } = await client.query(
    `SELECT code, name, rank FROM cabins ORDER BY rank, code`
  );
  return rows.map((row) => ({ code: row.code, name: row.name, rank: Number(row.rank) }));
}

async function findCabin(client, { code }) {
  const { rows } = await client.query(
    `SELECT code, name, rank FROM cabins WHERE code = $1`,
    [code]
  );
  if (!rows[0]) return null;
  return { code: rows[0].code, name: rows[0].name, rank: Number(rows[0].rank) };
}

async function listAirlines(client) {
  const { rows } = await client.query(
    `SELECT code, name, country, is_active FROM airlines ORDER BY code`
  );
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    country: row.country,
    isActive: row.is_active
  }));
}

async function findAirline(client, { code }) {
  const { rows } = await client.query(
    `SELECT code, name, country, is_active FROM airlines WHERE code = $1`,
    [code]
  );
  if (!rows[0]) return null;
  return { code: rows[0].code, name: rows[0].name, country: rows[0].country, isActive: rows[0].is_active };
}

async function listAirports(client) {
  const { rows } = await client.query(
    `SELECT code, name, city, country, tz FROM airports ORDER BY code`
  );
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    city: row.city,
    country: row.country,
    timezone: row.tz
  }));
}

async function findAirport(client, { code }) {
  const { rows } = await client.query(
    `SELECT code, name, city, country, tz FROM airports WHERE code = $1`,
    [code]
  );
  if (!rows[0]) return null;
  return {
    code: rows[0].code,
    name: rows[0].name,
    city: rows[0].city,
    country: rows[0].country,
    timezone: rows[0].tz
  };
}

async function listAircraftTypes(client) {
  const { rows } = await client.query(
    `SELECT code, name, manufacturer FROM aircraft_types ORDER BY code`
  );
  return rows.map((row) => ({ code: row.code, name: row.name, manufacturer: row.manufacturer }));
}

async function findAircraftType(client, { code }) {
  const { rows } = await client.query(
    `SELECT code, name, manufacturer FROM aircraft_types WHERE code = $1`,
    [code]
  );
  if (!rows[0]) return null;
  return { code: rows[0].code, name: rows[0].name, manufacturer: rows[0].manufacturer };
}

/**
 * Seat template for an aircraft type, optionally narrowed to one cabin, in physical
 * order (row number, then letter) — the order a passenger expects to see.
 */
async function listSeatTemplate(client, { aircraftType, cabin = null }) {
  const params = [aircraftType];
  let predicate = '';
  if (cabin) {
    predicate = ' AND cabin = $2';
    params.push(cabin);
  }
  const { rows } = await client.query(
    `SELECT aircraft_type, cabin, seat_number, seat_position, is_exit_row
       FROM seat_map_templates
      WHERE aircraft_type = $1${predicate}
      ${SEAT_ORDER}`,
    params
  );
  return rows.map((row) => ({
    aircraftType: row.aircraft_type,
    cabin: row.cabin,
    seatNumber: row.seat_number,
    seatPosition: row.seat_position,
    isExitRow: row.is_exit_row
  }));
}

/**
 * Seat count per cabin for an aircraft type. This is the authoritative source for a
 * flight's cabin capacity: the inventory counter for a seeded flight starts equal to
 * the template size, so "capacity" and "what the seat map shows" cannot disagree.
 */
async function cabinSizes(client, { aircraftType }) {
  const { rows } = await client.query(
    `SELECT cabin, count(*)::int AS seats
       FROM seat_map_templates
      WHERE aircraft_type = $1
      GROUP BY cabin
      ORDER BY cabin`,
    [aircraftType]
  );
  return rows.map((row) => ({ cabin: row.cabin, seats: Number(row.seats) }));
}

/** Distinct seat letters (columns) in a cabin, in a stable order. */
async function seatColumns(client, { aircraftType, cabin }) {
  const { rows } = await client.query(
    `SELECT DISTINCT regexp_replace(seat_number, '[^A-Za-z]', '', 'g') AS letter
       FROM seat_map_templates
      WHERE aircraft_type = $1 AND cabin = $2
      ORDER BY letter`,
    [aircraftType, cabin]
  );
  return rows.map((row) => row.letter);
}

/** Row count of a cabin, so the seat map can be described as rows x columns. */
async function seatRowCount(client, { aircraftType, cabin }) {
  const { rows } = await client.query(
    `SELECT count(DISTINCT (regexp_replace(seat_number, '[^0-9]', '', 'g'))::int)::int AS rows
       FROM seat_map_templates
      WHERE aircraft_type = $1 AND cabin = $2`,
    [aircraftType, cabin]
  );
  return Number(rows[0]?.rows || 0);
}

async function findUserById(client, { userId }) {
  const { rows } = await client.query(
    `SELECT id, email, role, full_name, phone, is_active, last_login_at, created_at, updated_at
       FROM users WHERE id = $1`,
    [userId]
  );
  return normaliseUser(rows[0]);
}

module.exports = {
  listCabins,
  findCabin,
  listAirlines,
  findAirline,
  listAirports,
  findAirport,
  listAircraftTypes,
  findAircraftType,
  listSeatTemplate,
  cabinSizes,
  seatColumns,
  seatRowCount,
  findUserById
};
