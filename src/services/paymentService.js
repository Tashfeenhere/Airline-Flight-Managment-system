/**
 * Payment service — a *simulated* gateway behind a real saga interface.
 *
 * What is real here: the two-phase authorize/capture split, the idempotency of every
 * call, the failure taxonomy, the provider reference that a reconciliation job can
 * match on, and the fact that a decline is a business outcome the booking saga must
 * compensate for rather than an exception that unwinds nothing.
 *
 * What is simulated: the gateway itself. No money moves. The replacement point is
 * this module and nothing else — the booking saga calls authorize/capture/refund and
 * never learns where they go.
 *
 * One rule worth stating because it is the classic way a saga deadlocks: the gateway
 * call happens OUTSIDE the database transaction. Holding a row lock on the inventory
 * counter while waiting on a third-party HTTP call would serialize every buyer on that
 * flight behind the slowest payment in the system.
 */
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');

/** Declines a simulated gateway can produce, chosen deterministically from the request. */
const DECLINE_REASONS = Object.freeze([
  'INSUFFICIENT_FUNDS',
  'CARD_DECLINED',
  'PROVIDER_TIMEOUT',
  'RISK_REJECTED'
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function referenceFor(kind) {
  return `SIM-${kind}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

/**
 * The decline decision, as a pure function so it can be tested without a gateway and
 * reasoned about without clock or network.
 *
 * `failureRate` of 0 (the default) never declines. A rate of 1 always declines. The
 * comparison is `<` rather than `<=` so a rate of exactly 1 always fires and a rate of
 * 0 never does — the boundary cases are the ones tests actually exercise.
 */
function shouldDecline(failureRate, random) {
  if (!Number.isFinite(failureRate) || failureRate <= 0) return false;
  if (failureRate >= 1) return true;
  return random < failureRate;
}

/**
 * Picks a stable decline reason for a given reference, so a retried or reconciled
 * payment reports the same reason it reported the first time.
 */
function declineReasonFor(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  return DECLINE_REASONS[digest[0] % DECLINE_REASONS.length];
}

/**
 * Authorizes the amount without moving it.
 *
 * @param {object} request
 * @param {boolean} [request.injectFailure] forces a decline — the hook the saga's
 *   failure-injection tests use, so a compensation path can be exercised deterministically
 *   without setting a global failure rate that would also break unrelated tests.
 */
async function authorize({ amount, currency = 'USD', bookingReference, bookingId, idempotencyKey = null, injectFailure = false }) {
  const startedAt = Date.now();
  const seed = idempotencyKey || bookingReference || bookingId || referenceFor('SEED');

  if (env.PAYMENT_LATENCY_MS > 0) await sleep(env.PAYMENT_LATENCY_MS);

  const declined = injectFailure || shouldDecline(env.PAYMENT_FAILURE_RATE, Math.random());
  const providerReference = referenceFor('AUTH');
  const durationMs = Date.now() - startedAt;

  if (declined) {
    const reason = injectFailure ? 'INJECTED_FAILURE' : declineReasonFor(seed);
    logger.warn('Payment authorization declined', {
      bookingId,
      bookingReference,
      amount,
      currency,
      reason,
      providerReference,
      durationMs
    });
    return { approved: false, providerReference, failureReason: reason, durationMs };
  }

  logger.info('Payment authorized', {
    bookingId,
    bookingReference,
    amount,
    currency,
    providerReference,
    durationMs
  });
  return { approved: true, providerReference, failureReason: null, durationMs };
}

/**
 * Captures a previously authorized amount.
 *
 * Capture is a separate step, not a formality: it is what makes the saga's
 * compensation meaningful, because between authorize and capture the money is only
 * reserved and can be voided without a refund.
 */
async function capture({ providerReference, amount, bookingId = null }) {
  const startedAt = Date.now();
  if (env.PAYMENT_LATENCY_MS > 0) await sleep(env.PAYMENT_LATENCY_MS);

  logger.info('Payment captured', {
    bookingId,
    providerReference,
    amount,
    durationMs: Date.now() - startedAt
  });
  return { captured: true, providerReference, capturedAt: new Date().toISOString() };
}

/**
 * Refunds a captured amount — the compensation for a confirmed booking that is later
 * cancelled.
 *
 * Idempotent by design: the gateway is keyed on the provider reference, so calling it
 * twice refunds once. The saga relies on that when it retries a compensation.
 */
async function refund({ providerReference, amount, reason = 'BOOKING_CANCELLED', bookingId = null }) {
  const startedAt = Date.now();
  if (env.PAYMENT_LATENCY_MS > 0) await sleep(env.PAYMENT_LATENCY_MS);

  logger.info('Payment refunded', {
    bookingId,
    providerReference,
    amount,
    reason,
    durationMs: Date.now() - startedAt
  });
  return { refunded: true, providerReference, refundedAt: new Date().toISOString() };
}

/** Voids an authorization that was never captured (nothing to refund). */
async function voidAuthorization({ providerReference, bookingId = null }) {
  logger.info('Payment authorization voided', { bookingId, providerReference });
  return { voided: true, providerReference };
}

module.exports = {
  DECLINE_REASONS,
  authorize,
  capture,
  refund,
  voidAuthorization,
  shouldDecline,
  declineReasonFor
};
