'use strict';
/**
 * The HTTP contract, exercised through Supertest against the real app and database.
 *
 * The service-level suites prove the saga and the projections; this one proves the
 * things a client actually sees and that no service test can catch:
 *
 *   - the response envelope is identical on success and failure;
 *   - status codes distinguish a fresh booking (201), a replay (200) and a refusal;
 *   - an ownership failure is reported as absence (404), not as a hint that the id
 *     exists;
 *   - the OpenAPI document covers every mounted router;
 *   - the freshness header is present on projection-backed reads.
 */
const request = require('supertest');
const {
  app,
  createUser,
  deleteUser
} = require('./helpers');
const {
  createFlight,
  cleanupFlight,
  drainOutbox,
  closePools,
  pool
} = require('../helpers/db');

const createdFlights = [];
const createdUsers = [];

async function newFlight(overrides = {}) {
  const fixture = await createFlight({ cabins: [{ cabin: 'ECONOMY', totalSeats: 3 }], ...overrides });
  createdFlights.push(fixture);
  return fixture;
}

async function newUser(role = 'PASSENGER') {
  const fixture = await createUser({ role });
  createdUsers.push(fixture.user.userId);
  return fixture;
}

afterEach(async () => {
  for (const fixture of createdFlights.splice(0)) {
    await cleanupFlight(fixture.flightId, fixture.departureDate);
  }
  for (const userId of createdUsers.splice(0)) {
    await deleteUser(userId);
  }
});

afterAll(async () => {
  await closePools();
});

describe('health and envelopes', () => {
  test('liveness succeeds and every response names the serving node', async () => {
    const res = await request(app).get('/api/health/live');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers['x-node-id']).toEqual(expect.any(String));
  });

  test('readiness checks the write and read stores', async () => {
    const res = await request(app).get('/api/health/ready');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('success');
  });

  test('an unknown route is a structured 404, not HTML', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.nodeId).toEqual(expect.any(String));
    expect(res.body.timestamp).toEqual(expect.any(String));
  });

  test('metrics are exposed in Prometheus text format', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.text).toContain('airline_http_requests_total');
    expect(res.text).toContain('airline_outbox_pending_events');
  });
});

describe('validation', () => {
  test('search requires origin, destination and date', async () => {
    const res = await request(app).get('/api/flights/search?origin=DEL');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('a malformed flight id is INVALID_ID rather than a database error', async () => {
    const res = await request(app).get('/api/flights/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ID');
  });

  test('a booking with a malformed flight id is rejected before any transaction', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .send({ flightId: 'not-a-uuid', passengerName: 'Nobody' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('booking HTTP flow', () => {
  test('create/get/reference/cancel, with ownership disguised as absence', async () => {
    const fixture = await newFlight();
    const owner = await newUser();
    const stranger = await newUser();

    const created = await request(app)
      .post('/api/bookings')
      .set('Authorization', owner.auth)
      .send({ flightId: fixture.flightId, cabin: 'ECONOMY', passengerName: 'HTTP Passenger' });

    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('CONFIRMED');
    const bookingId = created.body.data.bookingId;
    const bookingReference = created.body.data.bookingReference;

    const fetched = await request(app)
      .get(`/api/bookings/${bookingId}`)
      .set('Authorization', owner.auth);
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.bookingId).toBe(bookingId);

    const byReference = await request(app)
      .get(`/api/bookings/reference/${bookingReference}`)
      .set('Authorization', owner.auth);
    expect(byReference.status).toBe(200);
    expect(byReference.body.data.bookingId).toBe(bookingId);

    // Anyone with a valid token can probe ids; the answer must not reveal that this
    // one exists. Both read and cancel report 404, not 403.
    const peek = await request(app)
      .get(`/api/bookings/${bookingId}`)
      .set('Authorization', stranger.auth);
    expect(peek.status).toBe(404);

    const hijack = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Authorization', stranger.auth)
      .send({});
    expect(hijack.status).toBe(404);

    // Anonymous reads are 401 because there is no identity to check ownership against.
    const anonymous = await request(app).get(`/api/bookings/${bookingId}`);
    expect(anonymous.status).toBe(401);

    const cancelled = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Authorization', owner.auth)
      .send({ reason: 'HTTP_TEST' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
  });

  test('an Idempotency-Key is honored at the HTTP boundary', async () => {
    const fixture = await newFlight();
    const user = await newUser();
    const idempotencyKey = `http-${fixture.flightId}`;

    const body = {
      flightId: fixture.flightId,
      cabin: 'ECONOMY',
      passengerName: 'Replay Passenger'
    };

    const first = await request(app)
      .post('/api/bookings')
      .set('Authorization', user.auth)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replay']).toBe('false');

    const second = await request(app)
      .post('/api/bookings')
      .set('Authorization', user.auth)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.data.bookingId).toBe(first.body.data.bookingId);
  });
});

describe('read model at the API edge', () => {
  test('search returns the projected flight and publishes its freshness', async () => {
    const fixture = await newFlight();
    await drainOutbox();

    const res = await request(app).get(
      `/api/flights/search?origin=DEL&destination=BOM&departureDate=${fixture.departureDate}`
    );

    expect(res.status).toBe(200);
    const match = res.body.data.flights.find((flight) => flight.flightId === fixture.flightId);
    expect(match).toBeDefined();
    expect(match.cabins.find((cabin) => cabin.cabin === 'ECONOMY').available).toBe(3);
    // Both a header (for proxies) and a body field (for clients).
    expect(res.headers['x-read-model-lag-ms']).toEqual(expect.any(String));
    expect(res.body.data.readModelLagMs).toEqual(expect.any(Number));
  });

  test('authoritative availability comes from the write model and carries a version', async () => {
    const fixture = await newFlight();

    const res = await request(app).get(`/api/flights/${fixture.flightId}/availability`);

    expect(res.status).toBe(200);
    expect(res.body.data.authoritative).toBe(true);
    const economy = res.body.data.cabins.find((cabin) => cabin.cabin === 'ECONOMY');
    expect(economy.capacity).toBe(3);
    expect(economy.available).toBe(3);
    expect(economy).toHaveProperty('version');
  });
});

describe('OpenAPI coverage', () => {
  test('every mounted router appears in the published document', async () => {
    const res = await request(app).get('/api-docs.json');
    expect(res.status).toBe(200);

    const paths = Object.keys(res.body.paths);
    const routers = require('../../src/routes').routers;

    for (const { path } of routers) {
      const covered = paths.some(
        (documented) => documented === path || documented.startsWith(`${path}/`)
      );
      expect({ path, covered }).toEqual({ path, covered: true });
    }
  });
});
