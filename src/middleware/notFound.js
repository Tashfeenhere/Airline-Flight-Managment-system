/**
 * Terminal 404 for any request that matched no route.
 *
 * It constructs the same AppError family every other failure uses and hands it to
 * `next`, so the response is built by the single error handler and the envelope
 * (success:false, error{code,message,details}, nodeId, timestamp) is byte-for-byte
 * identical to a 404 raised deeper in the stack. Writing a response here directly
 * would create a second place the envelope could drift out of sync.
 */
const { NotFoundError } = require('../utils/errors');

function notFound(req, res, next) {
  // originalUrl preserves the mount path and query string, which is exactly the
  // detail a caller needs to spot a typo in the URL they hit.
  const path = req.originalUrl || req.url || req.path;

  next(
    new NotFoundError(`Route not found: ${req.method} ${path}`, {
      method: req.method,
      path
    })
  );
}

module.exports = notFound;
