const pool = require('../src/db/pool');

async function test() {
  const start = Date.now();
  try {
    const res = await pool.query(`
      SELECT f.flight_id, f.flight_number, f.airline_code, f.origin, f.destination,
             f.departure_date, f.departure_time, f.arrival_time, f.aircraft_type,
             f.base_price, f.currency, f.status
      FROM flights f
      ORDER BY f.departure_date ASC
      LIMIT 50
    `);
    console.log(`Query took ${Date.now() - start}ms, rows: ${res.rows.length}`);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}

test();
