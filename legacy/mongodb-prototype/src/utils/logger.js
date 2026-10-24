/**
 * Structured logger for distributed node events and booking operations.
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
  durationMs = null
}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    nodeId: nodeId || process.env.NODE_ID || 'UNKNOWN_NODE',
    transactionId: transactionId || 'N/A',
    flightId: flightId ? String(flightId) : 'N/A',
    seatNumber: seatNumber || 'N/A',
    operation: operation || 'BOOKING',
    retryCount,
    result, // e.g., 'SUCCESS', 'SEAT_UNAVAILABLE', 'VERSION_CONFLICT', 'ROLLBACK', 'IDEMPOTENT_HIT'
    ...(error ? { error: error.message || String(error), errorCode: error.code } : {}),
    ...(durationMs !== null ? { durationMs } : {})
  };

  const output = JSON.stringify(logEntry);
  if (result === 'SUCCESS' || result === 'IDEMPOTENT_HIT') {
    console.log(`[BOOKING_LOG] ${output}`);
  } else {
    console.warn(`[BOOKING_LOG] ${output}`);
  }
}

function info(message, meta = {}) {
  console.log(`[INFO] [${new Date().toISOString()}] [${process.env.NODE_ID || 'NODE'}]: ${message}`, Object.keys(meta).length ? JSON.stringify(meta) : '');
}

function error(message, meta = {}) {
  console.error(`[ERROR] [${new Date().toISOString()}] [${process.env.NODE_ID || 'NODE'}]: ${message}`, Object.keys(meta).length ? JSON.stringify(meta) : '');
}

module.exports = {
  logBookingEvent,
  info,
  error
};
