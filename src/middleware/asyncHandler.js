/**
 * Promise-aware wrapper for async route handlers.
 *
 * Express 4 predates async/await and does not understand a returned promise: if an
 * `async` handler rejects (a failed query, a thrown business error), Express never
 * sees it. The rejection becomes an unhandled rejection and the request hangs
 * forever with no response — the socket eventually times out and the operator has
 * nothing in the logs explaining why. Wrapping the handler forwards every rejection
 * into the normal `next(err)` pipeline so the central error handler can translate it.
 *
 * Express 5 will do this itself, but the codebase targets Express 4.
 */
function asyncHandler(fn) {
  return function wrappedHandler(req, res, next) {
    // `Promise.resolve` tolerates a handler that occasionally returns a plain value
    // while still catching a synchronously thrown error from an async function body.
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
