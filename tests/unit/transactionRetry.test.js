/**
 * Unit tests for the transient-failure retry policy.
 *
 * The stake here is not "does it retry" but "does it retry *only* what is safe". Retrying
 * a transaction that may have committed double-applies a booking; retrying a data error
 * loops pointlessly. Each case below is a claim the design rests on:
 *
 *   - 40001/40P01 (serialization, deadlock) are transient and MUST retry;
 *   - 40003 (statement_completion_unknown) means "maybe committed" and must NEVER retry;
 *   - 23505 (unique violation) is a business outcome (seat taken / duplicate key) and must
 *     surface, not retry;
 *   - 22xxx/42xxx (data/syntax) and 0A000/25001 (Citus unsupported) are permanent.
 */
const { isTransientError, executeWithRetry, RETRYABLE, NEVER_RETRYABLE } = require('../../src/concurrency/transactionRetry');

describe('isTransientError — retryable set', () => {
  test.each([
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock_detected'],
    ['55P03', 'lock_not_available'],
    ['57P03', 'cannot_connect_now'],
    ['58000', 'system_error'],
    ['58030', 'io_error'],
    ['08006', 'connection_failure'],
    ['08003', 'connection_does_not_exist'],
    ['08004', 'connection_rejected'],
    ['53300', 'too_many_connections'],
    ['57P01', 'admin_shutdown'],
    ['57P02', 'crash_shutdown'],
    ['53200', 'out_of_memory']
  ])('%s (%s) is transient', (code) => {
    expect(isTransientError({ code })).toBe(true);
  });

  test('outbound connection-level node errors are transient', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ETIMEDOUT']) {
      expect(isTransientError({ code })).toBe(true);
    }
  });

  test('connection loss reported only in the message is transient', () => {
    expect(isTransientError({ message: 'Connection terminated unexpectedly' })).toBe(true);
    expect(isTransientError({ message: 'server closed the connection unexpectedly' })).toBe(true);
  });

  test('a Citus worker-unreachable message is transient', () => {
    expect(isTransientError({ message: 'could not connect to any active placements' })).toBe(true);
  });
});

describe('isTransientError — never retryable', () => {
  test.each([
    ['40003', 'statement_completion_unknown'],
    ['25P02', 'in_failed_sql_transaction'],
    ['0A000', 'feature_not_supported'],
    ['25001', 'active_sql_transaction'],
    ['23505', 'unique_violation'],
    ['23P01', 'exclusion_violation'],
    ['23514', 'check_violation'],
    ['22P02', 'invalid_text_representation'],
    ['42601', 'syntax_error'],
    ['42P01', 'undefined_table']
  ])('%s (%s) is NOT transient', (code) => {
    expect(isTransientError({ code })).toBe(false);
  });

  test('40003 specifically must never retry — it may have committed', () => {
    // Guards against a future edit that adds "all 40xxx" to the retryable set.
    expect(NEVER_RETRYABLE.has('40003')).toBe(true);
    expect(RETRYABLE.has('40003')).toBe(false);
  });

  test('no code is in both sets', () => {
    for (const code of RETRYABLE) expect(NEVER_RETRYABLE.has(code)).toBe(false);
  });

  test('noRetry wins over a transient code', () => {
    expect(isTransientError({ code: '40001', noRetry: true })).toBe(false);
  });

  test('null/undefined and unknown errors are not retried', () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError(new Error('something else'))).toBe(false);
  });
});

describe('executeWithRetry', () => {
  test('returns a successful result on the first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(executeWithRetry(fn, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries a transient failure and then succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce({ code: '40001' })
      .mockResolvedValueOnce('ok');
    await expect(executeWithRetry(fn, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('rethrows a NON-transient failure immediately, without retrying', async () => {
    const err = { code: '23505', message: 'duplicate' };
    const fn = jest.fn().mockRejectedValue(err);
    await expect(executeWithRetry(fn, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(err.attemptCount).toBe(1);
  });

  test('gives up after maxRetries and rethrows with an attempt count', async () => {
    const err = { code: '40001' };
    const fn = jest.fn().mockRejectedValue(err);
    await expect(executeWithRetry(fn, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 })).rejects.toBe(err);
    // 1 initial + 2 retries.
    expect(fn).toHaveBeenCalledTimes(3);
    expect(err.attemptCount).toBe(3);
  });

  test('calls onRetry with the error and attempt number', async () => {
    const fn = jest.fn().mockRejectedValueOnce({ code: '40P01' }).mockResolvedValueOnce('ok');
    const onRetry = jest.fn();
    await executeWithRetry(fn, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][1]).toBe(1);
  });
});
