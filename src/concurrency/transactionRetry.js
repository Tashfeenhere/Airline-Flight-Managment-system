const env = require('../config/env');

/**
 * Checks if a MongoDB error is considered transient and eligible for retry.
 */
function isTransientError(error) {
  if (!error) return false;

  // MongoDB driver ErrorLabels
  if (typeof error.hasErrorLabel === 'function') {
    if (error.hasErrorLabel('TransientTransactionError')) return true;
    if (error.hasErrorLabel('UnknownTransactionCommitResult')) return true;
  }
  if (Array.isArray(error.errorLabels)) {
    if (error.errorLabels.includes('TransientTransactionError')) return true;
    if (error.errorLabels.includes('UnknownTransactionCommitResult')) return true;
  }

  // MongoDB Error Codes: 112 = WriteConflict
  if (error.code === 112 || error.name === 'WriteConflict') {
    return true;
  }

  return false;
}

/**
 * Sleep helper for exponential backoff with randomized jitter.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an async operation with retry logic for transient database conflicts.
 * Permanent errors (business validation, seat already booked, etc.) are NOT retried.
 */
async function executeWithRetry(operationFn, options = {}) {
  const maxRetries = options.maxRetries ?? env.MAX_RETRIES;
  const initialDelayMs = options.initialDelayMs ?? env.RETRY_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? env.RETRY_MAX_DELAY_MS;

  let attempt = 0;

  while (true) {
    try {
      return await operationFn(attempt);
    } catch (err) {
      attempt++;

      // Only retry if error is transient AND we haven't exceeded maxRetries
      if (isTransientError(err) && attempt <= maxRetries) {
        // Full jitter exponential backoff: random between 0 and min(maxDelay, initialDelay * 2^attempt)
        const exponentialDelay = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt));
        const jitteredDelay = Math.floor(Math.random() * exponentialDelay) + 5;

        await sleep(jitteredDelay);
        continue;
      }

      // Re-throw permanent or exhausted retry errors
      err.attemptCount = attempt;
      throw err;
    }
  }
}

module.exports = {
  isTransientError,
  executeWithRetry
};
