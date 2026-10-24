#!/usr/bin/env node
/**
 * Local PostgreSQL cluster manager (no Docker required).
 *
 * Production runs on a Citus cluster (see `docker-compose.yml`). This script is the
 * developer/test equivalent for machines without Docker: it creates a throwaway
 * PostgreSQL cluster under `.pgdata/` on a non-default port so it can never collide
 * with an existing PostgreSQL service, starts/stops it, and creates the two
 * databases the architecture needs:
 *
 *   airline_inventory  -> write model   (Citus coordinator in production)
 *   airline_read       -> read model    (search / availability projection)
 *
 * Usage:
 *   npm run db:local:start     # initdb (once) + start + create databases
 *   npm run db:local:stop
 *   npm run db:local:status
 *
 * On a Citus cluster these databases are created by `db/migrations/001_*` instead;
 * the migration runner detects whether the `citus` extension is available and
 * adapts (distributed/reference tables vs. plain local tables).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PGDATA = process.env.LOCAL_PGDATA || path.join(ROOT, '.pgdata');
const LOGFILE = path.join(ROOT, '.pgdata.log');
const PORT = Number.parseInt(process.env.LOCAL_PG_PORT || '55432', 10);
const SUPERUSER = process.env.LOCAL_PG_USER || 'airline';
const PASSWORD = process.env.LOCAL_PG_PASSWORD || 'airline';
const HOST = '127.0.0.1';
const DATABASES = ['airline_inventory', 'airline_read'];

function fail(message) {
  console.error(`[db:local] ${message}`);
  process.exit(1);
}

/** Locates the PostgreSQL client/server binaries. */
function resolveBinDir() {
  if (process.env.PG_BIN) return process.env.PG_BIN;

  const candidates = [];
  const fromPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pg_config'], {
    encoding: 'utf8'
  });
  if (fromPath.status === 0 && fromPath.stdout.trim()) {
    const pgConfig = fromPath.stdout.trim().split(/\r?\n/)[0];
    const bindir = spawnSync(pgConfig, ['--bindir'], { encoding: 'utf8' });
    if (bindir.status === 0 && bindir.stdout.trim()) candidates.push(bindir.stdout.trim());
  }

  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pgRoot = path.join(programFiles, 'PostgreSQL');
    if (fs.existsSync(pgRoot)) {
      for (const version of fs.readdirSync(pgRoot).sort().reverse()) {
        candidates.push(path.join(pgRoot, version, 'bin'));
      }
    }
  } else {
    candidates.push('/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/17/bin', '/usr/local/bin');
  }

  for (const candidate of candidates) {
    const exe = path.join(candidate, process.platform === 'win32' ? 'initdb.exe' : 'initdb');
    if (fs.existsSync(exe)) return candidate;
  }

  fail(
    'Could not find PostgreSQL binaries. Install PostgreSQL, or set PG_BIN to its bin directory.'
  );
  return null;
}

const BIN = resolveBinDir();
const exe = (name) => path.join(BIN, process.platform === 'win32' ? `${name}.exe` : name);

function run(command, args, options = {}) {
  return execFileSync(exe(command), args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, PGPASSWORD: PASSWORD },
    ...options
  });
}

function psql(database, sql, { capture = true } = {}) {
  const args = [
    '-h',
    HOST,
    '-p',
    String(PORT),
    '-U',
    SUPERUSER,
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-tAc',
    sql
  ];
  const result = spawnSync(exe('psql'), args, {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: PASSWORD }
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    if (!capture) fail(message);
    throw new Error(message || `psql failed (${result.status})`);
  }
  return (result.stdout || '').trim();
}

function isInitialized() {
  return fs.existsSync(path.join(PGDATA, 'PG_VERSION'));
}

function isRunning() {
  const result = spawnSync(exe('pg_ctl'), ['-D', PGDATA, 'status'], { encoding: 'utf8' });
  return result.status === 0;
}

function writePasswordFile() {
  const file = path.join(os.tmpdir(), `pg-pwfile-${process.pid}`);
  fs.writeFileSync(file, PASSWORD, { mode: 0o600 });
  return file;
}

function initialize() {
  if (isInitialized()) return;

  console.log(`[db:local] initdb -> ${PGDATA}`);
  fs.mkdirSync(PGDATA, { recursive: true });
  const pwfile = writePasswordFile();
  try {
    run('initdb', [
      '-D',
      PGDATA,
      '-U',
      SUPERUSER,
      '--pwfile',
      pwfile,
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
      '--encoding=UTF8',
      '--locale=C'
    ]);
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
}

function start() {
  initialize();

  if (isRunning()) {
    console.log(`[db:local] already running on ${HOST}:${PORT}`);
  } else {
    console.log(`[db:local] starting PostgreSQL on ${HOST}:${PORT}`);
    run('pg_ctl', [
      '-D',
      PGDATA,
      '-l',
      LOGFILE,
      '-o',
      `-p ${PORT} -c listen_addresses=${HOST} -c max_connections=200 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
      '-w',
      '-t',
      '60',
      'start'
    ]);
  }

  // Wait for the server to accept connections.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = spawnSync(exe('pg_isready'), ['-h', HOST, '-p', String(PORT), '-U', SUPERUSER], {
      encoding: 'utf8'
    });
    if (ready.status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }

  for (const database of DATABASES) {
    const exists = psql('postgres', `SELECT 1 FROM pg_database WHERE datname='${database}'`);
    if (exists !== '1') {
      console.log(`[db:local] creating database ${database}`);
      run('createdb', ['-h', HOST, '-p', String(PORT), '-U', SUPERUSER, database]);
    }
  }

  const version = psql('airline_inventory', 'SHOW server_version');
  console.log(`[db:local] ready (PostgreSQL ${version}) -> postgres://${SUPERUSER}:***@${HOST}:${PORT}/airline_inventory`);
}

function stop() {
  if (!isInitialized()) {
    console.log('[db:local] no local cluster found; nothing to stop');
    return;
  }
  if (!isRunning()) {
    console.log('[db:local] already stopped');
    return;
  }
  run('pg_ctl', ['-D', PGDATA, '-m', 'fast', '-w', '-t', '30', 'stop']);
  console.log('[db:local] stopped');
}

function status() {
  if (!isInitialized()) {
    console.log('[db:local] not initialised (run: npm run db:local:start)');
    return;
  }
  const running = isRunning();
  console.log(`[db:local] ${running ? 'RUNNING' : 'STOPPED'} on ${HOST}:${PORT}`);
  if (running) {
    console.log(
      `[db:local] server_version=${psql('airline_inventory', 'SHOW server_version')} ` +
        `citus=${psql('airline_inventory', "SELECT count(*) FROM pg_available_extensions WHERE name='citus'")}`
    );
  }
}

const command = process.argv[2] || 'start';
switch (command) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    stop();
    start();
    break;
  case 'status':
    status();
    break;
  default:
    fail(`Unknown command '${command}'. Use: start | stop | restart | status`);
}
