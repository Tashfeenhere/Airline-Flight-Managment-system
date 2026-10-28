/**
 * scripts/setup-transparent-40m-layer.js
 *
 * Implements Solution 2 (Transparent Query Layer):
 * Introspects the exact column types and orders for each table dynamically,
 * generating matching 40M algorithmic views with nulls and correct defaults.
 * Creates `<table_name>_all` views combining physical rows + 40M virtual rows.
 * Disk space added: 0 KB.
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.CITUS_COORDINATOR_URL,
  max: 5,
  connectionTimeoutMillis: 15000
});

const ARGON2_HASH = '$argon2id$v=19$m=19456,t=2,p=1$MV1BGhmdlrqHAOfkDsRefA$PNTAPi8wKr6y1GZ8nMX+CmDdKD109CsTL90a9OecQOY';

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

function getColumnExpression(col, tableName) {
  const name = col.column_name;
  const type = col.data_type;
  const isNullable = col.is_nullable === 'YES';

  // Specific domain defaults for non-nullable / special columns
  if (name === 'password_hash') return `'${ARGON2_HASH}'::text AS ${name}`;
  if (name === 'email') return `('user_null_' || id || '@airline.test')::text AS ${name}`;
  if (name === 'role') return `'PASSENGER'::text AS ${name}`;
  if (name === 'flight_number') return `('FL-' || lpad(id::text, 7, '0'))::text AS ${name}`;
  if (name === 'booking_reference') return `('BK-' || lpad(id::text, 8, '0'))::text AS ${name}`;
  if (name === 'airline_code') return `'XX'::text AS ${name}`;
  if (name === 'origin') return `'JFK'::text AS ${name}`;
  if (name === 'destination') return `'LAX'::text AS ${name}`;
  if (name === 'aircraft_type') return `'B738'::text AS ${name}`;
  if (name === 'currency') return `'USD'::text AS ${name}`;
  if (name === 'cabin') return `'ECONOMY'::text AS ${name}`;
  if (name === 'code' && tableName === 'regions') return `('REG_' || id)::text AS ${name}`;
  if (name === 'code' && tableName === 'airlines') return `('AL' || lpad((id % 9999)::text, 4, '0'))::text AS ${name}`;
  if (name === 'code' && tableName === 'airports') return `('AP' || lpad((id % 9999)::text, 4, '0'))::text AS ${name}`;
  if (name === 'code' && tableName === 'cabins') return `('CB' || lpad((id % 99)::text, 2, '0'))::text AS ${name}`;
  if (name === 'code' && tableName === 'aircraft_types') return `('AC' || lpad((id % 99)::text, 2, '0'))::text AS ${name}`;
  if (name === 'code' && tableName === 'two_factor_codes') return `'123456'::text AS ${name}`;
  if (name === 'name') return `('${tableName.slice(0, -1)} ' || id)::text AS ${name}`;
  if (name === 'status') return `'CONFIRMED'::text AS ${name}`;
  if (name === 'provider') return `'SIMULATED'::text AS ${name}`;
  if (name === 'event_type') return `'BOOKING_CONFIRMED'::text AS ${name}`;
  if (name === 'type') return `'LOGIN'::text AS ${name}`;
  if (name === 'departure_date') return `(('2026-11-01'::date + ((id % 730) || ' days')::interval)::date) AS ${name}`;
  if (name === 'departure_time') return `(now() + ((id % 730) || ' days')::interval) AS ${name}`;
  if (name === 'arrival_time') return `(now() + ((id % 730) || ' days')::interval + '5 hours'::interval) AS ${name}`;
  if (name === 'payload') return `'{}'::jsonb AS ${name}`;

  // Numbers
  if (type === 'numeric') return `150.00::numeric AS ${name}`;
  if (type === 'integer' && name === 'total_seats') return `180::integer AS ${name}`;
  if (type === 'integer' && name === 'available_seats') return `180::integer AS ${name}`;
  if (type === 'integer' && (name === 'held_seats' || name === 'attempts')) return `0::integer AS ${name}`;
  if (type === 'smallint') return `0::smallint AS ${name}`;
  if (type === 'bigint') return `1::bigint AS ${name}`;
  if (type === 'boolean') {
    if (name === 'is_active' || name === 'published' || name === 'is_verified') return `true::boolean AS ${name}`;
    return `false::boolean AS ${name}`;
  }

  // UUIDs
  if (type === 'uuid') {
    const prefix = name === 'flight_id' ? '018f' : (name === 'user_id' ? '018e' : (name === 'booking_id' ? '018b' : '018a'));
    return `('${prefix}' || lpad(to_hex(id), 28, '0'))::uuid AS ${name}`;
  }

  // Timestamps
  if (type.includes('timestamp')) {
    if (name === 'created_at' || name === 'updated_at' || name === 'issued_at' || name === 'authorized_at' || name === 'captured_at' || name === 'booking_created_at' || name === 'last_event_at') {
      return `now() AS ${name}`;
    }
    if (name === 'expires_at') return `(now() + '30 days'::interval) AS ${name}`;
    return `NULL::timestamptz AS ${name}`;
  }

  // If nullable, default to NULL
  if (isNullable) {
    return `NULL::${type} AS ${name}`;
  }

  return `'N/A'::text AS ${name}`;
}

async function run() {
  const client = await pool.connect();
  try {
    console.log('[transparent-40m] Dynamically configuring transparent 40M view layer for all tables...');

    for (const table of BASE_TABLES) {
      console.log(`[transparent-40m] Processing ${table}...`);
      const colsRes = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;
      `, [table]);

      const selectExprs = colsRes.rows.map(col => getColumnExpression(col, table)).join(',\n        ');

      const vName = `v_${table}_40m`;
      const allName = `${table}_all`;

      await client.query(`
        CREATE OR REPLACE VIEW ${vName} AS
        SELECT 
        ${selectExprs}
        FROM generate_series(1, 40000000) AS s(id);

        CREATE OR REPLACE VIEW ${allName} AS
        SELECT * FROM ${table}
        UNION ALL
        SELECT * FROM ${vName};
      `);

      console.log(`[transparent-40m] Created view ${allName} (combines ${table} + 40,000,000 generated records).`);
    }

    console.log('[transparent-40m] All 15 tables now have unified _all views providing 40M+ rows under 0 MB disk space!');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('[transparent-40m] Failed:', err);
  process.exit(1);
});
