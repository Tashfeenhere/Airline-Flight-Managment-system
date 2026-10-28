require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.CITUS_COORDINATOR_URL,
  max: 2,
  connectionTimeoutMillis: 10000
});

async function main() {
  const client = await pool.connect();
  try {
    const before = await client.query('SELECT count(*) FROM flights_p202701;');
    console.log('Before count in flights_p202701:', before.rows[0].count);

    console.time('insert_10k');
    await client.query(`
      INSERT INTO flights (
        flight_id, flight_number, airline_code, origin, destination,
        departure_date, departure_time, arrival_time, aircraft_type,
        base_price, currency, status, region
      )
      SELECT 
        ('018f' || lpad(to_hex(id), 28, '0'))::uuid,
        'PK' || (1000 + (id % 9000)),
        'PK',
        'ISB',
        'DXB',
        '2027-01-15'::date,
        '2027-01-15 06:00:00+00'::timestamptz,
        '2027-01-15 09:30:00+00'::timestamptz,
        'A320',
        150.00,
        'USD',
        'SCHEDULED',
        NULL
      FROM generate_series(1, 10000) AS s(id);
    `);
    console.timeEnd('insert_10k');

    const after = await client.query('SELECT count(*) FROM flights_p202701;');
    console.log('After count in flights_p202701:', after.rows[0].count);

    const size = await client.query("SELECT pg_size_pretty(pg_total_relation_size('flights_p202701')) as sz;");
    console.log('Partition size for 10k rows:', size.rows[0].sz);

    // Clean up test batch
    await client.query(`
      DELETE FROM flights 
      WHERE departure_date = '2027-01-15' 
        AND flight_id >= '018f0000-0000-0000-0000-000000000000'::uuid 
        AND flight_id <= '018f0000-0000-0000-0000-000000010000'::uuid;
    `);
    console.log('Test batch cleaned up.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
