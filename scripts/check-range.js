const pool = require('../src/db/pool');

async function checkDateRange() {
  try {
    const fRes = await pool.query(`
      SELECT f.flight_id, f.flight_number, f.airline_code, f.origin, f.destination,
             f.departure_date, f.departure_time, f.arrival_time, f.aircraft_type,
             f.base_price, f.currency, f.status
      FROM flights f
      WHERE departure_date >= '2026-10-24' AND departure_date <= '2026-11-05'
      ORDER BY departure_date ASC, departure_time ASC
      LIMIT 100
    `);
    console.log('Flights between 2026-10-24 and 2026-11-05 count:', fRes.rows.length);

    // Get inventory
    const ids = fRes.rows.map(r => r.flight_id);
    const dates = fRes.rows.map(r => r.departure_date);
    
    // Check inventory for these
    const invRes = await pool.query(`
      SELECT flight_id, departure_date, cabin, total_seats, available_seats, held_seats
      FROM flight_inventory
      WHERE departure_date >= '2026-10-24' AND departure_date <= '2026-11-05'
      LIMIT 500
    `);
    console.log('Inv rows count:', invRes.rows.length);
  } catch (err) {
    console.error('Err:', err.message);
  } finally {
    process.exit(0);
  }
}

checkDateRange();
