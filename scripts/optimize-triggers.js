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
    console.log('Optimizing count trigger function...');
    // Replace dynamic column loop query with a direct, ultra-fast pre-mapped single query
    await client.query(`
      CREATE OR REPLACE FUNCTION fn_increment_column_counts()
      RETURNS trigger AS $$
      DECLARE
        v_slot smallint;
      BEGIN
        -- Fast randomized slot to avoid row locks completely
        v_slot := floor(random() * 8)::smallint;

        -- Single bulk statement per insert instead of looping information_schema
        INSERT INTO table_column_counts (table_name, column_name, slot_id, row_count, updated_at)
        SELECT TG_TABLE_NAME, col.column_name, v_slot, 1, now()
        FROM (
          SELECT attname AS column_name
          FROM pg_attribute
          WHERE attrelid = TG_RELID AND attnum > 0 AND NOT attisdropped
        ) col
        ON CONFLICT (table_name, column_name, slot_id)
        DO UPDATE SET 
          row_count = table_column_counts.row_count + 1,
          updated_at = now();

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log('Function fn_increment_column_counts updated.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
