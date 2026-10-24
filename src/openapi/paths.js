/**
 * OpenAPI 3.0.3 `paths` and `components` for the Distributed Airline Inventory API.
 *
 * WHY this lives apart from `swaggerSpec.js`: the document is assembled (info,
 * servers, tags) in one place, but the bulk of it - 24 operations and two dozen
 * schemas - is a data structure that benefits from being isolated, greppable and
 * testable on its own. `swaggerSpec.js` is the single import point; nothing should
 * import this file directly except the spec assembler and the OpenAPI tests.
 *
 * Two shape rules drive everything here and are worth stating once:
 *
 *   1. Every 2xx body is `{ success: true, data: <payload> }` and every non-2xx
 *      body is `{ success: false, error: { code, message, details }, nodeId,
 *      timestamp }`. The two envelope schemas are the only places those shapes are
 *      defined; individual operations narrow `data` with `allOf` because OpenAPI
 *      3.0 has no generics.
 *   2. Enum values are pulled from `../config/constants` rather than retyped. A
 *      documented status that drifts from the CHECK constraint in `db/migrations`
 *      is worse than no documentation at all, so the spec is generated from the
 *      same frozen enums the running code uses.
 */
'use strict';

const {
  ERROR_CODES,
  BOOKING_STATUS,
  PAYMENT_STATUS,
  FLIGHT_STATUS,
  SEAT_STATUS,
  USER_ROLES,
  CABINS,
} = require('../config/constants');

// Stable sample values reused across every example so the docs read as one
// coherent session. The ids are UUIDv7-shaped (version nibble 7, variant nibble 8)
// because that is what the database mints via `app_uuidv7()`.
const SAMPLE = Object.freeze({
  flightId: '018f4a3b-2c5d-7e6f-8a90-1b2c3d4e5f60',
  bookingId: '018f4a3b-2c5d-7e6f-9a90-1b2c3d4e5f61',
  userId: '018f4a3b-2c5d-7e6f-aa90-1b2c3d4e5f62',
  paymentId: '018f4a3b-2c5d-7e6f-ba90-1b2c3d4e5f63',
  transactionId: '018f4a3b-2c5d-7e6f-ca90-1b2c3d4e5f64',
  bookingReference: 'BK-7F9A12K4QW',
  nodeId: 'api-local',
  timestamp: '2026-10-13T12:00:00.000Z',
});

// ---------------------------------------------------------------------------
// Small builders. These exist so that the 24 operations below read as their
// contract rather than as boilerplate; each one just assembles the envelope the
// runtime actually emits.
// ---------------------------------------------------------------------------

const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
const parameterRef = (name) => ({ $ref: `#/components/parameters/${name}` });
const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });

/** A success body `{ success: true, data }` for use in an `example`. */
function ok(data) {
  return { success: true, data };
}

/** An error body matching the runtime error handler. */
function err(code, message, details) {
  return {
    success: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
    nodeId: SAMPLE.nodeId,
    timestamp: SAMPLE.timestamp,
  };
}

/** Wraps a payload schema in the success envelope, optionally with an example. */
function successBody(dataSchema, exampleValue) {
  const media = {
    schema: {
      allOf: [
        { $ref: '#/components/schemas/SuccessEnvelope' },
        { type: 'object', required: ['data'], properties: { data: dataSchema } },
      ],
    },
  };
  if (exampleValue !== undefined) media.example = exampleValue;
  return { 'application/json': media };
}

/** An inline error response with one or more named examples. */
function errorBody(description, examples) {
  return {
    description,
    content: {
      'application/json': {
        schema: schemaRef('ErrorEnvelope'),
        examples,
      },
    },
  };
}

/** A request body made of JSON with an example. */
function jsonRequest(schema, exampleValue, required = true) {
  const media = { schema };
  if (exampleValue !== undefined) media.example = exampleValue;
  return { required, content: { 'application/json': media } };
}

/** A UUID path parameter. */
function pathParam(name, description) {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string', format: 'uuid' },
  };
}

const flightIdParam = pathParam('flightId', 'Flight identifier (UUIDv7).');

const paths = {
  // =========================================================================
  // Auth
  // =========================================================================
  '/api/auth/register': {
    post: {
      tags: ['auth'],
      summary: 'Register a passenger account',
      description:
        'Creates a new user. The email is stored lowercase and is unique. Self-registration ' +
        'always creates a PASSENGER; AGENT and ADMIN accounts are provisioned out of band, so a ' +
        '`role` other than PASSENGER is rejected rather than honoured.',
      operationId: 'register',
      security: [],
      requestBody: jsonRequest(schemaRef('RegisterRequest'), {
        email: 'ada.lovelace@example.com',
        password: 'S3cur3-Pa$$w0rd',
        fullName: 'Ada Lovelace',
        phone: '+92-300-1234567',
        role: 'PASSENGER',
      }),
      responses: {
        '201': {
          description: 'Account created. The password hash is never returned.',
          content: successBody(
            schemaRef('PublicUser'),
            ok({
              id: SAMPLE.userId,
              email: 'ada.lovelace@example.com',
              fullName: 'Ada Lovelace',
              phone: '+92-300-1234567',
              role: 'PASSENGER',
              createdAt: '2026-10-13T11:59:00.000Z',
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '409': errorBody('The email is already registered.', {
          DuplicateUser: {
            value: err(ERROR_CODES.DUPLICATE_USER, 'An account with this email already exists', {
              email: 'ada.lovelace@example.com',
            }),
          },
        }),
        '429': responseRef('TooManyRequests'),
      },
    },
  },

  '/api/auth/login': {
    post: {
      tags: ['auth'],
      summary: 'Exchange credentials for a token pair',
      description:
        'Verifies the password and starts a new refresh-token family. The response carries a ' +
        'short-lived access token and a long-lived rotating refresh token.',
      operationId: 'login',
      security: [],
      requestBody: jsonRequest(schemaRef('LoginRequest'), {
        email: 'ada.lovelace@example.com',
        password: 'S3cur3-Pa$$w0rd',
      }),
      responses: {
        '200': {
          description: 'Authenticated. Returns the user plus a fresh token pair.',
          content: successBody(
            {
              allOf: [
                schemaRef('AuthTokens'),
                {
                  type: 'object',
                  required: ['user'],
                  properties: { user: schemaRef('PublicUser') },
                },
              ],
            },
            ok({
              user: {
                id: SAMPLE.userId,
                email: 'ada.lovelace@example.com',
                fullName: 'Ada Lovelace',
                phone: '+92-300-1234567',
                role: 'PASSENGER',
                createdAt: '2026-10-13T11:59:00.000Z',
              },
              accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.access.access',
              refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh.refresh',
              tokenType: 'Bearer',
              expiresIn: 900,
              refreshExpiresIn: 2592000,
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': errorBody('The email or password is wrong.', {
          InvalidCredentials: {
            value: err(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password'),
          },
        }),
        '429': responseRef('TooManyRequests'),
      },
    },
  },

  '/api/auth/refresh': {
    post: {
      tags: ['auth'],
      summary: 'Rotate a refresh token',
      description:
        'Exchanges a refresh token for a new pair and revokes the presented token. Refresh ' +
        'tokens belong to a family; presenting a token that was already rotated means it was ' +
        'stolen, so the whole family is revoked and the user is logged out everywhere ' +
        '(reuse detection).',
      operationId: 'refresh',
      security: [],
      requestBody: jsonRequest(schemaRef('RefreshRequest'), {
        refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh.refresh',
      }),
      responses: {
        '200': {
          description: 'Rotated token pair. The previous refresh token is now inert.',
          content: successBody(
            schemaRef('AuthTokens'),
            ok({
              accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.access.rotated',
              refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh.rotated',
              tokenType: 'Bearer',
              expiresIn: 900,
              refreshExpiresIn: 2592000,
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': errorBody(
          'The refresh token is unknown/revoked (TOKEN_INVALID) or past its expiry ' +
            '(TOKEN_EXPIRED). Reuse of an already-rotated token also revokes the family.',
          {
            TokenInvalid: {
              value: err(ERROR_CODES.TOKEN_INVALID, 'Token is invalid', {
                reason: 'REFRESH_TOKEN_REVOKED',
              }),
            },
            TokenExpired: {
              value: err(ERROR_CODES.TOKEN_EXPIRED, 'Token has expired', {
                reason: 'REFRESH_TOKEN_EXPIRED',
              }),
            },
          }
        ),
        '429': responseRef('TooManyRequests'),
      },
    },
  },

  '/api/auth/logout': {
    post: {
      tags: ['auth'],
      summary: 'Revoke a refresh token',
      description:
        'Revokes the presented refresh token (and, by extension, that device) so it can no ' +
        'longer be rotated. Idempotent: revoking an already-revoked token still answers 200.',
      operationId: 'logout',
      security: [],
      requestBody: jsonRequest(schemaRef('RefreshRequest'), {
        refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh.refresh',
      }),
      responses: {
        '200': {
          description: 'The refresh token is revoked.',
          content: successBody(
            { type: 'object', properties: { revoked: { type: 'boolean', enum: [true] } } },
            ok({ revoked: true })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': responseRef('Unauthorized'),
        '429': responseRef('TooManyRequests'),
      },
    },
  },

  '/api/auth/me': {
    get: {
      tags: ['auth'],
      summary: 'Current authenticated user',
      description: 'Resolves the bearer access token to the caller\'s own user record.',
      operationId: 'getCurrentUser',
      responses: {
        '200': {
          description: 'The caller\'s user record.',
          content: successBody(
            schemaRef('PublicUser'),
            ok({
              id: SAMPLE.userId,
              email: 'ada.lovelace@example.com',
              fullName: 'Ada Lovelace',
              phone: '+92-300-1234567',
              role: 'PASSENGER',
              createdAt: '2026-10-13T11:59:00.000Z',
            })
          ),
        },
        '401': errorBody('Missing, expired or invalid access token.', {
          Unauthenticated: {
            value: err(ERROR_CODES.UNAUTHENTICATED, 'Authentication is required'),
          },
          TokenExpired: {
            value: err(ERROR_CODES.TOKEN_EXPIRED, 'Token has expired'),
          },
        }),
      },
    },
  },

  // =========================================================================
  // Flights (public read endpoints)
  // =========================================================================
  '/api/flights/search': {
    get: {
      tags: ['flights'],
      summary: 'Search flights by route and date',
      description:
        'Reads the CQRS read model (eventually consistent), never the booking shards. A route ' +
        'that is still being projected may be missing entirely; `readModelLagMs` says how stale ' +
        'the answer is. Search is public.',
      operationId: 'searchFlights',
      security: [],
      parameters: [
        {
          name: 'origin',
          in: 'query',
          required: true,
          description: 'Departure airport IATA code (3 letters).',
          schema: { type: 'string', minLength: 3, maxLength: 3, example: 'ISB' },
        },
        {
          name: 'destination',
          in: 'query',
          required: true,
          description: 'Arrival airport IATA code (3 letters).',
          schema: { type: 'string', minLength: 3, maxLength: 3, example: 'LHR' },
        },
        {
          name: 'departureDate',
          in: 'query',
          required: true,
          description: 'Local departure date, YYYY-MM-DD.',
          schema: { type: 'string', format: 'date', example: '2026-11-02' },
        },
        {
          name: 'cabin',
          in: 'query',
          required: false,
          description: 'Filter to a single cabin.',
          schema: { type: 'string', enum: CABINS },
        },
        {
          name: 'passengers',
          in: 'query',
          required: false,
          description: 'Only return flights with at least this many seats left.',
          schema: { type: 'integer', minimum: 1, default: 1, example: 2 },
        },
        parameterRef('Limit'),
        parameterRef('Offset'),
      ],
      responses: {
        '200': {
          description: 'Matching flights plus the read-model freshness.',
          content: successBody(
            {
              type: 'object',
              required: ['flights', 'total', 'readModelLagMs'],
              properties: {
                flights: { type: 'array', items: schemaRef('FlightSearchResult') },
                total: {
                  type: 'integer',
                  description: 'Total matches for the route/date, before limit/offset.',
                },
                readModelLagMs: {
                  type: 'integer',
                  description: 'Age of the newest projected event, in milliseconds.',
                },
              },
            },
            ok({
              flights: [
                {
                  flightId: SAMPLE.flightId,
                  flightNumber: 'PK123',
                  airlineCode: 'PK',
                  origin: 'ISB',
                  destination: 'LHR',
                  departureDate: '2026-11-02',
                  departureTime: '2026-11-02T06:30:00.000Z',
                  arrivalTime: '2026-11-02T10:15:00.000Z',
                  aircraftType: 'A320',
                  status: 'SCHEDULED',
                  lowestPrice: 245.5,
                  currency: 'USD',
                  sourceVersion: 41,
                  updatedAt: '2026-10-13T11:59:58.000Z',
                  cabins: [
                    {
                      cabin: 'ECONOMY',
                      capacity: 180,
                      available: 42,
                      price: 245.5,
                      currency: 'USD',
                      version: 41,
                    },
                  ],
                },
              ],
              total: 1,
              readModelLagMs: 320,
            })
          ),
        },
        '400': errorBody('A required query parameter is missing or malformed.', {
          MissingOrigin: {
            value: err(
              ERROR_CODES.VALIDATION_ERROR,
              'Validation failed',
              { fields: [{ path: 'origin', message: 'origin is required' }] }
            ),
          },
          BadDate: {
            value: err(
              ERROR_CODES.VALIDATION_ERROR,
              'Validation failed',
              { fields: [{ path: 'departureDate', message: 'must be YYYY-MM-DD' }] }
            ),
          },
        }),
        '429': responseRef('TooManyRequests'),
      },
    },
  },

  '/api/flights/{flightId}': {
    get: {
      tags: ['flights'],
      summary: 'Flight detail',
      description:
        'Returns a single flight from the write model, including per-cabin counters. Public.',
      operationId: 'getFlight',
      security: [],
      parameters: [flightIdParam],
      responses: {
        '200': {
          description: 'The flight and its cabin counters.',
          content: successBody(
            schemaRef('Flight'),
            ok({
              flightId: SAMPLE.flightId,
              flightNumber: 'PK123',
              airlineCode: 'PK',
              origin: 'ISB',
              destination: 'LHR',
              departureDate: '2026-11-02',
              departureTime: '2026-11-02T06:30:00.000Z',
              arrivalTime: '2026-11-02T10:15:00.000Z',
              aircraftType: 'A320',
              basePrice: 245.5,
              currency: 'USD',
              status: 'SCHEDULED',
              cabins: [
                { cabin: 'ECONOMY', capacity: 180, available: 42, price: 245.5, version: 41 },
                { cabin: 'BUSINESS', capacity: 12, available: 3, price: 1290.0, version: 8 },
              ],
            })
          ),
        },
        '400': errorBody('The flight id is not a UUID.', {
          InvalidId: {
            value: err(ERROR_CODES.INVALID_ID, 'Invalid id', { param: 'flightId' }),
          },
        }),
        '404': errorBody('No flight with that id.', {
          NotFound: {
            value: err(ERROR_CODES.NOT_FOUND, 'Resource not found', { flightId: SAMPLE.flightId }),
          },
        }),
      },
    },
  },

  '/api/flights/{flightId}/seatmap': {
    get: {
      tags: ['flights'],
      summary: 'Seat map for a flight',
      description:
        'Derives the seat map from the aircraft-type template and overlays seats currently held ' +
        'by live bookings. Public.',
      operationId: 'getSeatMap',
      security: [],
      parameters: [
        flightIdParam,
        {
          name: 'cabin',
          in: 'query',
          required: false,
          description: 'Restrict the map to one cabin.',
          schema: { type: 'string', enum: CABINS },
        },
      ],
      responses: {
        '200': {
          description: 'The seat map.',
          content: successBody(
            schemaRef('SeatMap'),
            ok({
              flightId: SAMPLE.flightId,
              cabin: 'ECONOMY',
              aircraftType: 'A320',
              columns: ['A', 'B', 'C', 'D', 'E', 'F'],
              rows: [1, 2, 3, 4],
              seats: [
                { seatNumber: '1A', status: 'BOOKED', cabin: 'ECONOMY', isExitRow: false },
                { seatNumber: '1B', status: 'AVAILABLE', cabin: 'ECONOMY', isExitRow: false },
                { seatNumber: '12A', status: 'AVAILABLE', cabin: 'ECONOMY', isExitRow: true },
                { seatNumber: '12B', status: 'AVAILABLE', cabin: 'ECONOMY', isExitRow: true },
              ],
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '404': errorBody('No flight with that id.', {
          NotFound: {
            value: err(ERROR_CODES.NOT_FOUND, 'Resource not found', { flightId: SAMPLE.flightId }),
          },
        }),
      },
    },
  },

  '/api/flights/{flightId}/availability': {
    get: {
      tags: ['flights'],
      summary: 'Authoritative availability',
      description:
        'Reads the write model counters (strongly consistent), unlike search which reads the ' +
        'lagged projection. Use this before booking to obtain the current `version`. Public.',
      operationId: 'getAvailability',
      security: [],
      parameters: [
        flightIdParam,
        {
          name: 'cabin',
          in: 'query',
          required: false,
          description: 'Restrict the answer to one cabin.',
          schema: { type: 'string', enum: CABINS },
        },
      ],
      responses: {
        '200': {
          description: 'Per-cabin counters straight from `flight_inventory`.',
          content: successBody(
            {
              type: 'object',
              required: ['flightId', 'cabins'],
              properties: {
                flightId: { type: 'string', format: 'uuid' },
                departureDate: { type: 'string', format: 'date' },
                cabins: { type: 'array', items: schemaRef('Availability') },
              },
            },
            ok({
              flightId: SAMPLE.flightId,
              departureDate: '2026-11-02',
              cabins: [
                {
                  cabin: 'ECONOMY',
                  capacity: 180,
                  available: 42,
                  held: 5,
                  price: 245.5,
                  currency: 'USD',
                  version: 41,
                  shardNo: 0,
                },
              ],
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '404': errorBody('No flight with that id.', {
          NotFound: {
            value: err(ERROR_CODES.NOT_FOUND, 'Resource not found', { flightId: SAMPLE.flightId }),
          },
        }),
        '503': responseRef('ServiceUnavailable'),
      },
    },
  },

  // =========================================================================
  // Bookings
  // =========================================================================
  '/api/bookings': {
    post: {
      tags: ['bookings'],
      summary: 'Create a booking (idempotent)',
      description:
        'Places a hold and runs the payment saga. With `BOOKING_SAGA_INLINE=true` (the default) ' +
        'the response is 201 CONFIRMED; otherwise 202 PENDING. Retrying with the same ' +
        '`Idempotency-Key` and body replays the original result as 200; the same key with a ' +
        'different body is 409 IDEMPOTENCY_CONFLICT. When `REQUIRE_AUTH_FOR_BOOKING=false` a ' +
        'bearer token is optional and the booking is attributed to the guest user.',
      operationId: 'createBooking',
      parameters: [parameterRef('IdempotencyKey'), parameterRef('NodeIdHeader')],
      requestBody: jsonRequest(schemaRef('BookingRequest'), {
        flightId: SAMPLE.flightId,
        cabin: 'ECONOMY',
        passengerName: 'Ada Lovelace',
        passengerRef: 'PASS-9001',
        seatNumber: '12A',
        expectedVersion: 41,
      }),
      responses: {
        '201': {
          description: 'New booking created.',
          headers: {
            'Idempotent-Replay': {
              description: 'Always "false" on a fresh create.',
              schema: { type: 'string', enum: ['false'] },
            },
            'x-node-id': {
              description: 'API node that served the request.',
              schema: { type: 'string' },
            },
          },
          content: successBody(
            schemaRef('Booking'),
            ok({
              bookingId: SAMPLE.bookingId,
              bookingReference: SAMPLE.bookingReference,
              flightId: SAMPLE.flightId,
              departureDate: '2026-11-02',
              userId: SAMPLE.userId,
              cabin: 'ECONOMY',
              seatNumber: '12A',
              passengerName: 'Ada Lovelace',
              passengerRef: 'PASS-9001',
              status: 'CONFIRMED',
              price: 245.5,
              currency: 'USD',
              holdExpiresAt: null,
              nodeId: SAMPLE.nodeId,
              transactionId: SAMPLE.transactionId,
              paymentId: SAMPLE.paymentId,
              confirmedAt: '2026-10-13T12:00:00.050Z',
              cancelledAt: null,
              cancellationReason: null,
              createdAt: '2026-10-13T12:00:00.020Z',
              updatedAt: '2026-10-13T12:00:00.050Z',
            })
          ),
        },
        '200': {
          description:
            'Idempotent replay. The key and body were seen before, so the original booking is ' +
            'returned unchanged and no new reservation was made.',
          headers: {
            'Idempotent-Replay': {
              description: 'Always "true" when the request replayed a prior booking.',
              schema: { type: 'string', enum: ['true'] },
            },
          },
          content: successBody(
            schemaRef('Booking'),
            ok({
              bookingId: SAMPLE.bookingId,
              bookingReference: SAMPLE.bookingReference,
              flightId: SAMPLE.flightId,
              departureDate: '2026-11-02',
              userId: SAMPLE.userId,
              cabin: 'ECONOMY',
              seatNumber: '12A',
              passengerName: 'Ada Lovelace',
              passengerRef: 'PASS-9001',
              status: 'CONFIRMED',
              price: 245.5,
              currency: 'USD',
              holdExpiresAt: null,
              nodeId: SAMPLE.nodeId,
              transactionId: SAMPLE.transactionId,
              paymentId: SAMPLE.paymentId,
              confirmedAt: '2026-10-13T12:00:00.050Z',
              cancelledAt: null,
              cancellationReason: null,
              createdAt: '2026-10-13T12:00:00.020Z',
              updatedAt: '2026-10-13T12:00:00.050Z',
            })
          ),
        },
        '202': {
          description:
            'Accepted (asynchronous saga). The hold is placed and the booking is PENDING while ' +
            'payment settles; poll GET /api/bookings/{bookingId}.',
          content: successBody(
            schemaRef('Booking'),
            ok({
              bookingId: SAMPLE.bookingId,
              bookingReference: SAMPLE.bookingReference,
              flightId: SAMPLE.flightId,
              departureDate: '2026-11-02',
              userId: SAMPLE.userId,
              cabin: 'ECONOMY',
              seatNumber: '12A',
              passengerName: 'Ada Lovelace',
              passengerRef: 'PASS-9001',
              status: 'PENDING',
              price: 245.5,
              currency: 'USD',
              holdExpiresAt: '2026-10-13T12:10:00.000Z',
              nodeId: SAMPLE.nodeId,
              transactionId: SAMPLE.transactionId,
              paymentId: null,
              confirmedAt: null,
              cancelledAt: null,
              cancellationReason: null,
              createdAt: '2026-10-13T12:00:00.020Z',
              updatedAt: '2026-10-13T12:00:00.020Z',
            })
          ),
        },
        '400': errorBody('The request body failed validation.', {
          Validation: {
            value: err(ERROR_CODES.VALIDATION_ERROR, 'Validation failed', {
              fields: [{ path: 'passengerName', message: 'passengerName is required' }],
            }),
          },
        }),
        '401': responseRef('Unauthorized'),
        '409': errorBody(
          'A business conflict prevented the booking. The `code` distinguishes the cause.',
          {
            SoldOut: {
              value: err(ERROR_CODES.SOLD_OUT, 'No seats remaining in the requested cabin', {
                cabin: 'ECONOMY',
              }),
            },
            SeatUnavailable: {
              value: err(ERROR_CODES.SEAT_UNAVAILABLE, 'Requested seat is no longer available', {
                seatNumber: '12A',
              }),
            },
            DuplicateBooking: {
              value: err(ERROR_CODES.DUPLICATE_BOOKING, 'A live booking already exists for this seat', {
                seatNumber: '12A',
              }),
            },
            VersionConflict: {
              value: err(
                ERROR_CODES.VERSION_CONFLICT,
                'Optimistic concurrency version conflict: inventory changed by another transaction',
                { expectedVersion: 41, actualVersion: 42 }
              ),
            },
            PaymentFailed: {
              value: err(ERROR_CODES.PAYMENT_FAILED, 'Payment could not be completed', {
                provider: 'SIMULATED',
              }),
            },
            IdempotencyConflict: {
              value: err(
                ERROR_CODES.IDEMPOTENCY_CONFLICT,
                'This idempotency key was already used for a different request'
              ),
            },
          }
        ),
        '410': errorBody('The pending hold was reaped before payment settled.', {
          HoldExpired: {
            value: err(ERROR_CODES.HOLD_EXPIRED, 'The reservation hold expired before payment settled', {
              holdExpiresAt: '2026-10-13T12:10:00.000Z',
            }),
          },
        }),
        '429': responseRef('TooManyRequests'),
        '503': responseRef('ServiceUnavailable'),
      },
    },
  },

  '/api/bookings/{bookingId}': {
    get: {
      tags: ['bookings'],
      summary: 'Get a booking',
      description:
        'Returns a booking the caller owns. A booking that exists but belongs to someone else ' +
        'answers 404, not 403, so the endpoint does not disclose which ids exist.',
      operationId: 'getBooking',
      parameters: [pathParam('bookingId', 'Booking identifier (UUIDv7).')],
      responses: {
        '200': {
          description: 'The booking.',
          content: successBody(
            schemaRef('Booking'),
            ok({
              bookingId: SAMPLE.bookingId,
              bookingReference: SAMPLE.bookingReference,
              flightId: SAMPLE.flightId,
              departureDate: '2026-11-02',
              userId: SAMPLE.userId,
              cabin: 'ECONOMY',
              seatNumber: '12A',
              passengerName: 'Ada Lovelace',
              passengerRef: 'PASS-9001',
              status: 'CONFIRMED',
              price: 245.5,
              currency: 'USD',
              holdExpiresAt: null,
              nodeId: SAMPLE.nodeId,
              transactionId: SAMPLE.transactionId,
              paymentId: SAMPLE.paymentId,
              confirmedAt: '2026-10-13T12:00:00.050Z',
              cancelledAt: null,
              cancellationReason: null,
              createdAt: '2026-10-13T12:00:00.020Z',
              updatedAt: '2026-10-13T12:00:00.050Z',
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': responseRef('Unauthorized'),
        '404': errorBody('No such booking, or it is not owned by the caller.', {
          NotFound: {
            value: err(ERROR_CODES.NOT_FOUND, 'Resource not found', { bookingId: SAMPLE.bookingId }),
          },
        }),
      },
    },
  },

  '/api/bookings/reference/{bookingReference}': {
    get: {
      tags: ['bookings'],
      summary: 'Get a booking by its human reference',
      description:
        'Looks a booking up by the `BK-XXXXXXXXXX` reference printed on a ticket. Scoped to the ' +
        'caller\'s own bookings.',
      operationId: 'getBookingByReference',
      parameters: [
        pathParam('bookingReference', 'Human-facing reference, e.g. BK-7F9A12K4QW.'),
      ],
      responses: {
        '200': {
          description: 'The booking.',
          content: successBody(
            schemaRef('Booking'),
            ok({
              bookingId: SAMPLE.bookingId,
              bookingReference: SAMPLE.bookingReference,
              flightId: SAMPLE.flightId,
              departureDate: '2026-11-02',
              userId: SAMPLE.userId,
              cabin: 'ECONOMY',
              seatNumber: '12A',
              passengerName: 'Ada Lovelace',
              passengerRef: 'PASS-9001',
              status: 'CONFIRMED',
              price: 245.5,
              currency: 'USD',
              holdExpiresAt: null,
              nodeId: SAMPLE.nodeId,
              transactionId: SAMPLE.transactionId,
              paymentId: SAMPLE.paymentId,
              confirmedAt: '2026-10-13T12:00:00.050Z',
              cancelledAt: null,
              cancellationReason: null,
              createdAt: '2026-10-13T12:00:00.020Z',
              updatedAt: '2026-10-13T12:00:00.050Z',
            })
          ),
        },
        '401': responseRef('Unauthorized'),
        '404': errorBody('No booking with that reference for this caller.', {
          NotFound: {
            value: err(ERROR_CODES.NOT_FOUND, 'Resource not found', {
              bookingReference: 'BK-0000000000',
            }),
          },
        }),
      },
    },
  },

  '/api/bookings/{bookingId}/cancel': {
    post: {
      tags: ['bookings'],
      summary: 'Cancel a booking',
      description:
        'Compensates the saga: releases the seat and the inventory counter. A PENDING hold that ' +
        'has already been reaped is a 410, not a 200, because the booking no longer exists in a ' +
        'cancellable state.',
      operationId: 'cancelBooking',
      parameters: [pathParam('bookingId', 'Booking identifier (UUIDv7).')],
      requestBody: jsonRequest(
        {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              maxLength: 500,
              description: 'Optional cancellation reason, stored on the booking.',
            },
          },
        },
        { reason: 'Change of plans' },
        false
      ),
      responses: {
        '200': {
          description: 'The booking is now CANCELLED and the seat/counter were released.',
          content: successBody(
            schemaRef('Booking'),
            ok({
              bookingId: SAMPLE.bookingId,
              bookingReference: SAMPLE.bookingReference,
              flightId: SAMPLE.flightId,
              departureDate: '2026-11-02',
              userId: SAMPLE.userId,
              cabin: 'ECONOMY',
              seatNumber: '12A',
              passengerName: 'Ada Lovelace',
              passengerRef: 'PASS-9001',
              status: 'CANCELLED',
              price: 245.5,
              currency: 'USD',
              holdExpiresAt: null,
              nodeId: SAMPLE.nodeId,
              transactionId: SAMPLE.transactionId,
              paymentId: SAMPLE.paymentId,
              confirmedAt: '2026-10-13T12:00:00.050Z',
              cancelledAt: '2026-10-13T12:05:00.000Z',
              cancellationReason: 'Change of plans',
              createdAt: '2026-10-13T12:00:00.020Z',
              updatedAt: '2026-10-13T12:05:00.000Z',
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': responseRef('Unauthorized'),
        '404': errorBody('No such booking, or it is not owned by the caller.', {
          NotFound: {
            value: err(ERROR_CODES.NOT_FOUND, 'Resource not found', { bookingId: SAMPLE.bookingId }),
          },
        }),
        '409': errorBody('The booking is already cancelled.', {
          AlreadyCancelled: {
            value: err(ERROR_CODES.ALREADY_CANCELLED, 'Booking is already cancelled', {
              status: 'CANCELLED',
            }),
          },
        }),
        '410': errorBody('The pending hold expired and was reaped; there is nothing to cancel.', {
          HoldExpired: {
            value: err(ERROR_CODES.HOLD_EXPIRED, 'The reservation hold expired before cancellation', {
              status: 'EXPIRED',
            }),
          },
        }),
      },
    },
  },

  // =========================================================================
  // Users
  // =========================================================================
  '/api/users/me/bookings': {
    get: {
      tags: ['users'],
      summary: 'List the caller\'s bookings',
      description:
        'Reads the `user_bookings` projection, which is sharded by user id and maintained ' +
        'asynchronously from the outbox, so it can briefly lag the write model.',
      operationId: 'listMyBookings',
      parameters: [
        {
          name: 'status',
          in: 'query',
          required: false,
          description: 'Filter to a single booking status.',
          schema: { type: 'string', enum: Object.values(BOOKING_STATUS) },
        },
        parameterRef('Limit'),
        parameterRef('Offset'),
      ],
      responses: {
        '200': {
          description: 'The caller\'s bookings, newest first.',
          content: successBody(
            {
              type: 'object',
              required: ['bookings', 'pagination'],
              properties: {
                bookings: { type: 'array', items: schemaRef('MyBooking') },
                pagination: schemaRef('Pagination'),
                readModelLagMs: {
                  type: 'integer',
                  description: 'Age of the newest projected event, in milliseconds.',
                },
              },
            },
            ok({
              bookings: [
                {
                  bookingId: SAMPLE.bookingId,
                  bookingReference: SAMPLE.bookingReference,
                  flightId: SAMPLE.flightId,
                  flightNumber: 'PK123',
                  airlineCode: 'PK',
                  origin: 'ISB',
                  destination: 'LHR',
                  departureDate: '2026-11-02',
                  departureTime: '2026-11-02T06:30:00.000Z',
                  cabin: 'ECONOMY',
                  seatNumber: '12A',
                  passengerName: 'Ada Lovelace',
                  status: 'CONFIRMED',
                  price: 245.5,
                  currency: 'USD',
                  bookingCreatedAt: '2026-10-13T12:00:00.020Z',
                  updatedAt: '2026-10-13T12:00:00.400Z',
                },
              ],
              pagination: { limit: 20, offset: 0, total: 1, hasMore: false },
              readModelLagMs: 320,
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': responseRef('Unauthorized'),
        '429': responseRef('TooManyRequests'),
      },
    },
  },

  // =========================================================================
  // Health (public)
  // =========================================================================
  '/api/health': {
    get: {
      tags: ['health'],
      summary: 'Dependency and topology report',
      description:
        'Full health report: write-model and read-model reachability plus the detected Citus / ' +
        'pg_partman / uuidv7 capabilities. Public.',
      operationId: 'health',
      security: [],
      responses: {
        '200': {
          description: 'Health report. `status` is DEGRADED when a dependency is down.',
          content: successBody(
            schemaRef('HealthReport'),
            ok({
              status: 'UP',
              nodeId: SAMPLE.nodeId,
              version: '2.0.0',
              uptimeSeconds: 3600,
              checks: {
                writeModel: 'CONNECTED',
                readModel: 'CONNECTED',
                redis: 'IN_PROCESS_FALLBACK',
              },
              latencyMs: 4,
              topology: {
                citus: true,
                pgPartman: true,
                nativeUuidv7: false,
                serverVersionNum: 170000,
              },
              timestamp: SAMPLE.timestamp,
            })
          ),
        },
        '503': responseRef('ServiceUnavailable'),
      },
    },
  },

  '/api/health/live': {
    get: {
      tags: ['health'],
      summary: 'Liveness probe',
      description:
        'Answers 200 as long as the process is running and able to serve HTTP. Never touches a ' +
        'dependency, so a database outage does not restart the pod. Public.',
      operationId: 'healthLive',
      security: [],
      responses: {
        '200': {
          description: 'The process is up.',
          content: successBody(
            {
              type: 'object',
              required: ['status', 'nodeId'],
              properties: {
                status: { type: 'string', enum: ['UP'] },
                nodeId: { type: 'string' },
                uptimeSeconds: { type: 'number' },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
            ok({
              status: 'UP',
              nodeId: SAMPLE.nodeId,
              uptimeSeconds: 3600,
              timestamp: SAMPLE.timestamp,
            })
          ),
        },
        '500': errorBody('The process is alive but the handler itself failed.', {
          InternalError: {
            value: err(ERROR_CODES.INTERNAL_ERROR, 'An unexpected error occurred'),
          },
        }),
      },
    },
  },

  '/api/health/ready': {
    get: {
      tags: ['health'],
      summary: 'Readiness probe',
      description:
        'Answers 200 only when both models are reachable; 503 otherwise, so the load balancer ' +
        'stops routing traffic to a node that cannot serve. Public.',
      operationId: 'healthReady',
      security: [],
      responses: {
        '200': {
          description: 'Write and read models are reachable.',
          content: successBody(
            schemaRef('HealthReport'),
            ok({
              status: 'UP',
              nodeId: SAMPLE.nodeId,
              version: '2.0.0',
              uptimeSeconds: 3600,
              checks: { writeModel: 'CONNECTED', readModel: 'CONNECTED', redis: 'IN_PROCESS_FALLBACK' },
              latencyMs: 3,
              topology: { citus: true, pgPartman: true, nativeUuidv7: false, serverVersionNum: 170000 },
              timestamp: SAMPLE.timestamp,
            })
          ),
        },
        '503': errorBody('A dependency the API needs to serve traffic is unreachable.', {
          NotReady: {
            value: err(ERROR_CODES.DATABASE_UNAVAILABLE, 'Database is temporarily unavailable', {
              checks: { writeModel: 'DISCONNECTED', readModel: 'CONNECTED' },
            }),
          },
        }),
      },
    },
  },

  // =========================================================================
  // Admin (ADMIN role only)
  // =========================================================================
  '/api/admin/topology': {
    get: {
      tags: ['admin'],
      summary: 'Citus cluster topology',
      description:
        'Coordinator, registered worker nodes and shard placement. Requires the ADMIN role; ' +
        'anything else is 403.',
      operationId: 'getTopology',
      responses: {
        '200': {
          description: 'Cluster topology.',
          content: successBody(
            schemaRef('TopologyReport'),
            ok({
              coordinator: { nodeId: 1, host: 'coordinator', port: 5432, isActive: true, role: 'primary' },
              workers: [
                { nodeId: 2, groupId: 0, host: 'worker-1', port: 5432, isActive: true, isPrimary: true },
                { nodeId: 3, groupId: 1, host: 'worker-2', port: 5432, isActive: true, isPrimary: true },
              ],
              shards: [
                {
                  table: 'bookings',
                  shardId: 102008,
                  shardName: 'bookings_102008',
                  nodeId: 2,
                  shardMinValue: '00000000-0000-0000-0000-000000000000',
                  shardMaxValue: '7fffffff-ffff-ffff-ffff-ffffffffffff',
                },
              ],
              distribution: { strategy: 'hash', shardCount: 32, colocationGroups: 3 },
              generatedAt: SAMPLE.timestamp,
            })
          ),
        },
        '401': responseRef('Unauthorized'),
        '403': errorBody('The caller is authenticated but not an ADMIN.', {
          Forbidden: {
            value: err(ERROR_CODES.FORBIDDEN, 'You do not have permission to perform this action', {
              requiredRole: 'ADMIN',
            }),
          },
        }),
        '503': responseRef('ServiceUnavailable'),
      },
    },
  },

  '/api/admin/flights': {
    post: {
      tags: ['admin'],
      summary: 'Create or upsert a flight',
      description:
        'Idempotent upsert of a flight and its per-cabin inventory. This is also the seam a bulk ' +
        'loader calls, so the body is batched-friendly. Requires ADMIN.',
      operationId: 'upsertFlight',
      requestBody: jsonRequest(schemaRef('AdminFlightUpsertRequest'), {
        flightNumber: 'PK124',
        airlineCode: 'PK',
        origin: 'ISB',
        destination: 'LHR',
        departureTime: '2026-11-03T06:30:00.000Z',
        arrivalTime: '2026-11-03T10:15:00.000Z',
        aircraftType: 'A320',
        basePrice: 249.0,
        currency: 'USD',
        status: 'SCHEDULED',
        cabins: [
          { cabin: 'ECONOMY', totalSeats: 180 },
          { cabin: 'BUSINESS', totalSeats: 12 },
        ],
      }),
      responses: {
        '200': {
          description: 'The flight was upserted.',
          content: successBody(
            {
              type: 'object',
              properties: {
                created: { type: 'boolean' },
                flight: schemaRef('Flight'),
              },
            },
            ok({
              created: true,
              flight: {
                flightId: SAMPLE.flightId,
                flightNumber: 'PK124',
                airlineCode: 'PK',
                origin: 'ISB',
                destination: 'LHR',
                departureDate: '2026-11-03',
                departureTime: '2026-11-03T06:30:00.000Z',
                arrivalTime: '2026-11-03T10:15:00.000Z',
                aircraftType: 'A320',
                basePrice: 249.0,
                currency: 'USD',
                status: 'SCHEDULED',
                cabins: [
                  { cabin: 'ECONOMY', capacity: 180, available: 180, price: 249.0, version: 0 },
                  { cabin: 'BUSINESS', capacity: 12, available: 12, price: 1299.0, version: 0 },
                ],
              },
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '409': errorBody('The flight conflicts with an existing row.', {
          Conflict: {
            value: err(ERROR_CODES.DUPLICATE_ENTRY, 'A conflicting record already exists', {
              flightNumber: 'PK124',
              departureDate: '2026-11-03',
            }),
          },
        }),
      },
    },
  },

  '/api/admin/partitions/maintain': {
    post: {
      tags: ['admin'],
      summary: 'Maintain monthly partitions',
      description:
        'Ensures partitions exist for the upcoming months and drops partitions older than the ' +
        'retention window. Requires ADMIN.',
      operationId: 'maintainPartitions',
      requestBody: jsonRequest(
        {
          type: 'object',
          properties: {
            monthsAhead: { type: 'integer', minimum: 0, maximum: 36 },
            monthsBehind: { type: 'integer', minimum: 0, maximum: 12 },
            retentionMonths: { type: 'integer', minimum: 1, maximum: 120 },
            dryRun: { type: 'boolean', default: false },
            force: {
              type: 'boolean',
              default: false,
              description:
                'Drop a partition that still holds rows, or detach one whose default partition ' +
                'is not empty. Without this, a non-empty partition is refused rather than lost.',
            },
            mode: {
              type: 'string',
              enum: ['drop', 'detach'],
              default: 'drop',
              description:
                'What to do with a partition past retention. "detach" lifts it out of the ' +
                'hierarchy and keeps the table, so the data stays queryable.',
            },
          },
        },
        { monthsAhead: 6, monthsBehind: 1, retentionMonths: 24, dryRun: false, force: false, mode: 'drop' },
        false
      ),
      responses: {
        '200': {
          description: 'The maintenance pass completed.',
          content: successBody(
            {
              type: 'object',
              properties: {
                ensured: { type: 'array', items: { type: 'string' } },
                dropped: { type: 'array', items: { type: 'string' } },
                dryRun: { type: 'boolean' },
                mode: { type: 'string', enum: ['drop', 'detach'] },
                blocked: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Partitions past retention that were NOT removed because they still hold ' +
                    'rows (and force was not set). Reported rather than skipped silently.',
                },
                horizon: {
                  type: 'object',
                  description: 'The months the cluster actually has partitions for, after this pass.',
                  properties: {
                    from: { type: 'string', example: '2026-09' },
                    to: { type: 'string', example: '2027-04' },
                  },
                },
                retentionCutoff: {
                  type: 'string',
                  description: 'Oldest month kept, derived from now() minus retentionMonths.',
                  example: '2024-10',
                },
                generatedAt: { type: 'string', format: 'date-time' },
                skipped: {
                  type: 'boolean',
                  description:
                    'Present and true when another maintenance pass held the advisory lock, so ' +
                    'this one changed nothing. Not an error — retry to roll the horizon forward.',
                },
                reason: { type: 'string' },
                message: { type: 'string' },
              },
            },
            ok({
              ensured: ['flights_2026_11', 'flight_inventory_2026_11', 'bookings_2026_11'],
              dropped: ['bookings_2024_08'],
              dryRun: false,
              mode: 'drop',
              blocked: ['bookings_2024_09'],
              horizon: { from: '2026-09', to: '2027-04' },
              retentionCutoff: '2024-10',
              generatedAt: '2026-10-13T09:15:00.000Z',
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '503': responseRef('ServiceUnavailable'),
      },
    },
  },

  '/api/admin/projections/reproject': {
    post: {
      tags: ['admin'],
      summary: 'Replay the read-model projection',
      description:
        'Re-runs the outbox projection for a window or a set of flights, used to recover a read ' +
        'model that fell behind or was rebuilt. Requires ADMIN.',
      operationId: 'reprojectReadModel',
      requestBody: jsonRequest(
        {
          type: 'object',
          properties: {
            flightIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              description: 'Restrict to these flights. Omit to reproject the whole window.',
            },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            force: {
              type: 'boolean',
              default: false,
              description: 'Re-apply even when the projected version is already current.',
            },
          },
        },
        { flightIds: [SAMPLE.flightId], force: false },
        false
      ),
      responses: {
        '200': {
          description: 'Projection summary.',
          content: successBody(
            {
              type: 'object',
              properties: {
                projected: { type: 'integer' },
                skipped: { type: 'integer' },
                lagMs: { type: 'integer' },
              },
            },
            ok({ projected: 128, skipped: 3, lagMs: 12 })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '503': responseRef('ServiceUnavailable'),
      },
    },
  },

  '/api/admin/inventory/audit': {
    post: {
      tags: ['admin'],
      summary: 'Oversell audit',
      description:
        'Reconciles live bookings against inventory counters and reports any drift. A non-empty ' +
        '`findings` array means the accounting invariant is at risk and needs investigation. ' +
        'Requires ADMIN.',
      operationId: 'auditInventory',
      requestBody: jsonRequest(
        {
          type: 'object',
          properties: {
            flightId: { type: 'string', format: 'uuid' },
            departureDate: { type: 'string', format: 'date' },
            cabin: { type: 'string', enum: CABINS },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
          },
        },
        { flightId: SAMPLE.flightId, departureDate: '2026-11-02', cabin: 'ECONOMY', limit: 100 },
        false
      ),
      responses: {
        '200': {
          description: 'The audit result.',
          content: successBody(
            {
              type: 'object',
              required: ['checked', 'oversoldCount', 'findings'],
              properties: {
                checked: { type: 'integer' },
                oversoldCount: { type: 'integer' },
                findings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      flightId: { type: 'string', format: 'uuid' },
                      cabin: { type: 'string', enum: CABINS },
                      booked: { type: 'integer' },
                      capacity: { type: 'integer' },
                      available: { type: 'integer' },
                      delta: { type: 'integer' },
                    },
                  },
                },
              },
            },
            ok({
              checked: 12,
              oversoldCount: 1,
              findings: [
                {
                  flightId: SAMPLE.flightId,
                  cabin: 'ECONOMY',
                  booked: 181,
                  capacity: 180,
                  available: 0,
                  delta: 1,
                },
              ],
            })
          ),
        },
        '400': responseRef('BadRequest'),
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '500': errorBody('The invariant violation alarm fired.', {
          InvariantViolation: {
            value: err(
              ERROR_CODES.INVENTORY_INVARIANT_VIOLATION,
              'Inventory accounting invariant violated',
              { flightId: SAMPLE.flightId }
            ),
          },
        }),
      },
    },
  },

  '/api/admin/outbox/stats': {
    get: {
      tags: ['admin'],
      summary: 'Outbox backlog statistics',
      description:
        'Pending event count and the age of the oldest unpublished event, the number that tells ' +
        'you whether the read model is falling behind. Requires ADMIN.',
      operationId: 'getOutboxStats',
      responses: {
        '200': {
          description: 'Outbox statistics.',
          content: successBody(
            schemaRef('OutboxStats'),
            ok({
              pending: 12,
              published: 98234,
              failed: 1,
              total: 98247,
              oldestEventAgeMs: 4200,
              oldestEventAt: '2026-10-13T11:59:55.800Z',
              lastPublishedAt: '2026-10-13T12:00:00.000Z',
              byEventType: { BOOKING_CONFIRMED: 8, BOOKING_CANCELLED: 3, INVENTORY_CHANGED: 1 },
            })
          ),
        },
        '401': responseRef('Unauthorized'),
        '403': responseRef('Forbidden'),
        '503': responseRef('ServiceUnavailable'),
      },
    },
  },

  // =========================================================================
  // Metrics
  // =========================================================================
  '/metrics': {
    get: {
      tags: ['metrics'],
      summary: 'Prometheus metrics',
      description:
        'Prometheus text exposition format (version 0.0.4), NOT JSON. Scraped by the monitoring ' +
        'stack; public so the scraper needs no token.',
      operationId: 'getMetrics',
      security: [],
      responses: {
        '200': {
          description: 'Prometheus text exposition.',
          content: {
            'text/plain': {
              schema: { type: 'string' },
              // Reproduced from the registry rather than paraphrased: every sample carries
              // every label the metric declares, and the HELP text is the one the collector
              // was registered with. A scraper vendor or a dashboard author reading this
              // example builds parsers and queries from it.
              example:
                '# HELP airline_http_requests_total Total HTTP requests.\n' +
                '# TYPE airline_http_requests_total counter\n' +
                'airline_http_requests_total{method="POST",route="/api/bookings",status="201"} 42\n' +
                '# HELP airline_inventory_available_seats Available seats observed per flight and cabin (set by admin/audit calls only).\n' +
                '# TYPE airline_inventory_available_seats gauge\n' +
                `airline_inventory_available_seats{flight_id="${SAMPLE.flightId}",cabin="ECONOMY"} 42\n`,
            },
          },
        },
        '503': responseRef('ServiceUnavailable'),
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Components
//
// Defined once, referenced everywhere. The envelope schemas are deliberately
// permissive (their `data`/`details` are open) because OpenAPI 3.0 cannot express
// a generic; consumers narrow them per operation with `allOf`.
// ---------------------------------------------------------------------------
const components = {
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Short-lived JWT access token issued by POST /api/auth/login or /api/auth/refresh. ' +
        'Send as `Authorization: Bearer <accessToken>` in every authenticated request.',
    },
  },

  parameters: {
    IdempotencyKey: {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description:
        'Opaque client-generated key that makes booking creation replay-safe. Reusing a key with ' +
        'an identical body replays the original booking (200); reusing it with a different body ' +
        'is a 409 IDEMPOTENCY_CONFLICT. The `x-idempotency-key` spelling is accepted as an alias.',
      schema: { type: 'string', minLength: 1, maxLength: 255 },
      example: '9f1c2b3a-4d5e-7f80-9123-456789abcdef',
    },
    NodeIdHeader: {
      name: 'x-node-id',
      in: 'header',
      required: false,
      description:
        'Caller-supplied node identifier, echoed for correlation in logs. Informational only; it ' +
        'never changes routing.',
      schema: { type: 'string', maxLength: 64 },
      example: 'NODE_A',
    },
    Limit: {
      name: 'limit',
      in: 'query',
      required: false,
      description: 'Page size.',
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      example: 20,
    },
    Offset: {
      name: 'offset',
      in: 'query',
      required: false,
      description: 'Number of rows to skip.',
      schema: { type: 'integer', minimum: 0, default: 0 },
      example: 0,
    },
  },

  responses: {
    BadRequest: errorBody('The request is malformed or failed validation.', {
      Validation: {
        value: err(ERROR_CODES.VALIDATION_ERROR, 'Validation failed', {
          fields: [{ path: 'flightId', message: 'flightId must be a UUID' }],
        }),
      },
      InvalidId: {
        value: err(ERROR_CODES.INVALID_ID, 'Invalid id', { param: 'bookingId' }),
      },
    }),
    Unauthorized: errorBody('Authentication is missing or the credential is not valid.', {
      Unauthenticated: {
        value: err(ERROR_CODES.UNAUTHENTICATED, 'Authentication is required'),
      },
      TokenInvalid: {
        value: err(ERROR_CODES.TOKEN_INVALID, 'Token is invalid'),
      },
      TokenExpired: {
        value: err(ERROR_CODES.TOKEN_EXPIRED, 'Token has expired'),
      },
    }),
    Forbidden: errorBody('Authenticated, but the role does not permit the action.', {
      Forbidden: {
        value: err(ERROR_CODES.FORBIDDEN, 'You do not have permission to perform this action'),
      },
    }),
    NotFound: errorBody('The resource does not exist (or is not visible to the caller).', {
      NotFound: { value: err(ERROR_CODES.NOT_FOUND, 'Resource not found') },
    }),
    Conflict: errorBody('The request conflicts with the current state of a resource.', {
      VersionConflict: {
        value: err(
          ERROR_CODES.VERSION_CONFLICT,
          'Optimistic concurrency version conflict: inventory changed by another transaction'
        ),
      },
    }),
    Gone: errorBody('The resource existed but its hold has expired.', {
      HoldExpired: {
        value: err(ERROR_CODES.HOLD_EXPIRED, 'The reservation hold expired before payment settled'),
      },
    }),
    TooManyRequests: {
      description: 'The rate limit for this endpoint was exceeded.',
      headers: {
        'Retry-After': {
          description: 'Seconds to wait before retrying.',
          schema: { type: 'integer', minimum: 1 },
          example: 12,
        },
      },
      content: {
        'application/json': {
          schema: schemaRef('ErrorEnvelope'),
          examples: {
            RateLimited: {
              value: err(ERROR_CODES.RATE_LIMITED, 'Too many requests', { retryAfterSeconds: 12 }),
            },
          },
        },
      },
    },
    ServiceUnavailable: errorBody(
      'A dependency (database, pool, or exhausted retries) is unavailable; retry with backoff.',
      {
        DatabaseUnavailable: {
          value: err(ERROR_CODES.DATABASE_UNAVAILABLE, 'Database is temporarily unavailable'),
        },
        TransientTransaction: {
          value: err(
            ERROR_CODES.TRANSIENT_TRANSACTION_ERROR,
            'Transient write conflict encountered in database transaction'
          ),
        },
      }
    ),
  },

  schemas: {
    SuccessEnvelope: {
      type: 'object',
      description: 'Every 2xx response body. `data` is narrowed per operation with allOf.',
      required: ['success', 'data'],
      properties: {
        success: { type: 'boolean', enum: [true], description: 'Always true.' },
        data: { nullable: true, description: 'Endpoint-specific payload.' },
      },
    },

    Error: {
      type: 'object',
      description: 'The machine-readable error payload nested inside ErrorEnvelope.',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          description: 'Stable error code; clients branch on this, never on the message.',
          enum: Object.values(ERROR_CODES),
        },
        message: { type: 'string', description: 'Human-readable summary. Not stable.' },
        details: {
          nullable: true,
          description: 'Optional, code-specific context (field errors, conflicting ids, ...).',
          oneOf: [
            { type: 'object', additionalProperties: true },
            { type: 'array', items: {} },
            { type: 'string' },
          ],
        },
      },
      example: {
        code: ERROR_CODES.SOLD_OUT,
        message: 'No seats remaining in the requested cabin',
        details: { cabin: 'ECONOMY' },
      },
    },

    ErrorEnvelope: {
      type: 'object',
      description: 'Every non-2xx response body.',
      required: ['success', 'error', 'nodeId', 'timestamp'],
      properties: {
        success: { type: 'boolean', enum: [false], description: 'Always false.' },
        error: schemaRef('Error'),
        nodeId: {
          type: 'string',
          description: 'API instance that produced the error (its configured NODE_ID).',
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
      example: {
        success: false,
        error: {
          code: ERROR_CODES.SEAT_UNAVAILABLE,
          message: 'Requested seat is no longer available',
          details: { seatNumber: '12A' },
        },
        nodeId: SAMPLE.nodeId,
        timestamp: SAMPLE.timestamp,
      },
    },

    Flight: {
      type: 'object',
      description: 'A flight and its per-cabin inventory counters.',
      required: [
        'flightId',
        'flightNumber',
        'airlineCode',
        'origin',
        'destination',
        'departureDate',
        'departureTime',
        'arrivalTime',
        'aircraftType',
        'status',
      ],
      properties: {
        flightId: { type: 'string', format: 'uuid' },
        flightNumber: { type: 'string', example: 'PK123' },
        airlineCode: { type: 'string', example: 'PK' },
        origin: { type: 'string', minLength: 3, maxLength: 3, example: 'ISB' },
        destination: { type: 'string', minLength: 3, maxLength: 3, example: 'LHR' },
        departureDate: { type: 'string', format: 'date', example: '2026-11-02' },
        departureTime: { type: 'string', format: 'date-time' },
        arrivalTime: { type: 'string', format: 'date-time' },
        aircraftType: { type: 'string', example: 'A320' },
        basePrice: { type: 'number', format: 'double', example: 245.5 },
        currency: { type: 'string', example: 'USD' },
        status: { type: 'string', enum: Object.values(FLIGHT_STATUS) },
        cabins: {
          type: 'array',
          description: 'Per-cabin counters derived from flight_inventory.',
          items: schemaRef('Availability'),
        },
      },
    },

    FlightSearchResult: {
      allOf: [
        schemaRef('Flight'),
        {
          type: 'object',
          properties: {
            lowestPrice: {
              type: 'number',
              format: 'double',
              description: 'Cheapest available fare across the returned cabins.',
            },
            sourceVersion: {
              type: 'integer',
              format: 'int64',
              description: 'Write-model inventory version this projection was derived from.',
            },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      ],
    },

    Availability: {
      type: 'object',
      description:
        'A per-cabin inventory counter. Read from the write model for availability, and from ' +
        'the projection for search results.',
      required: ['cabin', 'capacity', 'available', 'price', 'version'],
      properties: {
        cabin: { type: 'string', enum: CABINS },
        capacity: { type: 'integer', description: 'total_seats for this cabin.', example: 180 },
        available: { type: 'integer', description: 'Seats still sellable.', example: 42 },
        held: {
          type: 'integer',
          description: 'Seats held by PENDING bookings but not yet confirmed.',
          example: 5,
        },
        price: { type: 'number', format: 'double', example: 245.5 },
        currency: { type: 'string', example: 'USD' },
        version: {
          type: 'integer',
          format: 'int64',
          description: 'Optimistic-concurrency version; pass it back as expectedVersion to book.',
          example: 41,
        },
        shardNo: {
          type: 'integer',
          description: 'Counter shard within the cabin (0 when INVENTORY_STRATEGY=single).',
          example: 0,
        },
      },
    },

    Seat: {
      type: 'object',
      required: ['seatNumber', 'status', 'cabin', 'isExitRow'],
      properties: {
        seatNumber: { type: 'string', example: '12A' },
        status: { type: 'string', enum: Object.values(SEAT_STATUS) },
        cabin: { type: 'string', enum: CABINS },
        isExitRow: { type: 'boolean', example: true },
      },
    },

    SeatMap: {
      type: 'object',
      required: ['flightId', 'cabin', 'aircraftType', 'columns', 'rows', 'seats'],
      properties: {
        flightId: { type: 'string', format: 'uuid' },
        cabin: { type: 'string', enum: CABINS },
        aircraftType: { type: 'string', example: 'A320' },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Column labels, left to right.',
          example: ['A', 'B', 'C', 'D', 'E', 'F'],
        },
        rows: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Row numbers present in the map.',
          example: [1, 2, 3, 4],
        },
        seats: { type: 'array', items: schemaRef('Seat') },
      },
    },

    Booking: {
      type: 'object',
      description:
        'A booking. Status follows the PENDING -> CONFIRMED | CANCELLED | EXPIRED lifecycle.',
      required: [
        'bookingId',
        'bookingReference',
        'flightId',
        'userId',
        'cabin',
        'passengerName',
        'status',
        'price',
        'currency',
        'createdAt',
      ],
      properties: {
        bookingId: { type: 'string', format: 'uuid' },
        bookingReference: { type: 'string', example: 'BK-7F9A12K4QW' },
        flightId: { type: 'string', format: 'uuid' },
        departureDate: { type: 'string', format: 'date' },
        userId: { type: 'string', format: 'uuid' },
        cabin: { type: 'string', enum: CABINS },
        seatNumber: { type: 'string', nullable: true, example: '12A' },
        passengerName: { type: 'string', example: 'Ada Lovelace' },
        passengerRef: { type: 'string', nullable: true, example: 'PASS-9001' },
        status: { type: 'string', enum: Object.values(BOOKING_STATUS) },
        price: { type: 'number', format: 'double', example: 245.5 },
        currency: { type: 'string', example: 'USD' },
        holdExpiresAt: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          description: 'Set while PENDING; null once the booking is terminal.',
        },
        nodeId: { type: 'string', nullable: true, example: 'api-local' },
        transactionId: { type: 'string', format: 'uuid' },
        paymentId: { type: 'string', format: 'uuid', nullable: true },
        confirmedAt: { type: 'string', format: 'date-time', nullable: true },
        cancelledAt: { type: 'string', format: 'date-time', nullable: true },
        cancellationReason: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },

    BookingRequest: {
      type: 'object',
      required: ['flightId', 'passengerName'],
      properties: {
        flightId: { type: 'string', format: 'uuid' },
        cabin: {
          type: 'string',
          enum: CABINS,
          default: 'ECONOMY',
          description: 'Defaults to DEFAULT_CABIN (ECONOMY).',
        },
        passengerName: { type: 'string', minLength: 1, maxLength: 200, example: 'Ada Lovelace' },
        passengerRef: {
          type: 'string',
          nullable: true,
          maxLength: 100,
          description: 'Optional external passenger identifier.',
          example: 'PASS-9001',
        },
        seatNumber: {
          type: 'string',
          nullable: true,
          pattern: '^[0-9]{1,3}[A-Z]$',
          description:
            'Specific seat to hold. Honoured only when SEAT_ASSIGNMENT_MODE=requested; ignored ' +
            '(assigned later) when lazy.',
          example: '12A',
        },
        expectedVersion: {
          type: 'integer',
          format: 'int64',
          nullable: true,
          description:
            'Inventory version the client last saw. If supplied and stale, the booking is ' +
            'rejected with 409 VERSION_CONFLICT instead of applying to newer state.',
          example: 41,
        },
        passengerId: {
          type: 'string',
          nullable: true,
          description:
            'Guest attribution when REQUIRE_AUTH_FOR_BOOKING=false and no bearer token is sent.',
          example: 'PASS-9001',
        },
      },
    },

    Payment: {
      type: 'object',
      description: 'The payment saga record for a booking.',
      required: ['paymentId', 'bookingId', 'amount', 'currency', 'status'],
      properties: {
        paymentId: { type: 'string', format: 'uuid' },
        bookingId: { type: 'string', format: 'uuid' },
        amount: { type: 'number', format: 'double', example: 245.5 },
        currency: { type: 'string', example: 'USD' },
        provider: { type: 'string', example: 'SIMULATED' },
        status: { type: 'string', enum: Object.values(PAYMENT_STATUS) },
        sagaState: {
          type: 'string',
          nullable: true,
          description: 'Persisted saga step, used to reconcile a crash mid-payment.',
        },
        failureReason: { type: 'string', nullable: true },
        providerReference: { type: 'string', nullable: true },
        authorizedAt: { type: 'string', format: 'date-time', nullable: true },
        capturedAt: { type: 'string', format: 'date-time', nullable: true },
        refundedAt: { type: 'string', format: 'date-time', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },

    User: {
      type: 'object',
      description: 'The stored user record. The password hash is never part of any response.',
      required: ['id', 'email', 'role', 'isActive'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string', format: 'email', example: 'ada.lovelace@example.com' },
        role: { type: 'string', enum: Object.values(USER_ROLES) },
        fullName: { type: 'string', nullable: true },
        phone: { type: 'string', nullable: true },
        isActive: { type: 'boolean' },
        lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },

    PublicUser: {
      type: 'object',
      description: 'The safe projection of a user returned by the API.',
      required: ['id', 'email', 'role'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string', format: 'email', example: 'ada.lovelace@example.com' },
        fullName: { type: 'string', nullable: true, example: 'Ada Lovelace' },
        phone: { type: 'string', nullable: true, example: '+92-300-1234567' },
        role: { type: 'string', enum: Object.values(USER_ROLES) },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },

    AuthTokens: {
      type: 'object',
      description: 'An access/refresh token pair. Refresh tokens rotate on every use.',
      required: ['accessToken', 'refreshToken', 'expiresIn'],
      properties: {
        accessToken: {
          type: 'string',
          description: 'JWT presented as a bearer token. Short-lived.',
        },
        refreshToken: {
          type: 'string',
          description:
            'Opaque rotating credential. Reusing an already-rotated one revokes the whole family.',
        },
        tokenType: { type: 'string', enum: ['Bearer'], default: 'Bearer' },
        expiresIn: {
          type: 'integer',
          description: 'Access-token lifetime in seconds (JWT_ACCESS_TTL).',
          example: 900,
        },
        refreshExpiresIn: {
          type: 'integer',
          description: 'Refresh-token lifetime in seconds (JWT_REFRESH_TTL_SECONDS).',
          example: 2592000,
        },
      },
    },

    HealthReport: {
      type: 'object',
      required: ['status', 'nodeId', 'checks'],
      properties: {
        status: {
          type: 'string',
          enum: ['UP', 'DEGRADED', 'DOWN'],
          description: 'UP when every dependency is reachable; DEGRADED otherwise.',
        },
        nodeId: { type: 'string' },
        version: { type: 'string', example: '2.0.0' },
        uptimeSeconds: { type: 'number' },
        checks: {
          type: 'object',
          properties: {
            writeModel: { type: 'string', enum: ['CONNECTED', 'DISCONNECTED'] },
            readModel: { type: 'string', enum: ['CONNECTED', 'DISCONNECTED'] },
            redis: { type: 'string', enum: ['CONNECTED', 'IN_PROCESS_FALLBACK', 'DISCONNECTED'] },
          },
        },
        latencyMs: { type: 'integer' },
        topology: {
          type: 'object',
          nullable: true,
          description: 'Detected server capabilities, or null when the write model is down.',
          properties: {
            citus: { type: 'boolean' },
            pgPartman: { type: 'boolean' },
            nativeUuidv7: { type: 'boolean' },
            serverVersionNum: { type: 'integer' },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },

    TopologyReport: {
      type: 'object',
      description: 'Citus coordinator, workers and shard placement.',
      required: ['coordinator', 'workers', 'shards'],
      properties: {
        coordinator: {
          type: 'object',
          properties: {
            nodeId: { type: 'integer' },
            host: { type: 'string' },
            port: { type: 'integer' },
            isActive: { type: 'boolean' },
            role: { type: 'string' },
          },
        },
        workers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'integer' },
              groupId: { type: 'integer', description: '0 = coordinator group.' },
              host: { type: 'string' },
              port: { type: 'integer' },
              isActive: { type: 'boolean' },
              isPrimary: { type: 'boolean' },
            },
          },
        },
        shards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              shardId: { type: 'integer' },
              shardName: { type: 'string' },
              nodeId: { type: 'integer' },
              shardMinValue: { type: 'string', nullable: true },
              shardMaxValue: { type: 'string', nullable: true },
            },
          },
        },
        distribution: {
          type: 'object',
          properties: {
            strategy: { type: 'string', enum: ['hash', 'append', 'range', 'single'] },
            shardCount: { type: 'integer' },
            colocationGroups: { type: 'integer' },
          },
        },
        generatedAt: { type: 'string', format: 'date-time' },
      },
    },

    OutboxStats: {
      type: 'object',
      description: 'Transactional-outbox backlog, the leading indicator of read-model lag.',
      required: ['pending', 'total', 'oldestEventAgeMs'],
      properties: {
        pending: { type: 'integer', example: 12 },
        published: { type: 'integer', example: 98234 },
        failed: { type: 'integer', example: 1 },
        total: { type: 'integer', example: 98247 },
        oldestEventAgeMs: {
          type: 'integer',
          nullable: true,
          description: 'Age of the oldest unpublished event, or null when the outbox is drained.',
          example: 4200,
        },
        oldestEventAt: { type: 'string', format: 'date-time', nullable: true },
        lastPublishedAt: { type: 'string', format: 'date-time', nullable: true },
        byEventType: {
          type: 'object',
          additionalProperties: { type: 'integer' },
          description: 'Pending counts broken down by event_type.',
        },
      },
    },

    Pagination: {
      type: 'object',
      required: ['limit', 'offset', 'total', 'hasMore'],
      properties: {
        limit: { type: 'integer', example: 20 },
        offset: { type: 'integer', example: 0 },
        total: { type: 'integer', example: 1 },
        hasMore: { type: 'boolean', example: false },
      },
    },

    MyBooking: {
      type: 'object',
      description: 'A row of the user_bookings projection powering GET /api/users/me/bookings.',
      required: ['bookingId', 'bookingReference', 'flightId', 'status', 'departureDate'],
      properties: {
        bookingId: { type: 'string', format: 'uuid' },
        bookingReference: { type: 'string', example: 'BK-7F9A12K4QW' },
        flightId: { type: 'string', format: 'uuid' },
        flightNumber: { type: 'string', example: 'PK123' },
        airlineCode: { type: 'string', example: 'PK' },
        origin: { type: 'string', example: 'ISB' },
        destination: { type: 'string', example: 'LHR' },
        departureDate: { type: 'string', format: 'date' },
        departureTime: { type: 'string', format: 'date-time', nullable: true },
        cabin: { type: 'string', enum: CABINS },
        seatNumber: { type: 'string', nullable: true, example: '12A' },
        passengerName: { type: 'string', nullable: true },
        status: { type: 'string', enum: Object.values(BOOKING_STATUS) },
        price: { type: 'number', format: 'double', nullable: true },
        currency: { type: 'string', nullable: true },
        bookingCreatedAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },

    RegisterRequest: {
      type: 'object',
      required: ['email', 'password', 'fullName'],
      properties: {
        email: { type: 'string', format: 'email', example: 'ada.lovelace@example.com' },
        password: { type: 'string', format: 'password', minLength: 8, maxLength: 128 },
        fullName: { type: 'string', minLength: 1, maxLength: 200, example: 'Ada Lovelace' },
        phone: { type: 'string', nullable: true, example: '+92-300-1234567' },
        role: {
          type: 'string',
          enum: Object.values(USER_ROLES),
          default: 'PASSENGER',
          description:
            'Self-registration only accepts PASSENGER; agent/admin accounts are provisioned out ' +
            'of band.',
        },
      },
    },

    LoginRequest: {
      type: 'object',
      required: ['email', 'password'],
      properties: {
        email: { type: 'string', format: 'email', example: 'ada.lovelace@example.com' },
        password: { type: 'string', format: 'password', minLength: 8, maxLength: 128 },
      },
    },

    RefreshRequest: {
      type: 'object',
      required: ['refreshToken'],
      properties: {
        refreshToken: {
          type: 'string',
          description: 'The refresh token received from a prior login or refresh.',
        },
      },
    },

    AdminFlightUpsertRequest: {
      type: 'object',
      required: [
        'flightNumber',
        'airlineCode',
        'origin',
        'destination',
        'departureTime',
        'arrivalTime',
        'aircraftType',
        'basePrice',
        'cabins',
      ],
      properties: {
        flightId: {
          type: 'string',
          format: 'uuid',
          description:
            'Optional. Supply it to make re-imports idempotent; omit it and the database mints ' +
            'a UUIDv7, so re-running the same import creates a second flight.',
        },
        flightNumber: { type: 'string', example: 'PK124' },
        airlineCode: { type: 'string', example: 'PK' },
        origin: { type: 'string', minLength: 3, maxLength: 3, example: 'ISB' },
        destination: { type: 'string', minLength: 3, maxLength: 3, example: 'LHR' },
        departureTime: {
          type: 'string',
          format: 'date-time',
          description:
            'An RFC 3339 instant with an explicit offset. The offset is mandatory: ' +
            'departureDate must be the UTC date of this instant, and a string without one ' +
            'would be read in the server’s zone.',
        },
        arrivalTime: { type: 'string', format: 'date-time' },
        departureDate: {
          type: 'string',
          format: 'date',
          description:
            'Optional. Defaults to the UTC date of departureTime. A value that disagrees with ' +
            'departureTime is rejected by the ck_flights_departure_date constraint rather than ' +
            'silently corrected, because it decides which monthly partition the row lands in.',
        },
        aircraftType: { type: 'string', example: 'A320' },
        basePrice: {
          type: 'number',
          format: 'double',
          minimum: 0,
          maximum: 99999999.99,
          example: 249.0,
        },
        currency: { type: 'string', pattern: '^[A-Za-z]{3}$', default: 'USD' },
        status: { type: 'string', enum: Object.values(FLIGHT_STATUS), default: 'SCHEDULED' },
        cabins: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            required: ['cabin', 'totalSeats'],
            properties: {
              cabin: { type: 'string', enum: CABINS },
              totalSeats: { type: 'integer', minimum: 0, maximum: 1000, example: 180 },
              price: { type: 'number', format: 'double', minimum: 0, maximum: 99999999.99 },
            },
          },
        },
      },
    },
  },
};

module.exports = { paths, components };
