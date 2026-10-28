'use strict';
const { hashPassword } = require('../src/auth/password');
const pool = require('../src/db/pool');

async function seedAdmin() {
  try {
    const password = 'AdminPassword123!';
    const hash = await hashPassword(password);
    const email = 'admin@airline.internal';

    const res = await pool.query(`
      INSERT INTO users (id, email, password_hash, role, full_name, phone, is_active, is_verified)
      VALUES (app_uuidv7(), $1, $2, 'ADMIN', 'Executive Operations Director', '+1-800-555-AERO', true, true)
      ON CONFLICT (email)
      DO UPDATE SET password_hash = $2, role = 'ADMIN', is_active = true, is_verified = true
      RETURNING id, email, role, full_name;
    `, [email, hash]);

    console.log('Admin account created / verified successfully:');
    console.log(res.rows[0]);
    console.log(`Credentials: email = ${email} | password = ${password}`);
    process.exit(0);
  } catch (err) {
    console.error('Failed to create admin:', err);
    process.exit(1);
  }
}

seedAdmin();
