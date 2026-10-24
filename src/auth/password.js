/**
 * Password hashing and verification.
 *
 * This module exists to keep the password hashing algorithm behind one seam so it
 * can change without touching a single caller. Argon2id (via the optional
 * `@node-rs/argon2` native module) is the preferred KDF; scrypt from `node:crypto`
 * is the fallback.
 *
 * WHY A FALLBACK AT ALL: `@node-rs/argon2` ships prebuilt native binaries that are
 * absent on some platforms (musl containers, unusual CPU targets). A missing
 * optional dependency must not take the whole API down, so `require` is wrapped in
 * a try/catch and the decision is made once, at load, and exposed as ALGORITHM.
 *
 * The two backends coexist during a migration because every stored value is
 * self-describing (an argon2 value starts with '$argon2', a scrypt value with
 * 'scrypt$'). `needsRehash` reports whether a stored value was written by the
 * non-preferred backend so a successful login can transparently upgrade it — the
 * user's next sign-in silently re-hashes with the current algorithm.
 */
const crypto = require('crypto');

let argon2 = null;
try {
  // The lint-visible require is unchanged; only a load failure is absorbed.
  argon2 = require('@node-rs/argon2');
} catch (err) {
  // Prebuilt binary missing for this platform — degrade to scrypt rather than
  // failing to start. The reason is recorded for one startup log line later.
  argon2 = null;
}

/** Active backend, decided once at load: 'argon2id' when argon2 loaded, else 'scrypt'. */
const ALGORITHM = argon2 ? 'argon2id' : 'scrypt';

// Argon2id parameters: ~19 MiB, 2 passes, single lane. Deliberately the OWASP
// baseline — strong enough for a production credential, cheap enough for login.
const ARGON2_OPTIONS = argon2
  ? { algorithm: argon2.Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }
  : null;

// scrypt parameters. keylen 64 and a 16-byte salt give ample preimage resistance.
const SCRYPT_PREFIX = 'scrypt';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
// node:crypto's default maxmem (32 MiB) is close enough to the 128*N*r requirement
// of N=16384,r=8 that it is unsafe to rely on; pass an explicit, generous limit so
// the hasher can never reject our own parameters on a different Node build.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function scryptDerive(plain, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** Encodes scrypt output as 'scrypt$N$r$p$saltB64$hashB64' so parameters travel with the value. */
function encodeScrypt({ salt, derivedKey, N, r, p }) {
  return [
    SCRYPT_PREFIX,
    N,
    r,
    p,
    salt.toString('base64'),
    derivedKey.toString('base64'),
  ].join('$');
}

/**
 * Parses a scrypt-encoded value back into its parameters and buffers. Returns null
 * for anything malformed so callers answer `false` instead of throwing.
 */
function parseScrypt(stored) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N <= 0 || r <= 0 || p <= 0) return null;

  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || hash.length === 0) return null;

  return { N, r, p, salt, hash };
}

/**
 * Hashes a plaintext password with the active backend. The returned string is
 * self-describing (see the module header) so it can be verified later regardless of
 * which backend is active then.
 */
async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword requires a non-empty plaintext string');
  }

  if (argon2) {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derivedKey = await scryptDerive(plain, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: SCRYPT_KEYLEN,
  });
  return encodeScrypt({ salt, derivedKey, N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

/**
 * Verifies a plaintext password against a stored value.
 *
 * Contract: never throws for a malformed or foreign stored value — it returns
 * false. Authentication callers must be able to treat "unparseable hash" exactly
 * like "wrong password" without wrapping every call site in a try/catch.
 */
async function verifyPassword(stored, plain) {
  if (typeof stored !== 'string' || stored.length === 0) return false;
  if (typeof plain !== 'string') return false;

  if (stored.startsWith('$argon2')) {
    // Written by the argon2 backend. If the native module is unavailable on this
    // host we cannot verify it — fail closed rather than throw.
    if (!argon2) return false;
    try {
      return await argon2.verify(stored, plain);
    } catch (err) {
      // Decoding failed: not a valid argon2 encoded hash.
      return false;
    }
  }

  const parsed = parseScrypt(stored);
  if (!parsed) return false;

  try {
    // Derive with the STORED key length so a timing-safe comparison is always
    // between two equal-length buffers.
    const derivedKey = await scryptDerive(plain, parsed.salt, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      keylen: parsed.hash.length,
    });
    return crypto.timingSafeEqual(derivedKey, parsed.hash);
  } catch (err) {
    // Absurd stored parameters could make scrypt reject the request; treat it as a
    // failed verification, never as an unhandled error.
    return false;
  }
}

/**
 * True when the stored value was produced by the scrypt fallback and should be
 * upgraded to argon2id on the next successful login. When scrypt is itself the
 * active backend this re-hash is a no-op refresh with a fresh salt.
 */
function needsRehash(stored) {
  if (typeof stored !== 'string') return false;
  return stored.startsWith(`${SCRYPT_PREFIX}$`);
}

module.exports = {
  hashPassword,
  verifyPassword,
  needsRehash,
  ALGORITHM,
};
