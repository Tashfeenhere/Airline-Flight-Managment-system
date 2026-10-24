/**
 * Unit tests for the central error handler.
 *
 * The translator is tested directly (its mapping table is the contract clients see),
 * and the middleware is driven with fake req/res objects — no supertest and no server
 * needed, because the whole point of the handler is that it is a pure function of
 * (err, res).
 */
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  logBookingEvent: jest.fn()
}));

const errorHandler = require('../../src/middleware/errorHandler');
const { translatePgError } = errorHandler;
const env = require('../../src/config/env');
const { HTTP_STATUS, ERROR_CODES } = require('../../src/config/constants');
const { ValidationError } = require('../../src/utils/errors');

/** Minimal chainable Express response double. */
function createRes() {
  return {
    headersSent: false,
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader() {}
  };
}

function createReq(overrides = {}) {
  return {
    method: 'POST',
    path: '/api/bookings',
    headers: {},
    context: { requestId: 'req-test-1', nodeId: env.NODE_ID, startedAt: Date.now() },
    ...overrides
  };
}

describe('translatePgError', () => {
  test('23505 on uq_live_seat -> 409 SEAT_UNAVAILABLE', () => {
    const result = translatePgError({ code: '23505', constraint: 'uq_live_seat' });
    expect(result).toMatchObject({
      statusCode: HTTP_STATUS.CONFLICT,
      code: ERROR_CODES.SEAT_UNAVAILABLE
    });
    expect(result.message).toMatch(/seat/i);
  });

  test('23505 on uq_users_email -> 409 DUPLICATE_USER', () => {
    const result = translatePgError({ code: '23505', constraint: 'uq_users_email' });
    expect(result).toMatchObject({
      statusCode: HTTP_STATUS.CONFLICT,
      code: ERROR_CODES.DUPLICATE_USER
    });
  });

  test('23505 on uq_booking_idempotency -> 409 DUPLICATE_BOOKING', () => {
    const result = translatePgError({ code: '23505', constraint: 'uq_booking_idempotency' });
    expect(result).toMatchObject({
      statusCode: HTTP_STATUS.CONFLICT,
      code: ERROR_CODES.DUPLICATE_BOOKING
    });
  });

  test('23514 on inv_capacity -> 500 INVENTORY_INVARIANT_VIOLATION', () => {
    const result = translatePgError({ code: '23514', constraint: 'inv_capacity' });
    expect(result).toMatchObject({
      statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INVENTORY_INVARIANT_VIOLATION
    });
  });

  test('40001 (serialization failure) -> 503 TRANSIENT_TRANSACTION_ERROR', () => {
    const result = translatePgError({ code: '40001' });
    expect(result).toMatchObject({
      statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
      code: ERROR_CODES.TRANSIENT_TRANSACTION_ERROR
    });
  });

  test('57014 (statement timeout) -> 504', () => {
    const result = translatePgError({ code: '57014' });
    expect(result.statusCode).toBe(HTTP_STATUS.GATEWAY_TIMEOUT);
  });

  test('returns null for an ordinary Error', () => {
    expect(translatePgError(new Error('boom'))).toBeNull();
  });

  test('returns null for a non-PG AppError code', () => {
    expect(translatePgError(new ValidationError('nope'))).toBeNull();
  });
});

describe('errorHandler middleware', () => {
  test('writes the error envelope with the translated PG status', () => {
    const res = createRes();
    const next = jest.fn();

    errorHandler({ code: '23505', constraint: 'uq_live_seat' }, createReq(), res, next);

    expect(res.statusCode).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: ERROR_CODES.SEAT_UNAVAILABLE },
      nodeId: env.NODE_ID
    });
    expect(typeof res.body.timestamp).toBe('string');
    expect(next).not.toHaveBeenCalled();
  });

  test('uses an AppError status, code and message verbatim', () => {
    const res = createRes();
    errorHandler(new ValidationError('Request validation failed', { source: 'body' }), createReq(), res, jest.fn());

    expect(res.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(res.body.error.message).toBe('Request validation failed');
    expect(res.body.error.details).toEqual({ source: 'body' });
  });

  test('translates a JSON body parse failure to 400 VALIDATION_ERROR', () => {
    const res = createRes();
    const err = Object.assign(new SyntaxError('Unexpected token'), {
      type: 'entity.parse.failed',
      status: 400
    });

    errorHandler(err, createReq(), res, jest.fn());

    expect(res.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(res.body.error.message).toBe('Request body is not valid JSON');
  });

  test('never leaks the real message or stack for an unknown error', () => {
    const res = createRes();
    const err = new Error('relation "secret_table" does not exist');

    errorHandler(err, createReq(), res, jest.fn());

    expect(res.statusCode).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR);
    expect(res.body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(res.body.error.message).not.toContain('secret_table');
    expect(res.body.error.message).toBe('Internal server error');
  });

  test('delegates to next(err) once headers are sent', () => {
    const res = createRes();
    res.headersSent = true;
    const err = new Error('too late');
    const next = jest.fn();

    errorHandler(err, createReq(), res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.body).toBeNull();
  });
});
