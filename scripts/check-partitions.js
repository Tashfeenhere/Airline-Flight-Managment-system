const pool = require('../src/db/pool');

async function checkPartitions() {
  try {
    const res = await pool.query(`
      SELECT inhrelid::regclass AS partition_name
      FROM pg_inherits
      JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
      WHERE parent.relname = 'flights'
      ORDER BY partition_name;
    `);
    console.log('Flight partitions:', res.rows.map(r => r.partition_name));

    for (const r of res.rows.slice(0, 5)) {
      const cnt = await pool.query(`SELECT count(*) FROM ${r.partition_name}`);
      console.log(`Count in ${r.partition_name}:`, cnt.rows[0].count);
    }
  } catch (err) {
    console.error('Err:', err.message);
  } finally {
    process.exit(0);
  }
}

checkPartitions();
