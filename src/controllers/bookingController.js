/**
 * Booking endpoints.
 *
 * Two rules are enforced here rather than in the service, and both are about HTTP
 * rather than about bookings:
 *
 *   1. The status code. A fresh booking is 201, an idempotent replay of one is 200,
 *      and an accepted-but-not-yet-settled booking is 202 — three different answers a
 *      client must be able to tell apart without inspecting the body. The service
 *      decides *which* happened; the controller's job is to say so in the status line
 *      and in the `Idempotent-Replay` header.
 *   2. Ownership failures look like absence. A booking that exists but belongs to
 *      someone else answers 404, not 403, so the endpoint cannot be used to enumerate
 *      which booking ids are real.
 */
const bookingService = require('../services/bookingService');
const errors = require('../utils/errors');
const { resolveBookingUser } = require('../middleware/authenticate');
const { readIdempotencyKey } = require('../middleware/idempotencyKey');
const { ok, idempotencyHeaders } = require('../http/respond');

/**
 * Maps an ownership rejection to a 404.
 *
 * The service refuses another user's booking with FORBIDDEN, which is the correct
 * statement of *why*, and then the HTTP contract asks for it to be reported as
 * absence. Translating at the boundary keeps the service's check as the single
 * enforcement point: if the ownership rule changes, this follows it, whereas a
 * duplicated check in the controller would not.
 *
 * Only the ownership rejection is translated. The service throws ForbiddenError from
 * exactly one place in the cancellation path, and the assertion below holds the
 * translation to that: a different forbidden reason must surface as forbidden, not be
 * disguised as a missing booking.
 */
function notFoundInsteadOfForbidden(err, resource) {
  if (!(err instanceof errors.ForbiddenError)) return err;
  return new errors.NotFoundError('Booking not found', resource);
}

async function create(req, res) {
  const body = req.body;
  const idempotencyKey = readIdempotencyKey(req);

  const result = await bookingService.createBooking({
    userId: resolveBookingUser(req),
    flightId: body.flightId,
    cabin: body.cabin || null,
    passengerName: body.passengerName,
    // `passengerId` is the request's guest-attribution field and `passengerRef` is the
    // external passenger identifier; the service stores one external reference, so
    // either spelling fills it. `passengerRef` wins when both are sent, because it is
    // the more specific name.
    passengerRef: body.passengerRef || body.passengerId || null,
    // Seat numbers are stored uppercase (the column's pattern is `^[0-9]{1,3}[A-Z]$`),
    // and the route accepts either case, so the canonical form is chosen here rather
    // than by rejecting a lowercase "12a" the user reasonably typed.
    seatNumber: body.seatNumber ? String(body.seatNumber).toUpperCase() : null,
    expectedVersion: body.expectedVersion === undefined ? null : body.expectedVersion,
    idempotencyKey,
    // `injectPaymentFailure` exists for tests and is never reachable from HTTP: it
    // would let any caller burn a hold and a saga attempt at will. `nodeId` is left
    // unset so the service uses the node this process actually is.
  });

  return ok(res, result.booking, {
    statusCode: result.statusCode,
    headers: idempotencyHeaders({ replayed: result.replayed === true, idempotencyKey })
  });
}

async function get(req, res) {
  const booking = await bookingService.getBooking({ bookingId: req.params.bookingId });

  if (!isVisible(booking, req.user)) {
    throw new errors.NotFoundError('Booking not found', { bookingId: req.params.bookingId });
  }

  return ok(res, booking);
}

async function getByReference(req, res) {
  const booking = await bookingService.getBookingByReference({
    bookingReference: req.params.bookingReference
  });

  if (!isVisible(booking, req.user)) {
    throw new errors.NotFoundError('Booking not found', {
      bookingReference: req.params.bookingReference
    });
  }

  return ok(res, booking);
}

async function cancel(req, res) {
  // The route requires a bearer token, so a booking created anonymously (attributed to
  // the guest user while REQUIRE_AUTH_FOR_BOOKING is off) can be cancelled only by an
  // admin. That asymmetry is deliberate: cancelling releases inventory and refunds a
  // payment, and there is no way to prove an anonymous caller is the same anonymous
  // caller who booked.
  const isAdmin = String(req.user.role || '').toUpperCase() === 'ADMIN';

  try {
    const result = await bookingService.cancelBooking({
      bookingId: req.params.bookingId,
      userId: req.user.userId,
      isAdmin,
      reason: req.body && req.body.reason ? req.body.reason : 'USER_CANCELLED'
    });

    return ok(res, result.booking);
  } catch (err) {
    throw notFoundInsteadOfForbidden(err, { bookingId: req.params.bookingId });
  }
}

/** The owner sees their booking; an admin sees any. Everyone else sees nothing. */
function isVisible(booking, user) {
  if (!user) return false;
  if (String(user.role || '').toUpperCase() === 'ADMIN') return true;
  return String(booking.userId) === String(user.userId);
}

module.exports = { create, get, getByReference, cancel, isVisible, notFoundInsteadOfForbidden };
