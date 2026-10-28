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
    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'VIEW';
    `);
    for (const row of res.rows) {
      console.log('Dropping view:', row.table_name);
      await client.query(`DROP VIEW IF EXISTS "${row.table_name}" CASCADE;`);
    }
    console.log('Cleaned up synthetic views.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
