#!/usr/bin/env node
/**
 * `npm run db:setup` — the one-command bootstrap for the two databases this service
 * needs, so a fresh checkout goes from "server is reachable" to "schema is applied"
 * without anyone remembering the right psql incantations:
 *
 *   airline_inventory  write model  (Citus coordinator; bookings, inventory, users...)
 *   airline_read       read model   (search / availability projection)
 *
 * What it does, in order, for each database:
 *   1. Connect to the maintenance database (`postgres`) on the same server, because
 *      CREATE DATABASE / CREATE ROLE are cluster-level operations and CREATE DATABASE
 *      cannot run inside a transaction block. It is issued on a plain autocommit
 *      `pg` client, never through `pool.withTransaction`.
 *   2. Ensure the login role named in the connection URL exists (created only when the
 *      maintenance connection was made with a different, superuser identity — see
 *      `--admin-url`).
 *   3. Create the database if it is missing.
 *   4. Connect to the database and enable the extensions the schema feature-detects
 *      (citus, pg_partman, pgcrypto) — only those this server actually ships.
 *   5. Run the migrations for that database through the existing runner
 *      (`src/db/migrate.js`), which records each migration's checksum per database.
 *
 * IDEMPOTENCE is the point. Every step is a guarded check-then-act, so running this
 * twice in a row is a no-op the second time and running it against an already-built
 * database reports "already present" for everything instead of failing. That is what
 * makes it safe to put in front of `db:migrate` in a bootstrap script.
 *
 * --reset is the destructive exception: it drops both databases first. It refuses
 * without --force, because the drop takes every flight, booking and payment with it.
 *
 * Usage:
 *   node scripts/db-setup.js                 # create anything missing, then migrate
 *   node scripts/db-setup.js --only=read     # one database only (write|read|db name)
 *   node scripts/db-setup.js --dry-run       # report planned changes, change nothing
 *   node scripts/db-setup.js --reset --force # DROP both databases, recreate, migrate
 *   node scripts/db-setup.js --help
 *
 * Exit codes: 0 success, 1 failure, 2 usage error (including a refusal to reset).
 *
 * The bootstrap always talks to `CITUS_COORDINATOR_URL` directly, never to
 * `PGBOUNCER_URL`: PgBouncer is a transaction-pooler for queries and cannot run DDL.
 * The migration runner's own pooled connections do honour `PGBOUNCER_URL`.
 */
'use strict';

const { Client } = require('pg');

const env = require('../src/config/env');
const pool = require('../src/db/pool');
const migrate = require('../src/db/migrate');

/**
 * Every PostgreSQL server ships this cluster-level database, and it is the only place
 * CREATE DATABASE / CREATE ROLE can be issued from — you cannot drop the database you
 * are connected to.
 */
const MAINTENANCE_DATABASE = 'postgres';

/**
 * Extensions the schema feature-detects, ordered by how much the topology depends on
 * them. `citus` decides distributed-vs-local placement; `pg_partman` is used when
 * present but the migration set ships plain-DDL partition helpers as a fallback; and
 * `pgcrypto` backs digest()/hmac() in reporting (migration 001 also creates it, so this
 * is belt-and-suspenders). Only extensions present in pg_available_extensions are
 * enabled — a vanilla PostgreSQL simply does not ship citus, and skipping it is
 * expected, not an error.
 */
const REQUIRED_EXTENSIONS = Object.freeze(['citus', 'pg_partman', 'pgcrypto']);

const OUTCOME_LABELS = Object.freeze({
  created: '[CREATE]',
  skipped: '[  OK  ]',
  planned: '[ PLAN ]',
  dropped: '[ DROP ]',
  warn: '[ WARN ]',
  failed: '[ FAIL ]'
});

/**
 * The extension whose absence changes the *topology* rather than just an optimisation.
 *
 * `pg_partman` and `pgcrypto` are conveniences the migration set has fallbacks for, so
 * failing to enable them is a warning. `citus` is not: without it the schema applies to
 * plain local tables, and every co-location and sharding guarantee the plan is built on
 * quietly stops existing. A bootstrap that reported success there would hand the
 * operator a single-node database wearing a distributed architecture's name.
 */
const TOPOLOGY_EXTENSION = 'citus';

const HELP = `db-setup — bootstrap the write and read databases, then migrate them.

Usage:
  node scripts/db-setup.js [options]

Options:
  --reset            Drop both databases before recreating them. Destroys all data;
                     requires --force.
  --force            Required acknowledgement for --reset.
  --only <target>    Operate on one database only: 'write', 'read', or the configured
                     database name (e.g. airline_inventory, airline_read).
  --dry-run          Connect and report what would happen; change nothing.
  --admin-url <url>  Superuser connection URL used only when the URL's own role is
                     missing and cannot connect (fresh cluster). Optional.
  -h, --help         Show this help.

Exit codes:
  0  success
  1  failure (a step could not be completed)
  2  usage error, including --reset without --force
`;

/** Identifier quoting for DDL, which cannot take bind parameters. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Literal quoting for a password embedded in DDL. standard_conforming_strings is on by
 * default, so doubling single quotes is the correct escape; we deliberately never emit
 * an E'' string, which would make backslashes special.
 */
function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Turns a connection URL into a `pg` client config, optionally retargeting it at a
 * different database. The SSL intent is read from `sslmode` the same way `pool.js`
 * does, so operator tooling and the application agree on when the wire is encrypted.
 */
function connectionInfo(url, databaseOverride) {
  const parsed = new URL(url);
  const database =
    databaseOverride || (parsed.pathname || '').replace(/^\//, '') || MAINTENANCE_DATABASE;

  const info = {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
    user: decodeURIComponent(parsed.username),
    database
  };
  if (parsed.password) info.password = decodeURIComponent(parsed.password);
  if (/sslmode=(require|verify-ca|verify-full)/.test(url)) {
    info.ssl = { rejectUnauthorized: /verify-(ca|full)/.test(url) };
  }
  return info;
}

function connectionConfig(url, databaseOverride) {
  return {
    ...connectionInfo(url, databaseOverride),
    application_name: `${env.NODE_ID}-db-setup`
  };
}

/**
 * Resolves the write and read targets from the environment. The write target is the
 * coordinator URL itself (not PgBouncer) because bootstrap issues DDL; the read target
 * is wherever READMODEL_URL points.
 *
 * Each target keeps the original connection string as well as its parsed parts.
 * `connectionInfo()` returns host/port/user/database and nothing else, so the rest of
 * the script can read `target.host` for a message and still needs `target.url` to open
 * the second connection to this database (`ensureExtensions`) or to the maintenance
 * database (`connectMaintenance`). Carrying the string here is what makes those two
 * call sites total — rebuilding a URL from the parsed parts would silently drop query
 * parameters such as `sslmode`.
 */
function buildTargets() {
  const write = {
    key: 'write',
    label: 'write model (Citus coordinator)',
    url: env.CITUS_COORDINATOR_URL,
    ...connectionInfo(env.CITUS_COORDINATOR_URL)
  };
  const read = {
    key: 'read',
    label: 'read model (search projection)',
    url: env.READMODEL_URL,
    ...connectionInfo(env.READMODEL_URL)
  };
  return { write, read };
}

/** Applies --only, accepting the role name or the configured database name. */
function selectTargets(only) {
  const all = buildTargets();
  if (!only) return [all.write, all.read];

  const normalized = String(only).trim().toLowerCase();
  const aliases = {
    write: 'write',
    read: 'read',
    [all.write.database.toLowerCase()]: 'write',
    [all.read.database.toLowerCase()]: 'read'
  };
  const key = aliases[normalized];
  if (!key) {
    throw new Error(
      `Unknown --only target '${only}'. Use 'write', 'read', '${all.write.database}' or '${all.read.database}'.`
    );
  }
  return [all[key]];
}

function parseArgs(argv) {
  const args = {
    help: false,
    reset: false,
    force: false,
    dryRun: false,
    only: null,
    adminUrl: null,
    error: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--reset') args.reset = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--only') {
      args.only = argv[index + 1];
      index += 1;
      if (args.only === undefined) args.error = '--only requires a value';
    } else if (arg.startsWith('--only=')) args.only = arg.slice('--only='.length);
    else if (arg === '--admin-url') {
      args.adminUrl = argv[index + 1];
      index += 1;
      if (args.adminUrl === undefined) args.error = '--admin-url requires a value';
    } else if (arg.startsWith('--admin-url=')) args.adminUrl = arg.slice('--admin-url='.length);
    else if (arg.startsWith('-')) args.error = `Unknown option '${arg}'`;
    else args.error = `Unexpected argument '${arg}'`;
  }

  return args;
}

/** Collects per-step outcomes and the counts the final summary reports. */
function createReporter(dryRun) {
  const totals = { created: 0, skipped: 0, planned: 0, dropped: 0, warn: 0, failed: 0 };

  return {
    heading(text) {
      console.log(`\n${text}`);
    },
    detail(text) {
      console.log(`    ${text}`);
    },
    result(kind, name, outcome, message) {
      totals[outcome] = (totals[outcome] || 0) + 1;
      console.log(`  ${OUTCOME_LABELS[outcome] || outcome} ${kind} ${name}: ${message}`);
    },
    totals,
    summary() {
      const parts = [
        `${totals.created} created`,
        `${totals.skipped} already in place`,
        `${totals.dropped} dropped`,
        `${totals.planned} planned`
      ];
      if (totals.warn > 0) parts.push(`${totals.warn} warning(s)`);
      if (totals.failed > 0) parts.push(`${totals.failed} FAILURE(S)`);
      console.log(`\nSummary: ${parts.join(', ')}${dryRun ? ' (dry run — nothing was changed)' : ''}`);
      if (totals.failed > 0) {
        // Said explicitly, because the exit code alone is easy to lose in a wall of
        // bootstrap output and the consequence here is a database that is not what the
        // rest of the deployment assumes it is.
        console.error(
          '\nThe bootstrap did not produce the documented topology. Fix the failures above and re-run.'
        );
      }
    }
  };
}

/**
 * Opens a maintenance-database connection for a target.
 *
 * The primary attempt uses the target's own credentials. When that fails because the
 * login role does not exist (SQLSTATE 28000) or its password is rejected (28P01) and an
 * admin URL was supplied, the admin identity is used instead — that is the only way a
 * missing role can be created, since you cannot log in as a role that is not there.
 */
async function connectMaintenance(target, adminUrl) {
  const primary = connectionConfig(target.url, MAINTENANCE_DATABASE);
  const client = new Client(primary);
  try {
    await client.connect();
    return { client, connectedAs: primary.user };
  } catch (err) {
    if (!['28000', '28P01'].includes(err.code) || !adminUrl) throw err;
  }

  const admin = connectionConfig(adminUrl, MAINTENANCE_DATABASE);
  const adminClient = new Client(admin);
  await adminClient.connect();
  return { client: adminClient, connectedAs: admin.user };
}

/** Creates the login role the connection URL names, if it is missing. */
async function ensureRole(client, target, { dryRun }, reporter) {
  const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [target.user]);
  if (rows.length > 0) {
    reporter.result('role', target.user, 'skipped', 'already present');
    return;
  }

  if (dryRun) {
    reporter.result('role', target.user, 'planned', 'would be created with LOGIN');
    return;
  }

  // Reachable only when the maintenance connection used a different (superuser)
  // identity: connecting as this role would have failed otherwise. DDL takes no bind
  // parameters, so the name and password are quoted as identifiers/literals above.
  const passwordClause = target.password ? ` PASSWORD ${quoteLiteral(target.password)}` : '';
  await client.query(`CREATE ROLE ${quoteIdent(target.user)} WITH LOGIN${passwordClause}`);
  reporter.result('role', target.user, 'created', 'created with LOGIN');
}

/**
 * Drops (on --reset) and/or creates the target database.
 *
 * @returns {Promise<boolean>} whether the database exists after this step. In a dry run
 *   that is its current state, since nothing was changed.
 */
async function ensureDatabase(client, target, { reset, dryRun }, reporter) {
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    target.database
  ]);
  const existed = rows.length > 0;

  if (reset && existed) {
    if (dryRun) {
      reporter.result('database', target.database, 'planned', 'would be dropped (--reset)');
    } else {
      // WITH (FORCE) terminates other sessions so the drop cannot hang behind a
      // leftover API/worker connection. No transaction is open on this client, which
      // is required: DROP DATABASE is rejected inside a transaction block.
      await client.query(`DROP DATABASE ${quoteIdent(target.database)} WITH (FORCE)`);
      reporter.result('database', target.database, 'dropped', 'dropped (--reset)');
    }
  }

  if (reset || !existed) {
    if (dryRun) {
      reporter.result('database', target.database, 'planned', 'would be created');
      return existed;
    }

    try {
      await client.query(`CREATE DATABASE ${quoteIdent(target.database)}`);
      reporter.result(
        'database',
        target.database,
        'created',
        existed ? 'recreated' : 'created'
      );
    } catch (err) {
      // A parallel db-setup won the race between our check and this statement. The
      // database exists now, which is the outcome we wanted, so this is not an error.
      if (err.code === '42P04') {
        reporter.result('database', target.database, 'skipped', 'created concurrently by another session');
      } else {
        throw err;
      }
    }
    return true;
  }

  reporter.result('database', target.database, 'skipped', 'already present');
  return true;
}

/** Enables whichever of the required extensions this server ships but lacks. */
async function ensureExtensions(target, { dryRun }, reporter) {
  const client = new Client(connectionConfig(target.url, target.database));
  await client.connect();

  try {
    const [available, installed] = await Promise.all([
      client.query('SELECT name FROM pg_available_extensions WHERE name = ANY($1::text[])', [
        REQUIRED_EXTENSIONS
      ]),
      client.query('SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])', [
        REQUIRED_EXTENSIONS
      ])
    ]);
    const availableSet = new Set(available.rows.map((row) => row.name));
    const installedSet = new Set(installed.rows.map((row) => row.extname));

    for (const extension of REQUIRED_EXTENSIONS) {
      if (!availableSet.has(extension)) {
        // Not shipped with this server (a vanilla PostgreSQL has no citus). The schema
        // degrades to local tables, so this is an expected skip rather than a failure.
        reporter.result('extension', extension, 'skipped', 'not available on this server');
        continue;
      }
      if (installedSet.has(extension)) {
        reporter.result('extension', extension, 'skipped', 'already present');
        continue;
      }
      if (dryRun) {
        reporter.result('extension', extension, 'planned', 'would be enabled');
        continue;
      }

      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)}`);
        reporter.result('extension', extension, 'created', 'enabled');
      } catch (err) {
        // e.g. citus is present as a package but the server was not started with it in
        // shared_preload_libraries.
        //
        // citus failing is a FAILURE, not a warning: the schema still applies, but it
        // applies to local tables, so the run has produced a single-node database and
        // exit 0 would describe that as a successful bootstrap of a distributed one.
        // The other extensions degrade to documented fallbacks, so they stay warnings.
        const fatal = extension === TOPOLOGY_EXTENSION;
        reporter.result(
          'extension',
          extension,
          fatal ? 'failed' : 'warn',
          `could not be enabled: ${err.message}`
        );
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * Whether this database has been migrated before, probed with the same unqualified
 * name the migration runner uses, so `search_path` resolves it identically.
 */
async function migrationTableExists(target) {
  const client = new Client(connectionConfig(target.url, target.database));
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT to_regclass('schema_migrations') AS present`);
    return rows[0].present !== null;
  } finally {
    await client.end();
  }
}

/** Runs pending migrations for one target through the shared runner. */
async function runMigrations(target, { dryRun }, reporter) {
  // `migrate.runMigrations` creates `schema_migrations` before it ever looks at
  // `dryRun` (migrate.js runs `ensureMigrationTable` first, unconditionally), so a dry
  // run against a database that has never been migrated would leave that table behind
  // — the one thing `--dry-run` promises not to do. When the table is absent there is
  // also nothing recorded to compare against: every migration is pending by
  // definition, so the arithmetic the runner would do yields the same answer it can be
  // told here, without touching the database. (The shared runner is not modified: it is
  // used by `db:migrate` too, where creating the table is the whole point.)
  if (dryRun && !(await migrationTableExists(target))) {
    const pending = migrate.migrationsForTarget(target.key).length;
    reporter.detail('no schema_migrations table yet, so every migration is pending');
    reporter.result(
      'migrations',
      target.key,
      'planned',
      `${pending} pending (dry run, not inspected)`
    );
    return;
  }

  const rows = await migrate.runMigrations(target.key, {
    dryRun,
    // Route the runner's progress through human-readable output instead of its default
    // JSON logger; an operator running bootstrap by hand is the audience here.
    log: (message) => reporter.detail(message)
  });

  const applied = rows.filter((row) => row.status === 'applied').length;
  const already = rows.filter((row) => row.status === 'already-applied').length;
  const pending = rows.filter((row) => row.status === 'pending').length;

  reporter.result(
    'migrations',
    target.key,
    applied > 0 ? 'created' : 'skipped',
    `${applied} applied, ${already} already applied, ${pending} pending`
  );
}

/** Everything for one target database, from maintenance connection to migrations. */
async function setupTarget(target, options, reporter) {
  const { reset, dryRun, adminUrl } = options;

  reporter.heading(`[${target.key}] ${target.database}  (${target.label})`);
  reporter.detail(`server ${target.host}:${target.port}`);

  const maintenance = await connectMaintenance(target, adminUrl);
  let databaseReady = false;
  try {
    reporter.detail(`connected to '${MAINTENANCE_DATABASE}' as '${maintenance.connectedAs}'`);
    await ensureRole(maintenance.client, target, { dryRun }, reporter);
    databaseReady = await ensureDatabase(maintenance.client, target, { reset, dryRun }, reporter);
  } finally {
    await maintenance.client.end();
  }

  if (!databaseReady) {
    reporter.result('migrations', target.key, 'skipped', 'database does not exist yet (dry run)');
    return;
  }

  await ensureExtensions(target, { dryRun }, reporter);
  await runMigrations(target, { dryRun }, reporter);
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.error) {
    console.error(args.error);
    console.error('Run with --help for usage.');
    return 2;
  }
  if (args.reset && !args.force) {
    console.error('--reset drops both databases and destroys all their data.');
    console.error('Re-run as: node scripts/db-setup.js --reset --force');
    return 2;
  }

  let targets;
  try {
    targets = selectTargets(args.only);
  } catch (err) {
    console.error(err.message);
    console.error('Run with --help for usage.');
    return 2;
  }

  const reporter = createReporter(args.dryRun);
  console.log('db-setup — bootstrap the write and read databases');
  if (args.dryRun) console.log('(dry run — no database, role or extension will be changed)');
  if (args.reset) console.log('(reset requested — both databases will be dropped and recreated)');

  for (const target of targets) {
    await setupTarget(target, { reset: args.reset, dryRun: args.dryRun, adminUrl: args.adminUrl }, reporter);
  }

  reporter.summary();
  // A step that could not be completed makes this a failed bootstrap, whatever else
  // succeeded: the very next command in a bootstrap script assumes the topology this
  // one was supposed to have built.
  return reporter.totals.failed > 0 ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\ndb-setup failed: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Reached on success, failure and early return alike, so no pooled connection can
    // keep the process alive after the work is done.
    await pool.close();
  });
