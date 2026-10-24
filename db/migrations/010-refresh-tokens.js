/**
 * Migration 010 — rotating refresh tokens.
 *
 * Refresh tokens must be revocable server-side, which a stateless JWT is not: an
 * attacker who steals one keeps using it until it expires. This table makes
 * rotation detectable.
 *
 * The scheme is *refresh token families*. Every login starts a family. Each
 * rotation inserts a new row in the same family and marks the old row replaced.
 * Presenting a token that was already rotated (or revoked) can only mean the token
 * was stolen — the legitimate client would be holding the newer one — so the whole
 * family is revoked. That turns a silent, indefinite compromise into a single
 * detectable event that logs the user out everywhere.
 *
 * Sharded by `user_id` and co-located with `user_bookings`: both are per-user
 * access paths, so a rotation is one single-shard transaction and never needs 2PC.
 * The consequence is that `token_id` alone cannot be looked up — which is fine,
 * because the refresh JWT carries `sub` (the user id) alongside it.
 */
const citus = require('../../src/db/citus');

module.exports = {
  id: '010',
  name: 'refresh_tokens',
  target: 'write',
  transactional: false,
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        user_id     uuid NOT NULL,
        token_id    uuid NOT NULL,
        family_id   uuid NOT NULL,
        issued_at   timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL,
        revoked_at  timestamptz,
        replaced_by uuid,
        user_agent  text,
        ip          text,

        -- Distributed by user_id, so the distribution column must lead the key.
        PRIMARY KEY (user_id, token_id),
        CONSTRAINT ck_refresh_tokens_expiry CHECK (expires_at > issued_at)
      );
    `);

    await citus.distribute(client, 'refresh_tokens', 'user_id', {
      colocateWith: 'user_bookings'
    });

    // Revoking a family touches every row in it: the reuse-detection path.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family
        ON refresh_tokens (user_id, family_id);
    `);

    // Drives the cleanup job that deletes tokens that expired long ago. Partial,
    // because revoked rows are already inert and the table would otherwise grow
    // without bound on a busy deployment.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry
        ON refresh_tokens (expires_at)
        WHERE revoked_at IS NULL;
    `);
  }
};
