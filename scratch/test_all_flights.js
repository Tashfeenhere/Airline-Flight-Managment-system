const { readReplicaPool, writePool } = require('../src/db/pool');

async function check() {
  const r = await writePool.query(`
    SELECT table_name FROM information_schema.views 
    WHERE table_schema = 'public' AND (table_name LIKE '%flights%' OR table_name LIKE '%40m%')
  `);
  console.log('Found views in writePool:', r.rows);
  const tables = await writePool.query(`
    SELECT relname, reltuples::bigint FROM pg_class 
    WHERE relname IN ('flights', 'flights_all', 'flight_inventory', 'flight_availability')
  `);
  console.log('WritePool table estimates:', tables.rows);

  const rViews = await readReplicaPool.query(`
    SELECT table_name FROM information_schema.views 
    WHERE table_schema = 'public' AND (table_name LIKE '%flights%' OR table_name LIKE '%40m%')
  `);
  console.log('Found views in readReplicaPool:', rViews.rows);

  const rTables = await readReplicaPool.query(`
    SELECT relname, reltuples::bigint FROM pg_class 
    WHERE relname IN ('flights', 'flights_all', 'flight_inventory', 'flight_availability')
  `);
  console.log('ReadReplica table estimates:', rTables.rows);

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
