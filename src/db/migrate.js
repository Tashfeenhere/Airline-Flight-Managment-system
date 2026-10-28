/**
 * Migration runner.
 *
 * Deliberately small and dependency-free: migrations are plain JS modules that
 * receive a checked-out `pg` client, which is enough control to branch on cluster
 * capability (Citus vs vanilla PostgreSQL) — something a plain `.sql` file cannot
 * do, and the reason this project does not use a generic migration library.
 *
 * Guarantees:
 *   - Applied in ascending id order, exactly once, recorded in `schema_migrations`
 *     *per target database* (the write model and the read model each track their own).
 *   - A checksum of each migration's source is stored, so editing an already-applied
 *     migration is reported as drift instead of being silently ignored.
 *   - Transactional migrations roll back completely on failure. Non-transactional
 *     ones must be idempotent (every statement in them uses IF NOT EXISTS /
 *     ON CONFLICT), which is what makes a partially-applied Citus DDL step safe to
 *     re-run.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pool = require('./pool');
const env = require('../config/env');
const logger = require('../utils/logger');
const { migrations, targets } = require('../../db/migrations');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');

function checksumOf(migration) {
  const candidates = [
    path.join(MIGRATIONS_DIR, `${migration.id}-${migration.name.replace(/_/g, '-')}.js`),
    path.join(MIGRATIONS_DIR, `${migration.id}.js`)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
    }
  }
  // Fall back to hashing the exported function, so custom registrations still get
  // a stable identity.
  return crypto.createHash('sha256').update(migration.up.toString()).digest('hex');
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      text PRIMARY KEY,
      name         text NOT NULL,
      checksum     text NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL DEFAULT 0
    );
  `);
}

async function appliedMigrations(client) {
  const { rows } = await client.query(
    'SELECT version, name, checksum, applied_at, execution_ms FROM schema_migrations ORDER BY version'
  );
  return new Map(rows.map((row) => [row.version, row]));
}

function migrationsForTarget(target) {
  return migrations.filter(
    (migration) => migration.target === 'all' || migration.target === target
  );
}

/**
 * Applies every pending migration for one target database.
 *
 * @param {'write'|'read'} target
 * @param {{ dryRun?: boolean, until?: string, log?: Function }} options
 */
async function runMigrations(target, options = {}) {
  if (!targets.includes(target)) {
    throw new Error(`Unknown migration target '${target}' (expected one of: ${targets.join(', ')})`);
  }

  const emit = options.log || ((message) => logger.info(message));
  const poolForTarget = target === 'read' ? pool.readPool : pool.writePool;
  const pending = migrationsForTarget(target);
  const results = [];

  const client = await poolForTarget.connect();
  try {
    await client.query('SET statement_timeout = 0;');
    await ensureMigrationTable(client);
    const applied = await appliedMigrations(client);

    // Drift detection: a changed checksum means the migration was edited after it
    // ran, so the database no longer matches the source of truth.
    const drifted = [];
    for (const migration of pending) {
      const record = applied.get(migration.id);
      if (record && record.checksum !== checksumOf(migration)) {
        drifted.push(migration.id);
      }
    }
    if (drifted.length > 0 && !options.ignoreDrift) {
      throw new Error(
        `Migration drift detected for target '${target}': ${drifted.join(', ')}. ` +
          'The recorded checksum does not match the migration source. Add a new ' +
          'migration instead of editing an applied one, or re-run with --ignore-drift.'
      );
    }

    for (const migration of pending) {
      if (applied.has(migration.id)) {
        results.push({ id: migration.id, name: migration.name, status: 'already-applied' });
        continue;
      }
      if (options.until && migration.id > options.until) break;

      if (options.dryRun) {
        results.push({ id: migration.id, name: migration.name, status: 'pending' });
        continue;
      }

      const startedAt = Date.now();
      emit(`[${target}] applying ${migration.id}_${migration.name} ...`);

      const ctx = {
        target,
        env,
        log: (message) => emit(`[${target}]   ${message}`)
      };

      const run = async () => {
        if (migration.transactional === false) {
          await migration.up(client, ctx);
        } else {
          await client.query('BEGIN');
          try {
            await migration.up(client, ctx);
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        }

        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, execution_ms)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (version) DO UPDATE
             SET checksum = EXCLUDED.checksum, execution_ms = EXCLUDED.execution_ms`,
          [migration.id, migration.name, checksumOf(migration), Date.now() - startedAt]
        );
      };

      await run();

      results.push({
        id: migration.id,
        name: migration.name,
        status: 'applied',
        executionMs: Date.now() - startedAt
      });
      emit(`[${target}] applied ${migration.id}_${migration.name} in ${Date.now() - startedAt}ms`);
    }

    return results;
  } finally {
    client.release();
  }
}

/** Applies pending migrations to every target, in dependency order. */
async function runAll(options = {}) {
  const write = await runMigrations('write', options);
  const read = await runMigrations('read', options);
  return { write, read };
}

/** Reports applied/pending state without changing anything. */
async function status() {
  const report = {};

  for (const target of targets) {
    const poolForTarget = target === 'read' ? pool.readPool : pool.writePool;
    const client = await poolForTarget.connect();
    try {
      await ensureMigrationTable(client);
      const applied = await appliedMigrations(client);
      report[target] = migrationsForTarget(target).map((migration) => ({
        id: migration.id,
        name: migration.name,
        applied: applied.has(migration.id),
        appliedAt: applied.get(migration.id)?.applied_at || null,
        drift: applied.has(migration.id) && applied.get(migration.id).checksum !== checksumOf(migration)
      }));
    } finally {
      client.release();
    }
  }

  return report;
}

module.exports = {
  runMigrations,
  runAll,
  status,
  checksumOf,
  migrationsForTarget
};
