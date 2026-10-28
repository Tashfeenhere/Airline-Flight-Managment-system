const { hashPassword } = require('../src/auth/password');
const pool = require('../src/db/pool');

async function seedDemoUsers() {
  const hash = await hashPassword('password123');

  // Insert or update ada.lovelace@example.com (Passenger)
  await pool.writePool.query(`
    INSERT INTO users (id, email, password_hash, role, full_name, is_active, is_verified, created_at, updated_at)
    VALUES (
      '01a15ecf-e30f-7c2b-af0a-0667689b31cc',
      'ada.lovelace@example.com',
      $1,
      'PASSENGER',
      'Ada Lovelace',
      true,
      true,
      now(),
      now()
    )
    ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        full_name = 'Ada Lovelace',
        is_active = true,
        is_verified = true,
        role = 'PASSENGER',
        updated_at = now();
  `, [hash]);

  // Insert or update admin.operator@aeroscale.internal (Admin)
  await pool.writePool.query(`
    INSERT INTO users (id, email, password_hash, role, full_name, is_active, is_verified, created_at, updated_at)
    VALUES (
      '01a15ecf-e30f-7c2b-af0a-0667689b31cd',
      'admin.operator@aeroscale.internal',
      $1,
      'ADMIN',
      'Executive Operations Director',
      true,
      true,
      now(),
      now()
    )
    ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        full_name = 'Executive Operations Director',
        is_active = true,
        is_verified = true,
        role = 'ADMIN',
        updated_at = now();
  `, [hash]);

  console.log('[seed] Successfully created / updated demo users with password123!');
  process.exit(0);
}

seedDemoUsers().catch(err => {
  console.error('[seed] Error:', err);
  process.exit(1);
});
