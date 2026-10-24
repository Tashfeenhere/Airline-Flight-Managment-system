'use strict';
/**
 * Integration-test helpers.
 *
 * These suites run against the REAL database (no mocks): the guarantees under test —
 * conditional counter updates, partition routing, outbox projection, refresh-token
 * rotation — live in SQL and in transaction boundaries, so stubbing them would test
 * only the stub. `tests/helpers/db.js` owns flight fixtures; this file owns users,
 * because auth rows are shared reference data that several suites need.
 *
 * Every helper is cleanup-safe: users are created with a random email and deleted by
 * id in `afterAll`, flights are created with a random UUIDv7 and removed through
 * `cleanupFlight`. Nothing truncates a shared table.
 */
const crypto = require('crypto');
const buildApp = require('../../src/app');
const authService = require('../../src/services/authService');
const pool = require('../../src/db/pool');

/** Meets the registration policy: >= 8 chars, at least one letter and one digit. */
const PASSWORD = 'Integration1pass';

/** One app instance per test file, built after the env is frozen by setup. */
const app = buildApp();

/**
 * Emails are lowercase (the DB CHECK requires it) and globally unique per test, so a
 * re-run never collides with an account left behind by an interrupted run.
 */
function uniqueEmail(prefix = 'itest') {
  return `${prefix}+${crypto.randomUUID()}@example.com`;
}

/**
 * Registers a user through the service and logs in through the HTTP-independent
 * service path. The returned `auth` value is ready for a `Authorization` header.
 *
 * `role` is only settable here because this is a fixture, not an API call:
 * `POST /api/auth/register` deliberately refuses anything but PASSENGER.
 */
async function createUser({ role = 'PASSENGER', fullName = 'Integration User' } = {}) {
  const email = uniqueEmail();
  const user = await authService.register({ email, password: PASSWORD, fullName, role });
  const session = await authService.login({ email, password: PASSWORD });

  return {
    user,
    session,
    email,
    password: PASSWORD,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    auth: `Bearer ${session.accessToken}`
  };
}

/** Removes a fixture user and every token family it owns. Idempotent. */
async function deleteUser(userId) {
  if (!userId) return;
  await pool.writePool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  await pool.writePool.query('DELETE FROM users WHERE id = $1', [userId]);
}

module.exports = { app, PASSWORD, uniqueEmail, createUser, deleteUser };
