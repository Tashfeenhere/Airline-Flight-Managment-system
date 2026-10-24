/**
 * Unit tests for the dependency-free request validator.
 *
 * These exercise the two things that are easy to get wrong and expensive to debug in
 * production: string->type coercion from query/params, and the whitelist that keeps
 * undeclared body keys out of the cleaned object.
 */
const validate = require('../../src/middleware/validate');

const { validate: validateFactory, isUuid, parseDateOnly, coerce } = validate;

/** Runs a middleware with a minimal fake req and returns the jest `next` mock. */
function run(middleware, req) {
  const next = jest.fn();
  const res = {};
  middleware(req, res, next);
  return next;
}

describe('validate — pure helpers', () => {
  describe('coerce', () => {
    test('coerces query strings to number and integer', () => {
      expect(coerce('42', 'number')).toEqual({ ok: true, value: 42 });
      expect(coerce('3', 'integer')).toEqual({ ok: true, value: 3 });
    });

    test('integer rejects a fractional value that number accepts', () => {
      expect(coerce('1.5', 'integer').ok).toBe(false);
      expect(coerce('1.5', 'number')).toEqual({ ok: true, value: 1.5 });
    });

    test('coerces boolean strings and rejects junk', () => {
      expect(coerce('true', 'boolean')).toEqual({ ok: true, value: true });
      expect(coerce('false', 'boolean')).toEqual({ ok: true, value: false });
      expect(coerce('1', 'boolean')).toEqual({ ok: true, value: true });
      expect(coerce('0', 'boolean')).toEqual({ ok: true, value: false });
      expect(coerce('maybe', 'boolean').ok).toBe(false);
    });

    test('never accepts NaN or Infinity', () => {
      expect(coerce('NaN', 'number').ok).toBe(false);
      expect(coerce('Infinity', 'number').ok).toBe(false);
      expect(coerce(Number.POSITIVE_INFINITY, 'number').ok).toBe(false);
      expect(coerce('', 'number').ok).toBe(false);
    });

    test('string type is strict — a number is not silently stringified', () => {
      expect(coerce('abc', 'string')).toEqual({ ok: true, value: 'abc' });
      expect(coerce(42, 'string').ok).toBe(false);
    });
  });

  describe('isUuid', () => {
    test('accepts a UUIDv7 as well as a v4', () => {
      expect(isUuid('018f0a1e-7c00-7000-8000-000000000000')).toBe(true);
      expect(isUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
      expect(isUuid('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(true);
    });

    test('rejects anything that is not the 8-4-4-4-12 hex shape', () => {
      expect(isUuid('not-a-uuid')).toBe(false);
      expect(isUuid('018f0a1e-7c00-7000-8000-00000000000')).toBe(false);
      expect(isUuid('018f0a1e7c0070008000000000000000')).toBe(false);
      expect(isUuid(null)).toBe(false);
    });

    test('coerce lower-cases a valid uuid', () => {
      expect(coerce('F47AC10B-58CC-4372-A567-0E02B2C3D479', 'uuid')).toEqual({
        ok: true,
        value: 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
      });
    });
  });

  describe('parseDateOnly', () => {
    test('accepts a real calendar date and returns the string', () => {
      expect(parseDateOnly('2026-03-01')).toBe('2026-03-01');
      expect(parseDateOnly('2028-02-29')).toBe('2028-02-29');
    });

    test('rejects an impossible date such as 2026-02-31', () => {
      expect(parseDateOnly('2026-02-31')).toBeNull();
      expect(parseDateOnly('2026-13-01')).toBeNull();
      expect(parseDateOnly('2026-2-3')).toBeNull();
      expect(parseDateOnly('2026-02-29')).toBeNull(); // 2026 is not a leap year
    });
  });
});

describe('validate — middleware', () => {
  test('coerces query strings and returns a cleaned object', () => {
    const req = { query: { page: '3', price: '12.5', active: 'true' } };
    const next = run(
      validate({
        query: {
          page: { type: 'integer' },
          price: { type: 'number' },
          active: { type: 'boolean' }
        }
      }),
      req
    );

    expect(next).toHaveBeenCalledWith();
    expect(req.query).toEqual({ page: 3, price: 12.5, active: true });
  });

  test('drops unknown keys (whitelist / mass-assignment defence)', () => {
    const req = {
      body: { email: 'a@b.com', role: 'ADMIN', isAdmin: true }
    };
    const next = run(validate({ body: { email: { type: 'string', required: true } } }), req);

    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ email: 'a@b.com' });
    expect(req.body).not.toHaveProperty('role');
  });

  test('collects every failure in a single ValidationError', () => {
    const req = { body: { age: 'abc', email: 'nope' } };
    const next = run(
      validate({
        body: {
          age: { type: 'integer' },
          email: { type: 'string', pattern: /@/ }
        }
      }),
      req
    );

    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details.source).toBe('body');
    expect(err.details.fields).toHaveLength(2);
    expect(err.details.fields.map((entry) => entry.path)).toEqual(['age', 'email']);
  });

  test('names the constraint for enum and pattern failures', () => {
    const enumReq = { body: { cabin: 'SUITE' } };
    const enumNext = run(
      validate({ body: { cabin: { type: 'string', enum: ['ECONOMY', 'BUSINESS'] } } }),
      enumReq
    );
    expect(enumNext.mock.calls[0][0].details.fields[0].message).toMatch(
      /must be one of: ECONOMY, BUSINESS/
    );

    const patternReq = { body: { reference: 'xyz' } };
    const patternNext = run(
      validate({ body: { reference: { type: 'string', pattern: /^BK-/ } } }),
      patternReq
    );
    expect(patternNext.mock.calls[0][0].details.fields[0].message).toMatch(/must match pattern/);
  });

  test('applies a default only when the field is absent', () => {
    const middleware = validate({ query: { limit: { type: 'integer', default: 20 } } });

    const absentReq = { query: {} };
    run(middleware, absentReq);
    expect(absentReq.query).toEqual({ limit: 20 });

    const presentReq = { query: { limit: '5' } };
    run(middleware, presentReq);
    expect(presentReq.query).toEqual({ limit: 5 });
  });

  test('omits an absent optional field entirely so SQL defaults apply', () => {
    const req = { query: { page: '1' } };
    run(validate({ query: { page: { type: 'integer' }, cabin: { type: 'string' } } }), req);

    expect(req.query).toEqual({ page: 1 });
    expect(Object.prototype.hasOwnProperty.call(req.query, 'cabin')).toBe(false);
  });

  test('reports a missing required field', () => {
    const next = run(validate({ body: { email: { type: 'string', required: true } } }), { body: {} });
    const err = next.mock.calls[0][0];
    expect(err.details.fields[0]).toMatchObject({ path: 'email' });
    expect(err.details.fields[0].message).toMatch(/required/);
  });

  test('rejects an invalid date in the body', () => {
    const next = run(validate({ body: { departureDate: { type: 'date' } } }), {
      body: { departureDate: '2026-02-31' }
    });
    const err = next.mock.calls[0][0];
    expect(err.details.fields[0].path).toBe('departureDate');
  });

  test('accepts a UUIDv7 path parameter', () => {
    const req = { params: { bookingId: '018f0a1e-7c00-7000-8000-000000000000' } };
    const next = run(validate({ params: { bookingId: { type: 'uuid', required: true } } }), req);
    expect(next).toHaveBeenCalledWith();
    expect(req.params.bookingId).toBe('018f0a1e-7c00-7000-8000-000000000000');
  });

  test('validates array items with their own rule', () => {
    const next = run(
      validate({ body: { seats: { type: 'array', items: { type: 'integer' } } } }),
      { body: { seats: [1, '2', 'x'] } }
    );
    const err = next.mock.calls[0][0];
    expect(err.details.fields).toHaveLength(1);
    expect(err.details.fields[0].path).toBe('seats[2]');
  });

  test('the factory and the default export are the same function', () => {
    expect(validateFactory).toBe(validate);
  });
});
