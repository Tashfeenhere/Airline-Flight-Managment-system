const pool = require('../src/db/pool');

async function check() {
  try {
    const fRes = await pool.query('SELECT flight_id, flight_number, origin, destination, departure_date, base_price, status FROM flights LIMIT 5');
    console.log('Flights:', fRes.rows);

    const f1 = fRes.rows[0];
    const invRes = await pool.query('SELECT cabin, total_seats, available_seats FROM flight_inventory WHERE flight_id = $1 AND departure_date = $2', [f1.flight_id, f1.departure_date]);
    console.log('Inv for f1:', invRes.rows);
  } catch(e) {
    console.error('Check Error:', e);
  } finally {
    process.exit(0);
  }
}
check();
