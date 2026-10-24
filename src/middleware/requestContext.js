/**
 * Per-request correlation context.
 *
 * A request touches several instances, log lines and (across the CQRS read model)
 * a lagged projection, so "which request produced this line?" is impossible to
 * answer from a duration alone. This middleware stamps every request with an id and
 * the emitting node, echoes both back as response headers, and hangs the bundle off
 * `req.context` so later middleware and handlers can attach it to their own logs.
 *
 * The inbound id is trusted only when it is a short, sane string: an attacker could
 * otherwise inject arbitrary text (newlines, log-structured payloads) into every
 * downstream log line, or blow up log records with megabytes of junk.
 */
const env = require('../config/env');
const { HEADERS } = require('../config/constants');
const { newUuid } = require('../utils/ids');

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * An id is usable only if it is a non-empty string within the length budget.
 * We deliberately do not constrain the character set beyond that: clients commonly
 * pass W3C traceparent-style values or UUIDs and we want to preserve them verbatim
 * for cross-system correlation.
 */
function isSaneRequestId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_REQUEST_ID_LENGTH;
}

function readInboundRequestId(req) {
  // `req.get` is case-insensitive and present on real Express requests; fall back to
  // the raw header bag so this also works with the lightweight fakes used in tests.
  if (typeof req.get === 'function') {
    const viaGetter = req.get(REQUEST_ID_HEADER);
    if (typeof viaGetter === 'string') return viaGetter;
  }
  const raw = req.headers ? req.headers[REQUEST_ID_HEADER] : undefined;
  return typeof raw === 'string' ? raw : null;
}

function requestContext(req, res, next) {
  const inbound = readInboundRequestId(req);
  const requestId = isSaneRequestId(inbound) ? inbound.trim() : newUuid();

  req.context = {
    requestId,
    nodeId: env.NODE_ID,
    startedAt: Date.now()
  };

  // Echo the identity back so a client that received a failure can quote the id in
  // a support ticket and we can pull the matching log lines immediately.
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.setHeader(HEADERS.NODE_ID, env.NODE_ID);

  next();
}

/** Safe accessor for code paths that may run before (or without) this middleware. */
function getRequestId(req) {
  return (req && req.context && req.context.requestId) || null;
}

module.exports = requestContext;
module.exports.getRequestId = getRequestId;
