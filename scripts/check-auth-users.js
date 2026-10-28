const pool = require('../src/db/pool');
const { verifyPassword } = require('../src/auth/password');

async function main() {
  const res = await pool.writePool.query(`
    SELECT id, email, role, is_active, is_verified, password_hash 
    FROM users 
    WHERE role = 'ADMIN' OR email LIKE '%ada%' OR email LIKE '%admin%' OR email LIKE '%example.com'
    LIMIT 20
  `);
  console.log('--- FOUND USERS ---');
  for (const u of res.rows) {
    let ok123 = false;
    let okSecret = false;
    try {
      ok123 = await verifyPassword('password123', u.password_hash);
    } catch (e) {}
    try {
      okSecret = await verifyPassword('Secret123!', u.password_hash);
    } catch (e) {}
    console.log({
      id: u.id,
      email: u.email,
      role: u.role,
      is_active: u.is_active,
      is_verified: u.is_verified,
      matches_password123: ok123,
      matches_Secret123: okSecret
    });
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
