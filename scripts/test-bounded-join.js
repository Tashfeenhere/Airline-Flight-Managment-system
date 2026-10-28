const pool = require('../src/db/pool');

async function test() {
  const start = Date.now();
  const r = await pool.query(`
    SELECT f.flight_id, f.departure_date, f.flight_number, f.origin, f.destination, fi.cabin, fi.available_seats
    FROM flights f
    JOIN flight_inventory fi ON f.flight_id = fi.flight_id AND f.departure_date = fi.departure_date
    WHERE f.departure_date >= '2026-10-24' AND f.departure_date <= '2026-11-05'
      AND fi.available_seats > 5 AND fi.cabin = 'ECONOMY'
    LIMIT 1
  `);
  console.log(`Query took ${Date.now() - start}ms:`, r.rows[0]);
  process.exit(0);
}

test();
