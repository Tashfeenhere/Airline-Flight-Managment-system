const mongoose = require('mongoose');
const bookingService = require('../../src/services/bookingService');
const flightRepository = require('../../src/repositories/flightRepository');
const seatRepository = require('../../src/repositories/seatRepository');
const bookingRepository = require('../../src/repositories/bookingRepository');
const Flight = require('../../src/models/flight.model');
const Seat = require('../../src/models/seat.model');
const Booking = require('../../src/models/booking.model');
const {
  setupTestDB,
  teardownTestDB,
  clearTestDB,
  seedTestFlightAndSeats
} = require('../setup');

describe('Transaction Atomicity & Rollback Tests', () => {
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
    jest.restoreAllMocks();
  });

  describe('4. Transaction Rollback on Mid-Operation Failure', () => {
    it('should completely roll back seat status and flight inventory if booking document creation fails', async () => {
      // Inject failure into booking creation step (after seat update has been staged)
      jest.spyOn(bookingRepository, 'create').mockImplementationOnce(async () => {
        throw new Error('SIMULATED_DATABASE_IO_ERROR_DURING_BOOKING_INSERT');
      });

      const flightId = seeded.flight._id.toString();
      const seatNumber = '12A';

      // Expect booking attempt to fail
      await expect(
        bookingService.createBooking({
          flightId,
          seatNumber,
          passengerId: 'PASS-FAIL-TEST'
        })
      ).rejects.toThrow('SIMULATED_DATABASE_IO_ERROR_DURING_BOOKING_INSERT');

      // Verify Transactional Invariant:
      // 1. Seat must remain AVAILABLE (not left in orphaned BOOKED state)
      const seat = await Seat.findOne({ flightId, seatNumber });
      expect(seat.status).toBe('AVAILABLE');
      expect(seat.version).toBe(0);
      expect(seat.bookingId).toBeNull();

      // 2. Flight availableSeats must remain intact (not left decremented)
      const flight = await Flight.findById(flightId);
      expect(flight.availableSeats).toBe(seeded.flight.availableSeats);

      // 3. No booking records must exist
      const bookingsCount = await Booking.countDocuments({ flightId, seatNumber });
      expect(bookingsCount).toBe(0);
    });

    it('should completely roll back if flight inventory decrement fails', async () => {
      // Inject failure into decrementAvailableSeats step
      jest.spyOn(flightRepository, 'decrementAvailableSeats').mockImplementationOnce(async () => {
        throw new Error('SIMULATED_FAILURE_ON_INVENTORY_DECREMENT');
      });

      const flightId = seeded.flight._id.toString();
      const seatNumber = '12B';

      await expect(
        bookingService.createBooking({
          flightId,
          seatNumber,
          passengerId: 'PASS-FAIL-TEST'
        })
      ).rejects.toThrow('SIMULATED_FAILURE_ON_INVENTORY_DECREMENT');

      // Verify Seat was NOT changed
      const seat = await Seat.findOne({ flightId, seatNumber });
      expect(seat.status).toBe('AVAILABLE');
      expect(seat.version).toBe(0);
      expect(seat.bookingId).toBeNull();

      // Verify Flight availableSeats was NOT changed
      const flight = await Flight.findById(flightId);
      expect(flight.availableSeats).toBe(seeded.flight.availableSeats);
    });
  });
});
