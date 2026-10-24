/**
 * Authentication use cases: registration, login, refresh-token rotation and logout.
 *
 * This module owns the security-sensitive flows, so the reasoning behind each is
 * documented where it happens rather than in a separate design doc:
 *
 *   - Login constant-time-ish: a missing account still pays the KDF cost, so a fast
 *     401 cannot be used to enumerate registered emails.
 *   - Refresh rotation with reuse detection: refresh tokens are single-use; a reused
 *     one revokes the whole family.
 *   - Upgrade-on-login: a password hashed with the scrypt fallback is re-hashed with
 *     argon2id the next time the plaintext is available.
 *
 * Every DB write that must not half-apply runs inside `pool.withTransaction`, and
 * every transaction is wrapped in `executeWithRetry` so a serialization failure
 * replays the whole thing (never just the last statement).
 *
 * Nothing here ever logs a password, a hash, or a raw token. At most a token's jti
 * or the user id is logged, neither of which is a secret.
 */
const env = require('../config/env');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const { executeWithRetry } = require('../concurrency/transactionRetry');
const {
  USER_ROLES,
  LOG_OPERATIONS,
  LOG_RESULTS,
  CONSTRAINT_VIOLATION,
} = require('../config/constants');
const {
  ValidationError,
  DuplicateUserError,
  InvalidCredentialsError,
  TokenInvalidError,
  TokenExpiredError,
} = require('../utils/errors');
const { newUuid, randomToken } = require('../utils/ids');
const { hashPassword, verifyPassword, needsRehash } = require('../auth/password');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  sign2FAChallengeToken,
  verify2FAChallengeToken,
  accessTokenTtlSeconds,
} = require('../auth/tokens');
const userRepository = require('../repositories/userRepository');
const refreshTokenRepository = require('../repositories/refreshTokenRepository');
const twoFactorRepository = require('../repositories/twoFactorRepository');
const mailerService = require('./mailerService');
const userService = require('./userService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;

/**
 * A hash of a random, discarded plaintext, computed lazily once per process with the
 * active backend. Login verifies the supplied password against this when the account
 * does not exist, so both branches spend comparable time in the KDF.
 */
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomToken(24));
  }
  return dummyHashPromise;
}

function normalizeEmail(value) {
  return String(value === null || value === undefined ? '' : value)
    .trim()
    .toLowerCase();
}

function isUniqueViolation(err) {
  return Boolean(err) && err.code === CONSTRAINT_VIOLATION.UNIQUE_VIOLATION;
}

/** Expiry stamped on a newly issued refresh token, matching the JWT's own exp. */
function refreshTokenExpiry() {
  return new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
}

/** Assembles the session payload returned by login and refresh. */
function buildSession(user, { accessToken, refreshToken }) {
  return {
    user: userService.toPublicUser(user),
    tokenType: 'Bearer',
    accessToken,
    refreshToken,
    expiresIn: accessTokenTtlSeconds(),
    // Both lifetimes are reported because the client cannot derive the second from
    // the first: it is an independent env setting, and a client that assumes
    // "refresh lasts 30 days" without asking will one day be surprised.
    refreshExpiresIn: env.JWT_REFRESH_TTL_SECONDS,
  };
}

/**
 * Collects every failed registration rule so the client can show all problems at once
 * instead of one round trip per rule.
 *
 * The details are the same `{ fields: [{ path, message }] }` shape the request
 * validator produces, because a client implements one parser for a 400 and should not
 * discover that a weak password arrives in a different one. The rules live here rather
 * than in the route schema because this is where the policy is enforced for every
 * caller, not only HTTP ones — a loader creating users from a CSV gets the same answer.
 *
 * `received` is deliberately absent: the failing values here are a password and an
 * email, and there is nothing useful a client can do with its own credential echoed
 * back at it in a body that will be pasted into a bug report.
 */
function validateRegistration({ email, password, role }) {
  const fields = [];

  if (!EMAIL_RE.test(email)) {
    fields.push({ path: 'email', message: 'email must be a valid email address' });
  }

  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    fields.push({
      path: 'password',
      message: `password must have at least ${PASSWORD_MIN_LENGTH} characters`
    });
  }
  if (!/[A-Za-z]/.test(String(password || ''))) {
    fields.push({ path: 'password', message: 'password must contain a letter' });
  }
  if (!/[0-9]/.test(String(password || ''))) {
    fields.push({ path: 'password', message: 'password must contain a digit' });
  }

  if (!Object.values(USER_ROLES).includes(role)) {
    fields.push({
      path: 'role',
      message: `role must be one of: ${Object.values(USER_ROLES).join(', ')}`
    });
  }

  if (fields.length > 0) {
    throw new ValidationError('Registration payload failed validation', { fields });
  }
}

/**
 * Creates an account and returns its public projection. No tokens are issued here:
 * the client logs in next, which keeps registration and session establishment as
 * two independently rate-limitable steps.
 *
 * A 23505 from the insert is the expected "email taken" outcome (the table's
 * uq_users_email constraint) and becomes a DuplicateUserError.
 */
async function register(input) {
  const { password, fullName = null, phone = null } = input;
  const role = input.role || USER_ROLES.PASSENGER;
  const email = normalizeEmail(input.email);

  validateRegistration({ email, password, role });

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await executeWithRetry(() =>
      userRepository.create(pool.writePool, { email, passwordHash, fullName, role, phone })
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.warn('Registration rejected: email already registered', {
        operation: LOG_OPERATIONS.USER_REGISTER,
        result: LOG_RESULTS.FAILED,
      });
      throw new DuplicateUserError();
    }
    throw err;
  }

  // Generate 6-digit email verification code and send via Gmail / mailerService
  const verificationCode = String(Math.floor(100000 + Math.random() * 900000));
  await twoFactorRepository.create(pool.writePool, {
    userId: user.userId,
    code: verificationCode,
    type: 'REGISTER_VERIFY',
    ttlSeconds: 900,
  });

  await mailerService.sendRegistrationVerification({
    email: user.email,
    code: verificationCode,
  });

  logger.info('User registered with verification dispatch', {
    operation: LOG_OPERATIONS.USER_REGISTER,
    result: LOG_RESULTS.SUCCESS,
    userId: user.userId,
    role: user.role,
  });

  const publicUser = userService.toPublicUser(user);
  return {
    ...publicUser,
    requiresVerification: true,
    devVerificationCode: env.isTest || process.env.NODE_ENV !== 'production' ? verificationCode : undefined,
  };
}

/**
 * Confirms account registration by validating the 6-digit code sent to the user's Gmail.
 */
async function verifyEmail({ email, code }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await userRepository.findByEmail(pool.writePool, { email: normalizedEmail });
  if (!user) {
    throw new ValidationError('No account found for this email address');
  }

  const result = await twoFactorRepository.findValid(pool.writePool, {
    userId: user.userId,
    code,
    type: 'REGISTER_VERIFY',
  });

  if (!result || !result.valid) {
    throw new ValidationError('Invalid or expired verification code');
  }

  await twoFactorRepository.markUsed(pool.writePool, { id: result.record.id });
  const updated = await userRepository.markEmailVerified(pool.writePool, { userId: user.userId });

  logger.info('Email verified successfully', {
    userId: user.userId,
    email: user.email,
  });

  return {
    verified: true,
    user: userService.toPublicUser(updated || user),
  };
}

/** Helper that creates the session, tokens, and records login */
async function establishSession(user, { password = null, userAgent = null, ip = null } = {}) {
  const session = await executeWithRetry(() =>
    pool.withTransaction(async (client) => {
      await userRepository.updateLastLogin(client, { userId: user.userId });

      if (password && needsRehash(user.passwordHash)) {
        const upgradedHash = await hashPassword(password);
        await userRepository.updatePasswordHash(client, {
          userId: user.userId,
          passwordHash: upgradedHash,
        });
      }

      const familyId = newUuid();
      const tokenId = newUuid();
      const refreshToken = signRefreshToken({ userId: user.userId, tokenId, familyId });

      await refreshTokenRepository.insert(client, {
        userId: user.userId,
        tokenId,
        familyId,
        expiresAt: refreshTokenExpiry(),
        userAgent,
        ip,
      });

      return {
        accessToken: signAccessToken({ userId: user.userId, email: user.email, role: user.role }),
        refreshToken,
        jti: tokenId,
      };
    })
  );

  logger.info('Login session established', {
    operation: LOG_OPERATIONS.AUTH_LOGIN,
    result: LOG_RESULTS.SUCCESS,
    userId: user.userId,
    jti: session.jti,
  });

  return buildSession(user, session);
}

/**
 * Authenticates a user and starts a 2FA challenge if required, or establishes a session.
 */
async function login({ email, password, code = null, userAgent = null, ip = null }) {
  const normalizedEmail = normalizeEmail(email);

  const user = await userRepository.findByEmail(pool.writePool, {
    email: normalizedEmail,
    includePassword: true,
  });

  const storedHash = user ? user.passwordHash : await dummyHash();
  const passwordOk = await verifyPassword(storedHash, password);

  if (!user || !user.isActive || !passwordOk) {
    logger.warn('Login failed', {
      operation: LOG_OPERATIONS.AUTH_LOGIN,
      result: LOG_RESULTS.FAILED,
      userId: user ? user.userId : null,
    });
    throw new InvalidCredentialsError();
  }

  // Two-Factor Authentication Check
  const is2FARequired = env.REQUIRE_2FA && user.twoFactorEnabled !== false;

  if (is2FARequired) {
    if (!code) {
      // Step 1: Password verified, issue 6-digit 2FA code to Gmail
      const twoFactorCode = String(Math.floor(100000 + Math.random() * 900000));
      await twoFactorRepository.create(pool.writePool, {
        userId: user.userId,
        code: twoFactorCode,
        type: 'LOGIN_2FA',
        ttlSeconds: 600,
      });

      await mailerService.sendLogin2FACode({
        email: user.email,
        code: twoFactorCode,
      });

      const tempToken = sign2FAChallengeToken({
        userId: user.userId,
        email: user.email,
        role: user.role,
      });

      logger.info('2FA challenge initiated', {
        operation: LOG_OPERATIONS.AUTH_LOGIN,
        userId: user.userId,
      });

      return {
        requires2FA: true,
        tempToken,
        email: user.email,
        devCode: process.env.NODE_ENV !== 'production' ? twoFactorCode : undefined,
      };
    }

    // Step 2: 2FA code was provided in the login body
    const validation = await twoFactorRepository.findValid(pool.writePool, {
      userId: user.userId,
      code,
      type: 'LOGIN_2FA',
    });
    if (!validation || !validation.valid) {
      throw new ValidationError('Invalid or expired 2FA security code');
    }
    await twoFactorRepository.markUsed(pool.writePool, { id: validation.record.id });
  }

  return establishSession(user, { password, userAgent, ip });
}

/**
 * Validates the 2FA code using a temporary challenge token and signs the user in.
 */
async function verifyLogin2FA({ tempToken, code, userAgent = null, ip = null }) {
  const claims = verify2FAChallengeToken(tempToken);
  const user = await userRepository.findById(pool.writePool, { userId: claims.userId, includePassword: false });
  if (!user || !user.isActive) {
    throw new InvalidCredentialsError('User account not found or inactive');
  }

  const validation = await twoFactorRepository.findValid(pool.writePool, {
    userId: user.userId,
    code,
    type: 'LOGIN_2FA',
  });

  if (!validation || !validation.valid) {
    throw new ValidationError('Invalid or expired 2FA security code');
  }

  await twoFactorRepository.markUsed(pool.writePool, { id: validation.record.id });

  return establishSession(user, { userAgent, ip });
}

/**
 * Resends a 2FA or verification code.
 */
async function resendCode({ email = null, tempToken = null, type = 'LOGIN_2FA' }) {
  let targetEmail = email;
  let targetUserId = null;

  if (tempToken) {
    const claims = verify2FAChallengeToken(tempToken);
    targetEmail = claims.email;
    targetUserId = claims.userId;
  }

  if (!targetUserId && targetEmail) {
    const user = await userRepository.findByEmail(pool.writePool, { email: normalizeEmail(targetEmail) });
    if (user) targetUserId = user.userId;
  }

  if (!targetUserId) {
    throw new ValidationError('Could not identify user to resend code');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await twoFactorRepository.create(pool.writePool, {
    userId: targetUserId,
    code,
    type,
    ttlSeconds: 600,
  });

  if (type === 'REGISTER_VERIFY') {
    await mailerService.sendRegistrationVerification({ email: targetEmail, code });
  } else {
    await mailerService.sendLogin2FACode({ email: targetEmail, code });
  }

  return {
    sent: true,
    email: targetEmail,
    devCode: process.env.NODE_ENV !== 'production' ? code : undefined,
  };
}

/**
 * Rotates a refresh token into a new access/refresh pair.
 *
 * REUSE DETECTION: a token that is missing, revoked or already replaced can only
 * mean it was replayed after the legitimate client rotated past it — the holder of
 * the family always has the newest token, so presenting an old one is the signature
 * of a stolen token. The correct response is to revoke the entire family (killing
 * the attacker AND the victim's session) and surface an error, turning a silent,
 * indefinite compromise into one loud, recoverable event.
 *
 * The revocation must COMMIT, so it cannot be followed by a throw inside the same
 * transaction (a rollback would undo it). Instead the transaction returns a status
 * marker and the error is raised after the commit.
 */
async function refresh({ refreshToken, userAgent = null, ip = null }) {
  // Verified before touching the database: signature, issuer/audience, expiry and
  // token type are all checked here (expiry throws TokenExpiredError).
  const claims = verifyRefreshToken(refreshToken);
  const { userId, tokenId, familyId } = claims;

  const outcome = await executeWithRetry(() =>
    pool.withTransaction(async (client) => {
      const row = await refreshTokenRepository.findById(client, { userId, tokenId });

      if (!row || row.revokedAt || row.replacedBy) {
        await refreshTokenRepository.revokeFamily(client, { userId, familyId });
        return { status: 'REUSE' };
      }

      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        return { status: 'EXPIRED' };
      }

      const newTokenId = newUuid();

      // The conditional UPDATE is the rotation lock. If a concurrent request
      // already rotated this row, zero rows match and the race is treated as reuse.
      const rotated = await refreshTokenRepository.markRotated(client, {
        userId,
        tokenId,
        replacedBy: newTokenId,
      });
      if (!rotated) {
        await refreshTokenRepository.revokeFamily(client, { userId, familyId });
        return { status: 'REUSE' };
      }

      // The access token needs the current role/email, so reload the user inside
      // the same transaction.
      const user = await userRepository.findById(client, { userId });
      if (!user) {
        await refreshTokenRepository.revokeFamily(client, { userId, familyId });
        return { status: 'INVALID' };
      }

      const newRefreshToken = signRefreshToken({ userId, tokenId: newTokenId, familyId });
      await refreshTokenRepository.insert(client, {
        userId,
        tokenId: newTokenId,
        familyId,
        expiresAt: refreshTokenExpiry(),
        userAgent,
        ip,
      });

      return {
        status: 'OK',
        user,
        tokenId: newTokenId,
        accessToken: signAccessToken({ userId, email: user.email, role: user.role }),
        refreshToken: newRefreshToken,
      };
    })
  );

  if (outcome.status === 'REUSE') {
    logger.warn('Refresh token reuse detected; family revoked', {
      operation: LOG_OPERATIONS.AUTH_REFRESH,
      result: LOG_RESULTS.FAILED,
      userId,
      jti: tokenId,
    });
    throw new TokenInvalidError('Refresh token has already been used');
  }

  if (outcome.status === 'EXPIRED') {
    logger.warn('Refresh token presented after expiry', {
      operation: LOG_OPERATIONS.AUTH_REFRESH,
      result: LOG_RESULTS.FAILED,
      userId,
      jti: tokenId,
    });
    throw new TokenExpiredError('Refresh token has expired');
  }

  if (outcome.status === 'INVALID') {
    throw new TokenInvalidError('Refresh token subject no longer exists');
  }

  logger.info('Refresh token rotated', {
    operation: LOG_OPERATIONS.AUTH_REFRESH,
    result: LOG_RESULTS.SUCCESS,
    userId,
    jti: outcome.tokenId,
  });

  return buildSession(outcome.user, outcome);
}

/**
 * Revokes the family behind a refresh token. Idempotent: a missing, expired or
 * otherwise unusable token is not an error — the session it names is already gone.
 */
async function logout({ refreshToken, userId = null }) {
  let claims = null;
  try {
    claims = verifyRefreshToken(refreshToken);
  } catch (err) {
    // An expired or forged token carries no live family we can act on.
    claims = null;
  }

  const effectiveUserId = userId || (claims && claims.userId) || null;
  if (!claims || !effectiveUserId) {
    return { revoked: 0 };
  }

  const revoked = await executeWithRetry(() =>
    pool.withTransaction((client) =>
      refreshTokenRepository.revokeFamily(client, {
        userId: effectiveUserId,
        familyId: claims.familyId,
      })
    )
  );

  logger.info('Logout revoked refresh token family', {
    operation: LOG_OPERATIONS.AUTH_REFRESH,
    result: LOG_RESULTS.SUCCESS,
    userId: effectiveUserId,
    jti: claims.tokenId,
  });

  return { revoked };
}

/** Revokes every live refresh token for a user — the "sign out everywhere" action. */
async function logoutAll({ userId }) {
  const revoked = await executeWithRetry(() =>
    pool.withTransaction((client) =>
      refreshTokenRepository.revokeAllForUser(client, { userId })
    )
  );

  logger.info('Logout-all revoked every refresh token for the user', {
    operation: LOG_OPERATIONS.AUTH_REFRESH,
    result: LOG_RESULTS.SUCCESS,
    userId,
  });

  return { revoked };
}

module.exports = {
  register,
  login,
  verifyLogin2FA,
  verifyEmail,
  resendCode,
  refresh,
  logout,
  logoutAll,
};
