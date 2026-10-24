/**
 * Unit tests for the password hashing seam.
 *
 * These exercise both backends deterministically: the configured backend via
 * hashPassword, and the scrypt format via a hand-built encoded value so the
 * constant-time verification path is covered even when argon2 is active.
 */
const crypto = require('crypto');
const {
  hashPassword,
  verifyPassword,
  needsRehash,
  ALGORITHM,
} = require('../../src/auth/password');

const PASSWORD = 'S3cretPass';

/** Builds a self-describing scrypt value the same way the fallback backend does. */
function scryptEncoded(plain, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      plain,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(`scrypt$16384$8$1$${salt.toString('base64')}$${derivedKey.toString('base64')}`);
      }
    );
  });
}

describe('password', () => {
  test('the active backend is a known one and hashes are self-describing', () => {
    expect(['argon2id', 'scrypt']).toContain(ALGORITHM);

    return hashPassword(PASSWORD).then((stored) => {
      if (ALGORITHM === 'argon2id') {
        expect(stored.startsWith('$argon2')).toBe(true);
      } else {
        expect(stored.startsWith('scrypt$')).toBe(true);
      }
    });
  });

  test('hash/verify round trip', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(typeof stored).toBe('string');
    await expect(verifyPassword(stored, PASSWORD)).resolves.toBe(true);
  });

  test('a wrong password verifies false', async () => {
    const stored = await hashPassword(PASSWORD);
    await expect(verifyPassword(stored, 'not-the-password')).resolves.toBe(false);
  });

  test('a malformed stored hash returns false without throwing', async () => {
    await expect(verifyPassword('not-a-hash', PASSWORD)).resolves.toBe(false);
    await expect(verifyPassword('scrypt$bad', PASSWORD)).resolves.toBe(false);
    await expect(verifyPassword('', PASSWORD)).resolves.toBe(false);
    await expect(verifyPassword(null, PASSWORD)).resolves.toBe(false);
  });

  test('needsRehash is true for a hand-built scrypt string', () => {
    const salt = Buffer.alloc(16, 7).toString('base64');
    const hash = Buffer.alloc(64, 1).toString('base64');
    const stored = `scrypt$16384$8$1$${salt}$${hash}`;
    expect(needsRehash(stored)).toBe(true);
  });

  test('the scrypt backend verifies and is flagged for rehash', async () => {
    const stored = await scryptEncoded(PASSWORD, Buffer.alloc(16, 3));
    expect(needsRehash(stored)).toBe(true);
    await expect(verifyPassword(stored, PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(stored, 'wrong')).resolves.toBe(false);
  });

  test('two hashes of the same password differ (salted)', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first).not.toBe(second);
    await expect(verifyPassword(first, PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(second, PASSWORD)).resolves.toBe(true);
  });
});
