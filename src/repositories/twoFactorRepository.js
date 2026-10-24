/**
 * Repository for 2FA and email verification codes.
 */
async function create(client, { userId, code, type, ttlSeconds = 600 }) {
  // Invalidate any previously unconsumed code of this type for the user
  await client.query(
    `UPDATE two_factor_codes
        SET used = true
      WHERE user_id = $1 AND type = $2 AND used = false`,
    [userId, type]
  );

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const { rows } = await client.query(
    `INSERT INTO two_factor_codes (user_id, code, type, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, code, type, expires_at, used, attempts, created_at`,
    [userId, code, type, expiresAt]
  );
  return rows[0];
}

async function findValid(client, { userId, code, type }) {
  const { rows } = await client.query(
    `SELECT id, user_id, code, type, expires_at, used, attempts, created_at
       FROM two_factor_codes
      WHERE user_id = $1
        AND type = $2
        AND used = false
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, type]
  );

  if (!rows[0]) return null;

  const record = rows[0];
  if (record.code !== String(code).trim()) {
    // Increment attempts
    await client.query(
      `UPDATE two_factor_codes
          SET attempts = attempts + 1
        WHERE id = $1`,
      [record.id]
    );
    return { valid: false, record };
  }

  return { valid: true, record };
}

async function markUsed(client, { id }) {
  const { rows } = await client.query(
    `UPDATE two_factor_codes
        SET used = true
      WHERE id = $1
      RETURNING id, user_id, used`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  create,
  findValid,
  markUsed,
};
