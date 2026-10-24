/**
 * Data access for the `refresh_tokens` table.
 *
 * The table is sharded by `user_id` and co-located with `user_bookings`, so every
 * operation here — which always carries the user id — is a single-shard statement
 * and a rotation never needs 2PC. That is also why `token_id` is never looked up on
 * its own: the refresh JWT carries `sub` (the user id) alongside it.
 *
 * Rows are never deleted on rotation; they are marked with `revoked_at` and
 * `replaced_by` so a replay of an old token is distinguishable from a token that
 * never existed. That distinction is the whole reuse-detection mechanism, so these
 * helpers expose it explicitly rather than hiding it behind a boolean.
 */
const COLUMNS =
  'user_id, token_id, family_id, issued_at, expires_at, revoked_at, replaced_by, user_agent, ip';

function mapRow(row) {
  return {
    userId: row.user_id,
    tokenId: row.token_id,
    familyId: row.family_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    replacedBy: row.replaced_by,
    userAgent: row.user_agent,
    ip: row.ip,
  };
}

/** Records a freshly issued refresh token. issued_at is left to the column default. */
async function insert(client, { userId, tokenId, familyId, expiresAt, userAgent = null, ip = null }) {
  const { rows } = await client.query(
    `INSERT INTO refresh_tokens (user_id, token_id, family_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [userId, tokenId, familyId, expiresAt, userAgent, ip]
  );
  return mapRow(rows[0]);
}

/** Point lookup by the composite key. Returns null when the token is unknown. */
async function findById(client, { userId, tokenId }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM refresh_tokens WHERE user_id = $1 AND token_id = $2`,
    [userId, tokenId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Marks a token as rotated. The `revoked_at IS NULL` predicate makes this the
 * rotation lock: concurrent replay of the same token leaves exactly one caller
 * matching a row, and that caller's UPDATE blocks the others until it commits.
 * Returns the updated row, or null when nothing matched (already rotated).
 */
async function markRotated(client, { userId, tokenId, replacedBy }) {
  const { rows } = await client.query(
    `UPDATE refresh_tokens
        SET revoked_at = now(), replaced_by = $3
      WHERE user_id = $1 AND token_id = $2 AND revoked_at IS NULL
      RETURNING ${COLUMNS}`,
    [userId, tokenId, replacedBy]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Revokes every live token in a family — the reuse-detection response. Returns the
 * number of rows actually revoked.
 */
async function revokeFamily(client, { userId, familyId }) {
  const { rowCount } = await client.query(
    `UPDATE refresh_tokens
        SET revoked_at = now()
      WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL`,
    [userId, familyId]
  );
  return rowCount;
}

/** Revokes every live token for a user — the logout-everywhere response. */
async function revokeAllForUser(client, { userId }) {
  const { rowCount } = await client.query(
    `UPDATE refresh_tokens
        SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return rowCount;
}

/** Counts tokens that are neither revoked nor expired — the live-session count. */
async function countActiveForUser(client, { userId }) {
  const { rows } = await client.query(
    `SELECT count(*) AS active
       FROM refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [userId]
  );
  return rows[0] ? Number(rows[0].active) : 0;
}

/**
 * Deletes tokens that expired before `before`. Revoked-but-unexpired rows are kept
 * (they must remain for reuse detection); only rows past their expiry are inert.
 */
async function deleteExpired(client, { before }) {
  const { rowCount } = await client.query(
    `DELETE FROM refresh_tokens WHERE expires_at < $1`,
    [before]
  );
  return rowCount;
}

module.exports = {
  insert,
  findById,
  markRotated,
  revokeFamily,
  revokeAllForUser,
  countActiveForUser,
  deleteExpired,
};
