/**
 * Unit tests for JWT issuing/verification.
 *
 * The important invariants are the type boundary (a refresh token must not work as
 * an access token), the error taxonomy (expired vs. invalid), and that identity
 * claims survive the round trip.
 */
const jwt = require('jsonwebtoken');
const env = require('../../src/config/env');
const { newUuid } = require('../../src/utils/ids');
const { TokenExpiredError, TokenInvalidError } = require('../../src/utils/errors');
const {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  accessTokenTtlSeconds,
} = require('../../src/auth/tokens');

const USER_ID = newUuid();
const EMAIL = 'pilot@example.com';
const ROLE = 'PASSENGER';

describe('tokens', () => {
  test('an access token round trip carries the role and identity', () => {
    const token = signAccessToken({ userId: USER_ID, email: EMAIL, role: ROLE });
    const claims = verifyAccessToken(token);

    expect(claims.userId).toBe(USER_ID);
    expect(claims.email).toBe(EMAIL);
    expect(claims.role).toBe(ROLE);
    expect(claims.jti).toBeTruthy();
    expect(claims.expiresAt instanceof Date).toBe(true);
  });

  test('a refresh token is rejected by verifyAccessToken', () => {
    const refresh = signRefreshToken({
      userId: USER_ID,
      tokenId: newUuid(),
      familyId: newUuid(),
    });
    expect(() => verifyAccessToken(refresh)).toThrow(TokenInvalidError);
  });

  test('a refresh token round trip carries the family and token id', () => {
    const tokenId = newUuid();
    const familyId = newUuid();
    const token = signRefreshToken({ userId: USER_ID, tokenId, familyId });
    const claims = verifyRefreshToken(token);

    expect(claims.userId).toBe(USER_ID);
    expect(claims.tokenId).toBe(tokenId);
    expect(claims.familyId).toBe(familyId);
  });

  test('an access token is rejected by verifyRefreshToken', () => {
    const access = signAccessToken({ userId: USER_ID, email: EMAIL, role: ROLE });
    expect(() => verifyRefreshToken(access)).toThrow(TokenInvalidError);
  });

  test('a tampered token throws TokenInvalidError', () => {
    const token = signAccessToken({ userId: USER_ID, email: EMAIL, role: ROLE });
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload}.${signature.slice(0, -3)}xyz`;

    expect(() => verifyAccessToken(tampered)).toThrow(TokenInvalidError);
  });

  test('an expired token throws TokenExpiredError', () => {
    // Signed directly with the access secret because signAccessToken always uses the
    // configured (positive) TTL; the claim shape matches what verifyAccessToken reads.
    const expired = jwt.sign(
      { sub: USER_ID, email: EMAIL, role: ROLE, jti: newUuid(), typ: 'access' },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '-1s', issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE }
    );

    expect(() => verifyAccessToken(expired)).toThrow(TokenExpiredError);
  });

  test('accessTokenTtlSeconds parses the configured TTL to a positive number', () => {
    const seconds = accessTokenTtlSeconds();
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThan(0);
  });
});
