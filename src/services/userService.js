/**
 * Read-side user use cases.
 *
 * Kept separate from authService so that a profile read never drags in
 * hashing/JWT concerns (and vice versa). The output goes through toPublicUser —
 * callers that return a user to a client MUST use it, because it is the boundary
 * that guarantees no credential hash ever leaves the process.
 */
const pool = require('../db/pool');
const { NotFoundError } = require('../utils/errors');
const userRepository = require('../repositories/userRepository');

/**
 * Projects a repository row onto the fields safe to expose. The credential hash is
 * dropped by construction (only the listed keys are copied), so a future column
 * added to the repository cannot silently leak into a response.
 */
function toPublicUser(row) {
  if (!row) return null;
  return {
    userId: row.userId,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    phone: row.phone,
    isVerified: row.isVerified ?? false,
    twoFactorEnabled: row.twoFactorEnabled ?? true,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

/**
 * Loads one user's profile, or throws NotFoundError.
 *
 * `users` is a Citus reference table replicated to every worker, so this read is
 * valid on either the read or the write side; it goes to the write pool to stay on
 * the same connection the auth flow already uses, which keeps profile reads
 * immediately consistent with a just-completed registration.
 */
async function getProfile({ userId }) {
  const row = await userRepository.findById(pool.writePool, { userId });
  if (!row) {
    throw new NotFoundError('User not found', { userId });
  }
  return toPublicUser(row);
}

/** Admin listing of every user, mapped to the public shape. */
async function listUsers() {
  const rows = await userRepository.listAllUsers(pool.writePool);
  return rows.map((row) => toPublicUser(row));
}

module.exports = {
  getProfile,
  listUsers,
  toPublicUser,
};
