'use strict';
/**
 * Authentication and authorization, exercised through the public HTTP surface.
 *
 * The security properties here are the ones an attacker would probe, so they are
 * asserted at the boundary a real client hits — status codes and error codes, not
 * internal return values:
 *
 *   - a password hash never leaves the process;
 *   - a rotated refresh token cannot be replayed, and replay burns the whole family;
 *   - logout revokes the family server-side (a stateless JWT alone cannot);
 *   - vertical privilege (ADMIN) is enforced before a handler runs.
 */
const request = require('supertest');
const { app, PASSWORD, createUser, uniqueEmail, deleteUser } = require('./helpers');
const pool = require('../../src/db/pool');

const createdUserIds = [];

afterAll(async () => {
  for (const userId of createdUserIds) await deleteUser(userId);
  await pool.close();
});

describe('POST /api/auth/register', () => {
  test('creates an account and never returns the credential hash', async () => {
    const email = uniqueEmail('register');

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, fullName: 'Register Test' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe(email);
    expect(res.body.data.role).toBe('PASSENGER');
    expect(res.body.data).not.toHaveProperty('passwordHash');
    expect(res.body.data).not.toHaveProperty('password');

    createdUserIds.push(res.body.data.userId);
  });

  test('rejects a password that violates the policy with per-field details', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: uniqueEmail('weak'), password: 'short', fullName: 'Weak Password' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Either the route validator or the service policy rejects it; both report the
    // same `{ fields: [{ path, message }] }` shape, which is the contract.
    const fields = res.body.error.details.fields;
    expect(Array.isArray(fields)).toBe(true);
    expect(fields.some((field) => field.path === 'password')).toBe(true);
  });

  test('rejects a duplicate email with 409 DUPLICATE_USER', async () => {
    const email = uniqueEmail('dupe');

    const first = await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, fullName: 'First' });
    expect(first.status).toBe(201);
    createdUserIds.push(first.body.data.userId);

    const second = await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, fullName: 'Second' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_USER');
  });

  test('ignores a role a self-registering caller tries to grant itself', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: uniqueEmail('role'), password: PASSWORD, fullName: 'Role Test', role: 'ADMIN' });

    // The route schema restricts `role` to PASSENGER, so an escalation attempt is a
    // validation error rather than a silently-elevated account.
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.some((field) => field.path === 'role')).toBe(true);
  });
});

describe('login and /me', () => {
  test('logs in, then /me resolves the caller from the bearer token', async () => {
    const fixture = await createUser();
    createdUserIds.push(fixture.user.userId);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: fixture.email, password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body.data.accessToken).toEqual(expect.any(String));
    expect(login.body.data.refreshToken).toEqual(expect.any(String));
    expect(login.body.data.tokenType).toBe('Bearer');

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.userId).toBe(fixture.user.userId);
    expect(me.body.data.email).toBe(fixture.email);
  });

  test('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
    const fixture = await createUser();
    createdUserIds.push(fixture.user.userId);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: fixture.email, password: 'WrongPassword1' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('answers 401 for a protected route with no token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('refresh rotation', () => {
  test('rotates a refresh token and treats replay as theft (revoking the family)', async () => {
    const fixture = await createUser();
    createdUserIds.push(fixture.user.userId);

    const rotated = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: fixture.refreshToken });

    expect(rotated.status).toBe(200);
    expect(rotated.body.data.refreshToken).toEqual(expect.any(String));
    expect(rotated.body.data.refreshToken).not.toBe(fixture.refreshToken);

    // Replaying the old token can only mean it was stolen: the legitimate holder is
    // already carrying the rotated one.
    const replay = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: fixture.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_INVALID');

    // Reuse detection revokes the ENTIRE family, including the token the thief's
    // victim currently holds. Fail closed.
    const afterRevocation = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rotated.body.data.refreshToken });
    expect(afterRevocation.status).toBe(401);
    expect(afterRevocation.body.error.code).toBe('TOKEN_INVALID');
  });

  test('logout revokes the family server-side', async () => {
    const fixture = await createUser();
    createdUserIds.push(fixture.user.userId);

    const logout = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: fixture.refreshToken });

    expect(logout.status).toBe(200);
    expect(logout.body.data.revoked).toBe(true);

    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: fixture.refreshToken });

    expect(refresh.status).toBe(401);
    expect(refresh.body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('role enforcement', () => {
  test('an admin route is 401 without a token and 403 for a passenger', async () => {
    const passenger = await createUser();
    createdUserIds.push(passenger.user.userId);

    const anonymous = await request(app).get('/api/admin/topology');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    const forbidden = await request(app)
      .get('/api/admin/topology')
      .set('Authorization', passenger.auth);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
  });

  test('an admin reaches the topology report', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    createdUserIds.push(admin.user.userId);

    const res = await request(app)
      .get('/api/admin/topology')
      .set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    // `citus` is false on the vanilla PostgreSQL used by unit/local runs and true on
    // the composed cluster; the report must be honest either way rather than 500.
    expect(typeof res.body.data.citus).toBe('boolean');
    expect(Array.isArray(res.body.data.workers)).toBe(true);
  });

  test('the caller-scoped booking list requires a token', async () => {
    const res = await request(app).get('/api/users/me/bookings');
    expect(res.status).toBe(401);
  });
});
