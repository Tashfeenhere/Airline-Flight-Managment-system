/**
 * Authentication endpoints.
 *
 * These handlers only translate HTTP into service calls and back. Every rule that
 * matters — password strength, refresh-token reuse detection, family revocation —
 * lives in `authService`, because a rule enforced in a controller is a rule that does
 * not apply to the CLI, the workers, or the next caller that forgets it.
 */
const authService = require('../services/authService');
const userService = require('../services/userService');
const { ok } = require('../http/respond');

/** Client metadata every session record keeps, so a session list can say where from. */
function sessionContext(req) {
  return { userAgent: req.get('user-agent') || null, ip: req.ip || null };
}

async function register(req, res) {
  const user = await authService.register(req.body);
  return ok(res, user, { statusCode: 201 });
}

async function login(req, res) {
  const session = await authService.login({
    email: req.body.email,
    password: req.body.password,
    code: req.body.code || req.body.twoFactorCode || null,
    ...sessionContext(req)
  });
  return ok(res, session);
}

async function verify2FA(req, res) {
  const session = await authService.verifyLogin2FA({
    tempToken: req.body.tempToken,
    code: req.body.code,
    ...sessionContext(req)
  });
  return ok(res, session);
}

async function verifyEmail(req, res) {
  const result = await authService.verifyEmail({
    email: req.body.email,
    code: req.body.code,
  });
  return ok(res, result);
}

async function resendCode(req, res) {
  const result = await authService.resendCode({
    email: req.body.email,
    tempToken: req.body.tempToken,
    type: req.body.type,
  });
  return ok(res, result);
}

async function refresh(req, res) {
  const session = await authService.refresh({
    refreshToken: req.body.refreshToken,
    ...sessionContext(req)
  });
  return ok(res, session);
}

/**
 * Revokes the presented refresh token.
 *
 * Claims `revoked: true` unconditionally, which the contract requires (`enum: [true]`)
 * and which is the truthful answer: the post-condition a caller cares about is "this
 * token can no longer be rotated", and it holds whether the token was live a moment
 * ago or had already been revoked. Reporting `false` for the second case would invite
 * a client to retry something that already has the desired effect.
 */
async function logout(req, res) {
  await authService.logout({
    refreshToken: req.body.refreshToken,
    userId: req.user ? req.user.userId : null
  });
  return ok(res, { revoked: true });
}

async function me(req, res) {
  const user = await userService.getProfile({ userId: req.user.userId });
  return ok(res, user);
}

module.exports = {
  register,
  login,
  verify2FA,
  verifyEmail,
  resendCode,
  refresh,
  logout,
  me,
};
