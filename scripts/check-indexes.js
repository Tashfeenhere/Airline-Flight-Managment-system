const pool = require('../src/db/pool');

async function checkIndex() {
  try {
    const res = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'flights_p202611' OR tablename = 'flights'
    `);
    console.log('Indexes:', res.rows);

    const fRes = await pool.query(`
      SELECT flight_id, flight_number, airline_code, origin, destination, departure_date, departure_time, arrival_time, aircraft_type, base_price, currency, status
      FROM flights
      WHERE departure_date = '2026-10-31'
    `);
    console.log('Flights on 2026-10-31:', fRes.rows);

    const novRes = await pool.query(`
      SELECT flight_id, flight_number, airline_code, origin, destination, departure_date, departure_time, arrival_time, aircraft_type, base_price, currency, status
      FROM flights
      WHERE departure_date = '2026-11-01'
      LIMIT 10
    `);
    console.log('Flights on 2026-11-01 count:', novRes.rows.length, 'sample:', novRes.rows[0]);
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

checkIndex();
