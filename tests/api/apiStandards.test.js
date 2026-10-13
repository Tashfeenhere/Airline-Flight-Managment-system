const request = require('supertest');
const app = require('../../src/app');
const {
  setupTestDB,
  teardownTestDB,
  clearTestDB,
  seedTestFlightAndSeats
} = require('../setup');
const { HTTP_STATUS, ERROR_CODES, HEADERS } = require('../../src/config/constants');

describe('API Production Standards & Swagger OpenAPI Tests', () => {
  let seeded;

  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    seeded = await seedTestFlightAndSeats();
  });

  describe('1. Swagger / OpenAPI Documentation Integration', () => {
    it('should serve Swagger UI at /api-docs with HTML response', async () => {
      const res = await request(app)
        .get('/api-docs/')
        .expect(HTTP_STATUS.OK);

      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('swagger-ui');
    });

    it('should serve complete OpenAPI 3.0 specification at /api-docs.json', async () => {
      const res = await request(app)
        .get('/api-docs.json')
        .expect(HTTP_STATUS.OK);

      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.openapi).toBe('3.0.3');
      expect(res.body.info.title).toBe('Distributed Airline Seat Inventory API');

      // Verify all key endpoints are documented
      const paths = res.body.paths;
      expect(paths['/']).toBeDefined();
      expect(paths['/api/health']).toBeDefined();
      expect(paths['/api/flights']).toBeDefined();
      expect(paths['/api/flights/{flightId}']).toBeDefined();
      expect(paths['/api/flights/{flightId}/seats']).toBeDefined();
      expect(paths['/api/bookings']).toBeDefined();
      expect(paths['/api/bookings/{bookingId}']).toBeDefined();
      expect(paths['/api/bookings/{bookingId}/cancel']).toBeDefined();

      // Verify components and schemas
      const schemas = res.body.components.schemas;
      expect(schemas.Flight).toBeDefined();
      expect(schemas.Seat).toBeDefined();
      expect(schemas.Booking).toBeDefined();
      expect(schemas.CreateBookingRequest).toBeDefined();
      expect(schemas.ErrorResponse).toBeDefined();
    });

    it('should include documentation link in root / endpoint', async () => {
      const res = await request(app)
        .get('/')
        .expect(HTTP_STATUS.OK);

      expect(res.body.docs).toBe('/api-docs');
      expect(res.body.status).toBe('ONLINE');
      expect(res.headers[HEADERS.NODE_ID]).toBeDefined();
    });
  });

  describe('2. Health Endpoint & Cluster Node Monitoring', () => {
    it('should report database connection and node status on /api/health', async () => {
      const res = await request(app)
        .get('/api/health')
        .expect(HTTP_STATUS.OK);

      expect(res.body.status).toBe('UP');
      expect(res.body.database).toBe('CONNECTED');
      expect(res.body.nodeId).toBeDefined();
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('3. Centralized Input Validation & Meaningful HTTP Status Codes', () => {
    it('should return 400 Bad Request when flightId in path is not a valid ObjectId', async () => {
      const res = await request(app)
        .get('/api/flights/invalid-object-id-123')
        .expect(HTTP_STATUS.BAD_REQUEST);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(res.body.error.details).toBeInstanceOf(Array);
      expect(res.body.error.details.some((d) => d.field === 'flightId')).toBe(true);
    });

    it('should return 400 Bad Request when creating a booking with missing mandatory fields', async () => {
      const res = await request(app)
        .post('/api/bookings')
        .send({})
        .expect(HTTP_STATUS.BAD_REQUEST);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(3);
    });

    it('should return 400 Bad Request when seat status query is invalid', async () => {
      const res = await request(app)
        .get(`/api/flights/${seeded.flight._id}/seats?status=NOT_A_STATUS`)
        .expect(HTTP_STATUS.BAD_REQUEST);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('should return 400 Bad Request when flight search has negative maxPrice', async () => {
      const res = await request(app)
        .get('/api/flights?maxPrice=-50')
        .expect(HTTP_STATUS.BAD_REQUEST);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(res.body.error.details.some((d) => d.field === 'maxPrice')).toBe(true);
    });

    it('should return 404 Not Found for undefined routes', async () => {
      const res = await request(app)
        .get('/api/non-existent-resource')
        .expect(HTTP_STATUS.NOT_FOUND);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });
  });

  describe('4. RESTful API Design & Booking Cancellation', () => {
    it('should cancel booking and release seat via DELETE /api/bookings/:bookingId', async () => {
      // 1. Create booking
      const bookRes = await request(app)
        .post('/api/bookings')
        .send({
          flightId: seeded.flight._id.toString(),
          seatNumber: '12A',
          passengerId: 'PASS-DELETE-TEST'
        })
        .expect(HTTP_STATUS.CREATED);

      const bookingId = bookRes.body.data._id;

      // 2. Cancel via RESTful DELETE
      const cancelRes = await request(app)
        .delete(`/api/bookings/${bookingId}`)
        .expect(HTTP_STATUS.OK);

      expect(cancelRes.body.success).toBe(true);
      expect(cancelRes.body.data.status).toBe('CANCELLED');

      // 3. Verify seat is back to AVAILABLE
      const seatsRes = await request(app)
        .get(`/api/flights/${seeded.flight._id}/seats?status=AVAILABLE`)
        .expect(HTTP_STATUS.OK);

      const seat12A = seatsRes.body.data.find((s) => s.seatNumber === '12A');
      expect(seat12A).toBeDefined();
      expect(seat12A.status).toBe('AVAILABLE');
    });

    it('should retrieve single booking details via GET /api/bookings/:bookingId', async () => {
      const bookRes = await request(app)
        .post('/api/bookings')
        .send({
          flightId: seeded.flight._id.toString(),
          seatNumber: '12B',
          passengerId: 'PASS-GET-TEST'
        })
        .expect(HTTP_STATUS.CREATED);

      const bookingRef = bookRes.body.data.bookingReference;

      const getRes = await request(app)
        .get(`/api/bookings/${bookingRef}`)
        .expect(HTTP_STATUS.OK);

      expect(getRes.body.success).toBe(true);
      expect(getRes.body.data.bookingReference).toBe(bookingRef);
    });
  });
});
