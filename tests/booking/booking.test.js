const request = require('supertest');
const app = require('../../src/app');
const Flight = require('../../src/models/flight.model');
const Seat = require('../../src/models/seat.model');
const Booking = require('../../src/models/booking.model');
const {
  setupTestDB,
  teardownTestDB,
  clearTestDB,
  seedTestFlightAndSeats
} = require('../setup');

describe('Booking API & Lifecycle Tests', () => {
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

  describe('1. Normal Successful Booking', () => {
    it('should successfully book an available seat and update seat & flight inventory', async () => {
      const payload = {
        flightId: seeded.flight._id.toString(),
        seatNumber: '12A',
        passengerId: 'PASS-1001'
      };

      const res = await request(app)
        .post('/api/bookings')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.bookingReference).toMatch(/^BK-[A-F0-9]{8}$/);
      expect(res.body.data.seatNumber).toBe('12A');
      expect(res.body.data.passengerId).toBe('PASS-1001');
      expect(res.body.data.nodeId).toBeDefined();
      expect(res.body.data.transactionId).toBeDefined();
      expect(res.body.data.status).toBe('CONFIRMED');

      // Verify Seat in database
      const seat = await Seat.findOne({
        flightId: seeded.flight._id,
        seatNumber: '12A'
      });
      expect(seat.status).toBe('BOOKED');
      expect(seat.version).toBe(1); // incremented from 0 to 1
      expect(seat.bookingId.toString()).toBe(res.body.data._id.toString());

      // Verify Flight in database
      const flight = await Flight.findById(seeded.flight._id);
      expect(flight.availableSeats).toBe(seeded.flight.availableSeats - 1);
    });
  });

  describe('2. Booking an Already-Booked Seat', () => {
    it('should return 409 Conflict when attempting to book a seat that is already booked', async () => {
      // First booking succeeds
      await request(app)
        .post('/api/bookings')
        .send({
          flightId: seeded.flight._id.toString(),
          seatNumber: '12A',
          passengerId: 'PASS-1001'
        })
        .expect(201);

      // Second booking attempt for same seat MUST fail
      const conflictRes = await request(app)
        .post('/api/bookings')
        .send({
          flightId: seeded.flight._id.toString(),
          seatNumber: '12A',
          passengerId: 'PASS-1002'
        })
        .expect(409);

      expect(conflictRes.body.success).toBe(false);
      expect(conflictRes.body.error.code).toBe('SEAT_UNAVAILABLE');

      // Confirm in DB that only 1 booking exists
      const bookingsCount = await Booking.countDocuments({
        flightId: seeded.flight._id,
        seatNumber: '12A',
        status: 'CONFIRMED'
      });
      expect(bookingsCount).toBe(1);
    });
  });

  describe('3. Booking Cancellation', () => {
    it('should cancel a confirmed booking, restore seat to AVAILABLE, and increment availableSeats', async () => {
      // 1. Create booking
      const bookRes = await request(app)
        .post('/api/bookings')
        .send({
          flightId: seeded.flight._id.toString(),
          seatNumber: '12B',
          passengerId: 'PASS-2001'
        })
        .expect(201);

      const bookingId = bookRes.body.data._id;
      const initialAvailable = seeded.flight.availableSeats - 1;

      // 2. Cancel booking
      const cancelRes = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .expect(200);

      expect(cancelRes.body.success).toBe(true);
      expect(cancelRes.body.data.status).toBe('CANCELLED');

      // 3. Verify database state
      const bookingInDb = await Booking.findById(bookingId);
      expect(bookingInDb.status).toBe('CANCELLED');

      const seatInDb = await Seat.findOne({
        flightId: seeded.flight._id,
        seatNumber: '12B'
      });
      expect(seatInDb.status).toBe('AVAILABLE');
      expect(seatInDb.bookingId).toBeNull();
      expect(seatInDb.version).toBe(2); // 0 -> 1 on book, 1 -> 2 on cancel

      const flightInDb = await Flight.findById(seeded.flight._id);
      expect(flightInDb.availableSeats).toBe(initialAvailable + 1);
    });

    it('should reject cancelling an already cancelled booking', async () => {
      const bookRes = await request(app)
        .post('/api/bookings')
        .send({
          flightId: seeded.flight._id.toString(),
          seatNumber: '12C',
          passengerId: 'PASS-2002'
        })
        .expect(201);

      const bookingId = bookRes.body.data._id;

      // First cancel succeeds
      await request(app).post(`/api/bookings/${bookingId}/cancel`).expect(200);

      // Second cancel must fail
      const secondCancel = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .expect(400);

      expect(secondCancel.body.error.code).toBe('ALREADY_CANCELLED');
    });
  });

  describe('5. Duplicate / Idempotent Booking Requests', () => {
    it('should return identical booking without creating duplicate records when same idempotencyKey is sent', async () => {
      const idempotencyKey = 'IDEMP-TEST-KEY-999';

      const payload = {
        flightId: seeded.flight._id.toString(),
        seatNumber: '14A',
        passengerId: 'PASS-IDEMP',
        idempotencyKey
      };

      // First request
      const firstRes = await request(app)
        .post('/api/bookings')
        .send(payload)
        .expect(201);

      expect(firstRes.body.isIdempotentReplay).toBe(false);
      const originalRef = firstRes.body.data.bookingReference;

      // Duplicate request with identical idempotencyKey
      const duplicateRes = await request(app)
        .post('/api/bookings')
        .send(payload)
        .expect(200);

      expect(duplicateRes.body.isIdempotentReplay).toBe(true);
      expect(duplicateRes.body.data.bookingReference).toBe(originalRef);
      expect(duplicateRes.body.data._id).toBe(firstRes.body.data._id);

      // Verify database invariant: Exactly ONE booking record exists
      const count = await Booking.countDocuments({
        idempotencyKey
      });
      expect(count).toBe(1);
    });
  });

  describe('Flight Search & Seat Queries', () => {
    it('should search flights with filtering criteria', async () => {
      const res = await request(app)
        .get('/api/flights?origin=ISB&destination=LHR')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(1);
      expect(res.body.data[0].flightNumber).toBe('PK123');
    });

    it('should get flight details and seat map', async () => {
      const flightRes = await request(app)
        .get(`/api/flights/${seeded.flight._id}`)
        .expect(200);

      expect(flightRes.body.data.flightNumber).toBe('PK123');

      const seatsRes = await request(app)
        .get(`/api/flights/${seeded.flight._id}/seats`)
        .expect(200);

      expect(seatsRes.body.count).toBe(6);
      expect(seatsRes.body.data.some((s) => s.seatNumber === '12A')).toBe(true);
    });
  });
});
