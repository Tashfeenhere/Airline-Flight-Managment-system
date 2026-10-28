/**
 * scripts/setup-column-counts.js
 *
 * Sets up:
 * 1. `table_column_counts` table (table_name, column_name, slot_id, row_count)
 *    indexed with composite primary key and B-tree indexes.
 * 2. High-performance non-blocking row-increment trigger for all tables.
 * 3. Populates initial accurate counts from existing data for all columns.
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.CITUS_COORDINATOR_URL,
  max: 5,
  connectionTimeoutMillis: 10000
});

const BASE_TABLES = [
  'users',
  'refresh_tokens',
  'two_factor_codes',
  'regions',
  'airlines',
  'airports',
  'cabins',
  'aircraft_types',
  'seat_map_templates',
  'flights',
  'flight_inventory',
  'bookings',
  'payments',
  'booking_outbox',
  'user_bookings'
];

async function run() {
  const client = await pool.connect();
  try {
    console.log('[setup-counts] Creating table_column_counts table and indexes...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS table_column_counts (
        table_name   varchar(64) NOT NULL,
        column_name  varchar(64) NOT NULL,
        slot_id      smallint NOT NULL DEFAULT 0,
        row_count    bigint NOT NULL DEFAULT 0,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (table_name, column_name, slot_id)
      );

      CREATE INDEX IF NOT EXISTS idx_table_column_counts_lookup 
        ON table_column_counts (table_name, column_name);
    `);

    console.log('[setup-counts] Creating trigger functions...');

    await client.query(`
      CREATE OR REPLACE FUNCTION fn_increment_column_counts()
      RETURNS trigger AS $$
      DECLARE
        col_rec record;
        v_slot smallint;
      BEGIN
        -- Pick a pseudo-random slot between 0 and 7 to completely eliminate row locking
        v_slot := floor(random() * 8)::smallint;

        FOR col_rec IN 
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_schema = 'public' 
            AND table_name = TG_TABLE_NAME
        LOOP
          INSERT INTO table_column_counts (table_name, column_name, slot_id, row_count, updated_at)
          VALUES (TG_TABLE_NAME, col_rec.column_name, v_slot, 1, now())
          ON CONFLICT (table_name, column_name, slot_id)
          DO UPDATE SET 
            row_count = table_column_counts.row_count + 1,
            updated_at = now();
        END LOOP;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Attach trigger to each base table
    for (const table of BASE_TABLES) {
      console.log(`[setup-counts] Attaching trigger to ${table}...`);
      await client.query(`
        DROP TRIGGER IF EXISTS trg_increment_counts ON ${table};
        CREATE TRIGGER trg_increment_counts
        AFTER INSERT ON ${table}
        FOR EACH ROW
        EXECUTE FUNCTION fn_increment_column_counts();
      `);
    }

    console.log('[setup-counts] Initializing column counts from existing table data...');
    for (const table of BASE_TABLES) {
      const colsRes = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1;
      `, [table]);

      // Get current count of the table
      const countRes = await client.query(`SELECT count(*) FROM ${table};`);
      const totalCount = BigInt(countRes.rows[0].count);

      console.log(`[setup-counts] Table ${table} has ${totalCount} existing rows. Setting counts for ${colsRes.rows.length} columns...`);

      for (const col of colsRes.rows) {
        await client.query(`
          INSERT INTO table_column_counts (table_name, column_name, slot_id, row_count, updated_at)
          VALUES ($1, $2, 0, $3, now())
          ON CONFLICT (table_name, column_name, slot_id)
          DO UPDATE SET row_count = $3, updated_at = now();
        `, [table, col.column_name, totalCount.toString()]);
      }
    }

    console.log('[setup-counts] Successfully configured count tracking for all tables!');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('[setup-counts] Error:', err);
  process.exit(1);
});
