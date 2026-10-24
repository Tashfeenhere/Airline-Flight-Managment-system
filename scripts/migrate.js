#!/usr/bin/env node
/**
 * `npm run db:migrate` — applies pending migrations to the write and read models.
 *
 *   node scripts/migrate.js                 # apply everything pending
 *   node scripts/migrate.js --dry-run       # show what would run
 *   node scripts/migrate.js --target=write  # one target only
 *   node scripts/migrate.js --until=004     # stop after a version
 *   node scripts/migrate.js --status        # applied/pending/drift report
 *   node scripts/migrate.js --ignore-drift  # proceed despite edited migrations
 */
const migrate = require('../src/db/migrate');
const pool = require('../src/db/pool');
const env = require('../src/config/env');

function parseArgs(argv) {
  const args = { target: null, until: null, dryRun: false, status: false, ignoreDrift: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--status') args.status = true;
    else if (arg === '--ignore-drift') args.ignoreDrift = true;
    else if (arg.startsWith('--target=')) args.target = arg.split('=')[1];
    else if (arg.startsWith('--until=')) args.until = arg.split('=')[1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.status) {
    const report = await migrate.status();
    for (const [target, rows] of Object.entries(report)) {
      console.log(`\n[${target}] ${env[target === 'read' ? 'READMODEL_URL' : 'CITUS_COORDINATOR_URL'] ? '' : ''}`);
      for (const row of rows) {
        const mark = row.drift ? 'DRIFT' : row.applied ? 'applied' : 'pending';
        console.log(`  ${row.id} ${row.name.padEnd(32)} ${mark}`);
      }
    }
    return;
  }

  const options = { dryRun: args.dryRun, until: args.until, ignoreDrift: args.ignoreDrift };
  const result = args.target
    ? { [args.target]: await migrate.runMigrations(args.target, options) }
    : await migrate.runAll(options);

  let applied = 0;
  let pending = 0;
  for (const rows of Object.values(result)) {
    for (const row of rows) {
      if (row.status === 'applied') applied += 1;
      if (row.status === 'pending') pending += 1;
    }
  }

  console.log(
    `\nMigrations complete: ${applied} applied, ${pending} pending` +
      (args.dryRun ? ' (dry run — nothing was changed)' : '')
  );
}

main()
  .catch((err) => {
    console.error(`\nMigration failed: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.close();
  });
