/**
 * JWT issuing and verification for access and refresh tokens.
 *
 * This module is the single place that knows the token shapes and the signing
 * secrets, so the rest of the codebase never touches `jsonwebtoken` directly and a
 * claim can never be added in one code path and forgotten in another.
 *
 * Two token types share an issuer/audience but NOT a secret. Access tokens are
 * short-lived and presented on every request; refresh tokens are long-lived and
 * only presented to the rotation endpoint. Because their secrets differ, a token
 * of one kind cannot be verified as the other even before the explicit `typ`
 * check — but the check is kept as defence in depth (and to give a clear error if
 * the secrets are ever misconfigured to be identical).
 *
 * WHY the `typ` check matters: without it, if the two secrets were ever set to the
 * same value, a long-lived refresh token would be accepted as a bearer access
 * token (a privilege escalation with a 30-day lifetime) and a short-lived access
 * token would be accepted by the refresh endpoint. Rejecting the wrong type on
 * each side closes both directions.
 */
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { newUuid } = require('../utils/ids');
const { TokenExpiredError, TokenInvalidError } = require('../utils/errors');

const ACCESS_TOKEN_TYPE = 'access';
const REFRESH_TOKEN_TYPE = 'refresh';

const BASE_CLAIMS = { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, algorithm: 'HS256' };

/** Milliseconds per unit for parsing JWT-style TTL strings ('15m', '900s', '1h'). */
const TTL_UNITS_MS = Object.freeze({
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
});

/**
 * Verifies a token and translates jsonwebtoken's errors into our operational error
 * classes. Anything that is not an expiry — bad signature, wrong issuer/audience,
 * malformed input — is a TokenInvalidError.
 */
function verifyJwt(token, secret, expiredMessage, invalidMessage) {
  try {
    return jwt.verify(token, secret, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new TokenExpiredError(expiredMessage);
    }
    throw new TokenInvalidError(invalidMessage);
  }
}

/** Issues a short-lived access token carrying the caller's identity and role. */
function signAccessToken({ userId, email, role }) {
  const jti = newUuid();
  return jwt.sign(
    { sub: userId, email, role, jti, typ: ACCESS_TOKEN_TYPE },
    env.JWT_ACCESS_SECRET,
    { ...BASE_CLAIMS, expiresIn: env.JWT_ACCESS_TTL }
  );
}

/**
 * Verifies an access token and returns its claims.
 *
 * A refresh token is rejected outright: the `typ` claim is authoritative for what
 * a token may be used for, and only access tokens belong on authenticated routes.
 */
function verifyAccessToken(token) {
  const payload = verifyJwt(
    token,
    env.JWT_ACCESS_SECRET,
    'Access token has expired',
    'Access token is invalid'
  );

  if (payload.typ === REFRESH_TOKEN_TYPE) {
    throw new TokenInvalidError('A refresh token cannot be used as an access token');
  }

  return {
    userId: payload.sub,
    email: payload.email,
    role: payload.role,
    jti: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/**
 * Issues a refresh token. `tokenId` is the row's primary-key half in
 * refresh_tokens and `familyId` groups every rotation of one login session.
 */
function signRefreshToken({ userId, tokenId, familyId }) {
  return jwt.sign(
    { sub: userId, jti: tokenId, family: familyId, typ: REFRESH_TOKEN_TYPE },
    env.JWT_REFRESH_SECRET,
    { ...BASE_CLAIMS, expiresIn: env.JWT_REFRESH_TTL_SECONDS }
  );
}

/** Verifies a refresh token and returns the { userId, tokenId, familyId } triple. */
function verifyRefreshToken(token) {
  const payload = verifyJwt(
    token,
    env.JWT_REFRESH_SECRET,
    'Refresh token has expired',
    'Refresh token is invalid'
  );

  if (payload.typ !== REFRESH_TOKEN_TYPE) {
    throw new TokenInvalidError('An access token cannot be used as a refresh token');
  }

  return {
    userId: payload.sub,
    tokenId: payload.jti,
    familyId: payload.family,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/**
 * Access-token lifetime in whole seconds, parsed from env.JWT_ACCESS_TTL.
 *
 * Supported forms mirror what `jsonwebtoken` accepts: '15m', '900s', '1h', '1d',
 * or a bare integer (interpreted as seconds). Falls back to the documented 15
 * minutes when the value cannot be parsed, so a typo cannot produce a token with a
 * nonsensical (or zero) lifetime.
 */
function accessTokenTtlSeconds() {
  const raw = String(env.JWT_ACCESS_TTL || '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(raw);
  if (!match) return 900;

  const value = Number.parseFloat(match[1]);
  const unitMs = TTL_UNITS_MS[(match[2] || 's').toLowerCase()] ?? TTL_UNITS_MS.s;
  const seconds = Math.floor((value * unitMs) / 1000);
  return Math.max(1, seconds);
}

const TWO_FACTOR_TOKEN_TYPE = '2fa_challenge';

/** Issues a short-lived (10m) token to hold user context during 2FA verification. */
function sign2FAChallengeToken({ userId, email, role }) {
  return jwt.sign(
    { sub: userId, email, role, typ: TWO_FACTOR_TOKEN_TYPE },
    env.JWT_ACCESS_SECRET,
    { ...BASE_CLAIMS, expiresIn: '10m' }
  );
}

/** Verifies a 2FA challenge token. */
function verify2FAChallengeToken(token) {
  const payload = verifyJwt(
    token,
    env.JWT_ACCESS_SECRET,
    '2FA session has expired. Please sign in again.',
    'Invalid 2FA challenge token'
  );
  if (payload.typ !== TWO_FACTOR_TOKEN_TYPE) {
    throw new TokenInvalidError('Invalid token type for 2FA verification');
  }
  return {
    userId: payload.sub,
    email: payload.email,
    role: payload.role,
  };
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  sign2FAChallengeToken,
  verify2FAChallengeToken,
  accessTokenTtlSeconds,
};
