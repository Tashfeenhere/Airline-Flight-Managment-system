/**
 * Retry policy for transient database failures.
 *
 * Retrying is only correct for conditions where the transaction provably did not
 * commit. PostgreSQL exposes that as a small set of SQLSTATEs; everything else is
 * either a business outcome (constraint violation) or a bug (syntax, undefined
 * column) and must surface unchanged.
 *
 * Explicitly NOT retryable, and why:
 *   40003 statement_completion_unknown — the transaction may have committed;
 *         replaying could double-apply a booking. Requires reconciliation instead.
 *   25P02 in_failed_sql_transaction     — we are inside an aborted transaction;
 *         a logic error, not a transient condition.
 *   23505 unique_violation              — a real conflict (seat taken, duplicate
 *         idempotency key); handled by the caller as a 409.
 *   22xxx / 42xxx / 28xxx               — data, syntax and auth errors are permanent.
 *   0A000 / 25001                       — Citus feature/placement errors: retrying
 *         does not make an unsupported operation supported.
 */
const env = require('../config/env');
const { RETRYABLE_PG_CODES } = require('../config/constants');

const RETRYABLE = new Set([
  RETRYABLE_PG_CODES.SERIALIZATION_FAILURE, // 40001
  RETRYABLE_PG_CODES.DEADLOCK_DETECTED, // 40P01
  RETRYABLE_PG_CODES.LOCK_NOT_AVAILABLE, // 55P03 (lock_timeout)
  RETRYABLE_PG_CODES.CANNOT_CONNECT_NOW, // 57P03
  RETRYABLE_PG_CODES.SYSTEM_ERROR, // 58000
  RETRYABLE_PG_CODES.IO_ERROR, // 58030
  RETRYABLE_PG_CODES.CONNECTION_FAILURE, // 08006
  RETRYABLE_PG_CODES.CONNECTION_DOES_NOT_EXIST, // 08003
  RETRYABLE_PG_CODES.CONNECTION_REJECTED, // 08004
  RETRYABLE_PG_CODES.TOO_MANY_CONNECTIONS, // 53300
  RETRYABLE_PG_CODES.ADMIN_SHUTDOWN, // 57P01
  RETRYABLE_PG_CODES.CRASH_SHUTDOWN, // 57P02
  RETRYABLE_PG_CODES.OUT_OF_MEMORY // 53200
]);

const NEVER_RETRYABLE = new Set([
  '40003', // statement_completion_unknown
  '25P02', // in_failed_sql_transaction
  '0A000', // feature_not_supported (incl. Citus unsupported DDL)
  '25001', // active_sql_transaction (Citus placement in use)
  '23505', // unique_violation
  '23P01', // exclusion_violation
  '23514', // check_violation
  '22P02' // invalid_text_representation (e.g. malformed UUID)
]);

/** Node-level network errors that justify replaying the transaction. */
const RETRYABLE_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED'
]);

function isTransientError(error) {
  if (!error) return false;
  if (error.noRetry) return false;

  // Our own wrapper (thrown after retries are exhausted or by a caller).
  if (error.code === 'TRANSIENT_TRANSACTION_ERROR') return true;

  const code = typeof error.code === 'string' ? error.code : null;
  if (code && NEVER_RETRYABLE.has(code)) return false;
  if (code && RETRYABLE.has(code)) return true;
  if (code && RETRYABLE_NODE_CODES.has(code)) return true;

  // Connection-level failures from `pg` sometimes arrive with only a message.
  const message = String(error.message || '');
  if (/Connection terminated|connection terminated unexpectedly|server closed the connection/i.test(message)) {
    return true;
  }
  if (/could not connect to any active placements|failed to execute task|connection to the remote node/i.test(message)) {
    // Citus worker unreachable: the local coordinator-side work rolls back, so the
    // whole transaction may be replayed.
    return true;
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes `operationFn(attempt)` with bounded exponential backoff and full jitter.
 * The operation must be a whole transaction, not a single statement.
 */
async function executeWithRetry(operationFn, options = {}) {
  const maxRetries = options.maxRetries ?? env.MAX_RETRIES;
  const initialDelayMs = options.initialDelayMs ?? env.RETRY_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? env.RETRY_MAX_DELAY_MS;
  const onRetry = options.onRetry;

  let attempt = 0;

  for (;;) {
    try {
      return await operationFn(attempt);
    } catch (err) {
      attempt += 1;

      if (isTransientError(err) && attempt <= maxRetries) {
        const exponentialDelay = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
        const jitteredDelay = Math.floor(Math.random() * exponentialDelay) + 1;
        if (onRetry) onRetry(err, attempt, jitteredDelay);
        await sleep(jitteredDelay);
        continue;
      }

      err.attemptCount = attempt;
      throw err;
    }
  }
}

module.exports = {
  isTransientError,
  executeWithRetry,
  RETRYABLE,
  NEVER_RETRYABLE
};
