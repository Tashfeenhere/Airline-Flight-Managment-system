const pool = require('../src/db/pool');

async function test() {
  const t0 = Date.now();
  const { rows } = await pool.writePool.query(`
    WITH active_flights AS (
      SELECT DISTINCT flight_id FROM bookings WHERE status IN ('PENDING', 'CONFIRMED')
    ), inv AS (
      SELECT flight_id, departure_date, cabin,
             SUM(total_seats)::int AS total_seats,
             SUM(available_seats)::int AS available_seats,
             SUM(held_seats)::int AS held_seats
        FROM flight_inventory
       WHERE flight_id IN (SELECT flight_id FROM active_flights)
       GROUP BY flight_id, departure_date, cabin
    )
    SELECT count(*) FROM inv
  `);
  console.log(`Active booked flights checked: ${rows[0].count} in ${Date.now() - t0}ms`);
  process.exit(0);
}

test().catch((e) => {
  console.error(e);
  process.exit(1);
});
