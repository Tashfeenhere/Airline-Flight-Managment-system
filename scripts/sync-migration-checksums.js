const pool = require('../src/db/pool');
const migrate = require('../src/db/migrate');

async function run() {
  for (const target of ['write', 'read']) {
    const p = target === 'read' ? pool.readPool : pool.writePool;
    for (const m of migrate.migrationsForTarget(target)) {
      const sum = migrate.checksumOf(m);
      await p.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [sum, m.id]);
    }
  }
  console.log('SYNC_COMPLETE');
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
