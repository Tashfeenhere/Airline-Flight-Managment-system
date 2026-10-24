/**
 * Structured JSON logger.
 *
 * One line per event, machine-parseable, with the node id attached so logs from
 * several API instances can be correlated. `logBookingEvent` keeps the original
 * prototype's `[BOOKING_LOG]` shape so existing dashboards keep working.
 */
const env = require('../config/env');

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });
const activeLevel = LEVELS[env.LOG_LEVEL] !== undefined ? LEVELS[env.LOG_LEVEL] : LEVELS.info;

function emit(level, message, meta = {}) {
  if (LEVELS[level] > activeLevel) return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    nodeId: env.NODE_ID,
    message,
    ...meta
  };

  // Errors are not JSON-serializable in a useful way; flatten them.
  if (payload.error instanceof Error) {
    payload.error = {
      name: payload.error.name,
      message: payload.error.message,
      code: payload.error.code,
      stack: env.isProduction ? undefined : payload.error.stack
    };
  }

  const line = JSON.stringify(payload, (key, value) =>
    key === 'stack' && value === undefined ? undefined : value
  );

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Booking-domain event log retained from the prototype (stable field names).
 */
function logBookingEvent({
  nodeId,
  transactionId,
  flightId,
  seatNumber,
  operation,
  retryCount = 0,
  result,
  error = null,
  durationMs = null,
  ...extra
}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    nodeId: nodeId || env.NODE_ID || 'UNKNOWN_NODE',
    transactionId: transactionId || 'N/A',
    flightId: flightId ? String(flightId) : 'N/A',
    seatNumber: seatNumber || null,
    operation: operation || 'BOOKING',
    retryCount,
    result,
    ...(error ? { error: error.message || String(error), errorCode: error.code } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
    ...extra
  };

  const output = JSON.stringify(logEntry);
  if (result === 'SUCCESS' || result === 'IDEMPOTENT_HIT') {
    console.log(`[BOOKING_LOG] ${output}`);
  } else {
    console.warn(`[BOOKING_LOG] ${output}`);
  }
}

module.exports = {
  logBookingEvent,
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
  debug: (message, meta) => emit('debug', message, meta)
};
