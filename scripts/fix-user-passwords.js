const { hashPassword, verifyPassword } = require('../src/auth/password');
const pool = require('../src/db/pool');

async function fixPasswords() {
  console.log('[fix] Computing argon2id hash for password123...');
  const validHash = await hashPassword('password123');
  console.log('[fix] Generated valid hash:', validHash);

  const ok = await verifyPassword(validHash, 'password123');
  if (!ok) {
    throw new Error('Self verification of password123 failed!');
  }
  console.log('[fix] Self verification passed.');

  console.log('[fix] Updating all users in database with valid hash...');
  const res = await pool.writePool.query('UPDATE users SET password_hash = $1', [validHash]);
  console.log(`[fix] Successfully updated ${res.rowCount} users!`);

  // Verify a sample user
  const sample = await pool.writePool.query('SELECT email, password_hash FROM users LIMIT 3');
  for (const row of sample.rows) {
    const verified = await verifyPassword(row.password_hash, 'password123');
    console.log(`[verify] User ${row.email}: verified = ${verified}`);
  }

  process.exit(0);
}

fixPasswords().catch(err => {
  console.error('[fix] Error:', err);
  process.exit(1);
});
