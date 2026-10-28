'use strict';
/**
 * Comprehensive Unit Test Suite for Payment Services & Gateways.
 *
 * Exercises all critical payment service layers:
 * 1. Payment authorization (approved path, decline taxonomy, stable decline seeds)
 * 2. Payment capture (successful capture with providerReference correlation)
 * 3. Payment refund (full compensation, timestamp generation)
 * 4. Payment void (voiding authorization before capture)
 * 5. Deterministic decline seeds & zero failure rate boundary
 */
const paymentService = require('../../src/services/paymentService');

describe('Payment Service & Gateway Simulation Suite', () => {
  describe('1. Payment Authorization', () => {
    test('authorizes valid payment without failure injection', async () => {
      const auth = await paymentService.authorize({
        amount: 450.00,
        currency: 'USD',
        bookingReference: 'BK-TEST-PAY-01',
        bookingId: '01a10000-0000-7000-8000-000000000001',
        injectFailure: false
      });

      expect(auth).toHaveProperty('approved', true);
      expect(auth).toHaveProperty('providerReference');
      expect(auth.providerReference).toMatch(/^SIM-AUTH-/);
      expect(auth.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('declines authorization when injectFailure is true with INJECTED_FAILURE code', async () => {
      const auth = await paymentService.authorize({
        amount: 999.00,
        currency: 'USD',
        bookingReference: 'BK-TEST-FAIL-02',
        bookingId: '01a10000-0000-7000-8000-000000000002',
        injectFailure: true
      });

      expect(auth).toHaveProperty('approved', false);
      expect(auth.failureReason).toBe('INJECTED_FAILURE');
      expect(auth.providerReference).toMatch(/^SIM-AUTH-/);
    });

    test('deterministic decline reason for stable seed/idempotency key', () => {
      const key = 'idem-seed-test-decline-hash';
      const reason1 = paymentService.declineReasonFor(key);
      const reason2 = paymentService.declineReasonFor(key);

      expect(reason1).toBe(reason2);
      expect(paymentService.DECLINE_REASONS).toContain(reason1);
    });
  });

  describe('2. Payment Capture', () => {
    test('captures authorized payment and preserves providerReference correlation', async () => {
      const authRef = 'SIM-AUTH-ABCDEF123456';
      const capture = await paymentService.capture({
        providerReference: authRef,
        amount: 450.00,
        bookingId: '01a10000-0000-7000-8000-000000000004'
      });

      expect(capture.captured).toBe(true);
      expect(capture.providerReference).toBe(authRef);
      expect(capture).toHaveProperty('capturedAt');
      expect(new Date(capture.capturedAt).getTime()).not.toBeNaN();
    });
  });

  describe('3. Payment Refund & Compensation', () => {
    test('refunds captured amount and preserves providerReference correlation', async () => {
      const capRef = 'SIM-CAPTURE-123456ABCDEF';
      const refund = await paymentService.refund({
        providerReference: capRef,
        amount: 450.00,
        reason: 'USER_CANCELLED',
        bookingId: '01a10000-0000-7000-8000-000000000006'
      });

      expect(refund.refunded).toBe(true);
      expect(refund.providerReference).toBe(capRef);
      expect(refund).toHaveProperty('refundedAt');
      expect(new Date(refund.refundedAt).getTime()).not.toBeNaN();
    });
  });

  describe('4. Payment Void Authorization', () => {
    test('voids authorization that was never captured', async () => {
      const authRef = 'SIM-AUTH-UNPROCESSED-789';
      const voidResult = await paymentService.voidAuthorization({
        providerReference: authRef,
        bookingId: '01a10000-0000-7000-8000-000000000008'
      });

      expect(voidResult.voided).toBe(true);
      expect(voidResult.providerReference).toBe(authRef);
    });
  });

  describe('5. Rate Boundary & Failure Taxonomy', () => {
    test('shouldDecline returns false for 0 and true for 1', () => {
      expect(paymentService.shouldDecline(0, 0.5)).toBe(false);
      expect(paymentService.shouldDecline(-1, 0.5)).toBe(false);
      expect(paymentService.shouldDecline(1, 0.5)).toBe(true);
      expect(paymentService.shouldDecline(0.3, 0.29)).toBe(true);
      expect(paymentService.shouldDecline(0.3, 0.31)).toBe(false);
    });

    test('declineReasonFor always maps to a member of DECLINE_REASONS', () => {
      for (let i = 0; i < 20; i++) {
        const reason = paymentService.declineReasonFor(`test-seed-${i}`);
        expect(paymentService.DECLINE_REASONS).toContain(reason);
      }
    });
  });
});
