'use strict';
/**
 * Jest `setupFiles` entry — runs ONCE per test file, before the test framework and,
 * crucially, before anything `require`s `src/config/env.js`, which snapshots
 * `process.env` into a frozen object at load time. Setting these here is the only
 * place they still take effect for the module graph under test.
 *
 * Jest already sets `NODE_ENV=test`, which flips `env.isTest` true (rate limiting off,
 * logs at `error`). The rest make the booking path's behaviour explicit and independent
 * of whatever shell launched jest, so a developer's exported `PAYMENT_FAILURE_RATE=0.3`
 * cannot silently turn the whole suite red.
 *
 * Connection URLs are deliberately NOT set: the defaults in env.js already point at the
 * local cluster (127.0.0.1:55432), and CI exports real ones. Overriding here would mean
 * two places to keep in sync.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'error';
// Per-call `injectPaymentFailure` drives the compensation tests; the global rate stays
// 0 so no OTHER test fails a payment at random.
process.env.PAYMENT_FAILURE_RATE = process.env.PAYMENT_FAILURE_RATE || '0';
if (!process.env.RATE_LIMIT_ENABLED) process.env.RATE_LIMIT_ENABLED = 'false';
// The assertions read a terminal booking straight out of POST, so the saga must run
// inline rather than being left to the reconciler.
if (!process.env.BOOKING_SAGA_INLINE) process.env.BOOKING_SAGA_INLINE = 'true';
