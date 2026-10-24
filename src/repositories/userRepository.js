/**
 * Data access for the `users` reference table.
 *
 * `users` is a Citus reference table: fully replicated to every worker, so it is
 * joined locally by every authenticated request with no cross-shard hop. That is
 * also why these functions take a client rather than opening their own connection —
 * the caller decides whether the read can be served from the pool directly or must
 * share a transaction with surrounding writes.
 *
 * Every function returns mapped camelCase objects, never raw rows: a raw row would
 * leak the `password_hash` column into any caller that forgot to strip it, and the
 * mapping is the one place that guarantees the credential never leaves this layer
 * unless explicitly asked for.
 */
const { USER_ROLES } = require('../config/constants');

const PUBLIC_COLUMNS =
  'id, email, role, full_name, phone, is_active, is_verified, two_factor_enabled, last_login_at, created_at, updated_at';
const WITH_PASSWORD_COLUMNS = `${PUBLIC_COLUMNS}, password_hash`;

/**
 * Maps a row to the API-facing shape. `passwordHash` is only attached when the
 * caller explicitly requested it, so an accidental spread into a response still
 * cannot carry the credential.
 */
function mapRow(row, includePassword = false) {
  const user = {
    userId: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    phone: row.phone,
    isActive: row.is_active,
    isVerified: row.is_verified ?? false,
    twoFactorEnabled: row.two_factor_enabled ?? true,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includePassword) user.passwordHash = row.password_hash;
  return user;
}

/**
 * Normalizes an email for storage/lookup. The table enforces
 * `ck_users_email_lowercase`, so lowercasing here keeps a caller's mixed-case
 * input from violating the CHECK and makes the UNIQUE index case-insensitive.
 */
function normalizeEmail(email) {
  return String(email === null || email === undefined ? '' : email)
    .trim()
    .toLowerCase();
}

/**
 * Inserts a new user. A 23505 unique violation on `uq_users_email` is deliberately
 * NOT swallowed: it propagates so the service can map it to a DuplicateUserError,
 * which is a business outcome rather than a retryable fault.
 */
async function create(client, { email, passwordHash, fullName = null, role = USER_ROLES.PASSENGER, phone = null }) {
  const { rows } = await client.query(
    `INSERT INTO users (email, password_hash, role, full_name, phone)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PUBLIC_COLUMNS}`,
    [normalizeEmail(email), passwordHash, role, fullName, phone]
  );
  return mapRow(rows[0]);
}

/**
 * Looks a user up by id. `includePassword` defaults to false: forcing the caller to
 * opt in is the cheapest possible guard against leaking a credential hash into an
 * API response by accident.
 */
async function findById(client, { userId, includePassword = false }) {
  const columns = includePassword ? WITH_PASSWORD_COLUMNS : PUBLIC_COLUMNS;
  const { rows } = await client.query(
    `SELECT ${columns} FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] ? mapRow(rows[0], includePassword) : null;
}

/** Looks a user up by (normalized) email; same password-hash opt-in as findById. */
async function findByEmail(client, { email, includePassword = false }) {
  const columns = includePassword ? WITH_PASSWORD_COLUMNS : PUBLIC_COLUMNS;
  const { rows } = await client.query(
    `SELECT ${columns} FROM users WHERE email = $1`,
    [normalizeEmail(email)]
  );
  return rows[0] ? mapRow(rows[0], includePassword) : null;
}

/** Records a successful authentication. Bumps updated_at so any cache can invalidate. */
async function updateLastLogin(client, { userId }) {
  const { rows } = await client.query(
    `UPDATE users
        SET last_login_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Replaces the stored credential hash (used by the transparent upgrade-on-login path). */
async function updatePasswordHash(client, { userId, passwordHash }) {
  const { rows } = await client.query(
    `UPDATE users
        SET password_hash = $2, updated_at = now()
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId, passwordHash]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Bulk lookup used to resolve a set of ids in one round trip. */
async function listByIds(client, { userIds }) {
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC`,
    [userIds]
  );
  return rows.map((row) => mapRow(row));
}

/**
 * Lists every user for the admin view. `users` is a small (~100k) reference table,
 * so an unfiltered scan is acceptable — there is no unbounded-growth concern that
 * would justify pagination here.
 */
async function listAllUsers(client) {
  const { rows } = await client.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at ASC`
  );
  return rows.map((row) => mapRow(row));
}

async function markEmailVerified(client, { userId }) {
  const { rows } = await client.query(
    `UPDATE users
        SET is_verified = true, updated_at = now()
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

async function updateTwoFactor(client, { userId, enabled }) {
  const { rows } = await client.query(
    `UPDATE users
        SET two_factor_enabled = $2, updated_at = now()
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [userId, Boolean(enabled)]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

module.exports = {
  create,
  findById,
  findByEmail,
  updateLastLogin,
  updatePasswordHash,
  markEmailVerified,
  updateTwoFactor,
  listByIds,
  listAllUsers,
};
