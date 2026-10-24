/**
 * Migration 013 — Two-Factor Authentication (2FA) and email verification.
 */
const citus = require('../../src/db/citus');

module.exports = {
  id: '013',
  name: 'two_factor_and_verification',
  target: 'write',
  transactional: false,
  async up(client) {
    // 1. Add verification and 2FA flags to users table
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false;
    `);
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT true;
    `);

    // Ensure demo existing users are pre-verified so development logins continue working
    await client.query(`
      UPDATE users SET is_verified = true WHERE email IN ('ada.lovelace@example.com', 'admin.operator@aeroscale.internal');
    `);

    // 2. Create two_factor_codes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS two_factor_codes (
        id uuid PRIMARY KEY DEFAULT app_uuidv7(),
        user_id uuid NOT NULL,
        code text NOT NULL,
        type text NOT NULL CHECK (type IN ('REGISTER_VERIFY', 'LOGIN_2FA')),
        expires_at timestamptz NOT NULL,
        used boolean NOT NULL DEFAULT false,
        attempts smallint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Make reference table if Citus is active so any worker can join
    const state = await citus.distributionState(client);
    if (state.canDistribute) {
      await citus.makeReference(client, 'two_factor_codes');
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_two_factor_user_lookup
        ON two_factor_codes (user_id, type)
        WHERE NOT used;
    `);
  }
};
