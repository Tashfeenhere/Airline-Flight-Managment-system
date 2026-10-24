/**
 * PostgreSQL advisory locks.
 *
 * A one-shot maintenance job that two operators start by accident must not run twice:
 * creating the same monthly partition from two sessions is a race the DDL cannot lose
 * gracefully, and two concurrent reprojections would do the same work twice while
 * fighting over the same rows. An advisory lock gives those jobs a mutual-exclusion
 * primitive without inventing a table to hold it.
 *
 * Scope worth knowing: Citus propagates advisory locks across workers, so on a
 * distributed cluster the lock is meaningful only among sessions attached to the same
 * coordinator — which is where these jobs are run. It is not a distributed lock, and
 * nothing in the booking path depends on it.
 *
 * The lock is taken on a dedicated connection and released in a `finally`, and it is a
 * *session* lock (not a transaction lock) so that a job which commits partway through
 * keeps holding it. `pg_advisory_unlock` is called explicitly rather than relying on
 * connection teardown, so a pooled connection cannot return to the pool still holding
 * a lock nobody will ever release.
 */
const pool = require('./pool');
const logger = require('../utils/logger');

/** Stable 32-bit key for a name, so every process derives the same lock id. */
function lockKeyFor(name) {
  let hash = 5381;
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) + hash + name.charCodeAt(index)) % 2147483647;
  }
  return hash;
}

/**
 * Runs `fn` while holding the named lock.
 *
 * @returns {{ acquired: false, reason: string } | { acquired: true, result: any }}
 *   Never throws for "someone else holds it" — that is an expected outcome a caller
 *   reports, not an error.
 */
async function withAdvisoryLock(name, fn, { wait = false, onWait = null } = {}) {
  const key = lockKeyFor(name);
  const client = await pool.writePool.connect();

  try {
    const statement = wait ? 'SELECT pg_advisory_lock($1)' : 'SELECT pg_try_advisory_lock($1) AS ok';
    const { rows } = await client.query(statement, [key]);

    if (!wait && rows[0] && rows[0].ok === false) {
      return { acquired: false, reason: 'HELD_BY_ANOTHER_SESSION' };
    }
    if (wait && onWait) onWait();

    try {
      return { acquired: true, result: await fn() };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } catch (err) {
    logger.warn('Advisory lock operation failed', { name, key, error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withAdvisoryLock, lockKeyFor };
