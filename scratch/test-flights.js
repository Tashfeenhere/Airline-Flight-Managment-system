const pool = require('../src/db/pool');

async function run() {
  try {
    const flights = await pool.query(`
      SELECT flight_id, flight_number, airline_code, origin, destination, departure_date,
             departure_time, arrival_time, aircraft_type, base_price, currency, status
      FROM flights
      ORDER BY departure_date ASC, departure_time ASC
      LIMIT 25
    `);
    console.log(`Loaded ${flights.rows.length} flights`);

    const flightIds = flights.rows.map(f => f.flight_id);
    const invRes = await pool.query(`
      SELECT flight_id, cabin, total_seats, available_seats, held_seats
      FROM flight_inventory
      WHERE flight_id = ANY($1)
    `, [flightIds]);
    console.log(`Loaded ${invRes.rows.length} inventory rows`);

    const invMap = {};
    for (const inv of invRes.rows) {
      if (!invMap[inv.flight_id]) invMap[inv.flight_id] = { availableSeats: 0, totalSeats: 0, cabins: [] };
      invMap[inv.flight_id].availableSeats += Number(inv.available_seats || 0);
      invMap[inv.flight_id].totalSeats += Number(inv.total_seats || 0);
      invMap[inv.flight_id].cabins.push(inv);
    }

    const merged = flights.rows.map(f => ({
      ...f,
      availableSeats: invMap[f.flight_id] ? invMap[f.flight_id].availableSeats : 0,
      totalSeats: invMap[f.flight_id] ? invMap[f.flight_id].totalSeats : 0,
      cabins: invMap[f.flight_id] ? invMap[f.flight_id].cabins : []
    }));

    console.log('Sample merged flight:', merged[0]);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

run();
