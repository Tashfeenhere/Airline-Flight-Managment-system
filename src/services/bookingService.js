const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const flightRepository = require('../repositories/flightRepository');
const seatRepository = require('../repositories/seatRepository');
const bookingRepository = require('../repositories/bookingRepository');
const { generateBookingReference } = require('../utils/referenceGenerator');
const { logBookingEvent } = require('../utils/logger');
const { executeWithRetry } = require('../concurrency/transactionRetry');
const {
  BOOKING_STATUS,
  SEAT_STATUS,
  HTTP_STATUS,
  ERROR_CODES,
  LOG_OPERATIONS,
  LOG_RESULTS
} = require('../config/constants');
const {
  ValidationError,
  NotFoundError,
  SeatUnavailableError,
  VersionConflictError,
  DuplicateBookingError,
  AppError
} = require('../utils/errors');

class BookingService {
  /**
   * Creates a seat booking with optimistic concurrency control and MongoDB transactions.
   */
  async createBooking({ flightId, seatNumber, passengerId, idempotencyKey = null, nodeId = null }) {
    const startTime = Date.now();
    const transactionId = uuidv4();
    const activeNodeId = nodeId || process.env.NODE_ID || env.NODE_ID;

    // 1. Basic input validation for programmatic service invocation
    if (!flightId) throw new ValidationError('flightId is required');
    if (!seatNumber) throw new ValidationError('seatNumber is required');
    if (!passengerId) throw new ValidationError('passengerId is required');

    const normalizedSeatNumber = seatNumber.trim().toUpperCase();

    // 2. Check Idempotency before starting heavy transaction
    if (idempotencyKey) {
      const existingBooking = await bookingRepository.findByIdempotencyKey(idempotencyKey);
      if (existingBooking) {
        logBookingEvent({
          nodeId: activeNodeId,
          transactionId,
          flightId,
          seatNumber: normalizedSeatNumber,
          operation: LOG_OPERATIONS.BOOKING_IDEMPOTENT_CHECK,
          retryCount: 0,
          result: LOG_RESULTS.IDEMPOTENT_HIT,
          durationMs: Date.now() - startTime
        });
        return {
          booking: existingBooking,
          isIdempotentReplay: true
        };
      }
    }

    let retriesPerformed = 0;

    try {
      // 3. Execute booking transaction with retry for transient database conflicts
      const confirmedBooking = await executeWithRetry(async (attempt) => {
        retriesPerformed = attempt;

        const session = await mongoose.startSession();
        session.startTransaction({
          readPreference: 'primary',
          readConcern: { level: 'local' },
          writeConcern: { w: 'majority' }
        });

        try {
          // Verify flight exists and has remaining seats
          const flight = await flightRepository.findById(flightId, session);
          if (!flight) {
            throw new NotFoundError(`Flight with ID ${flightId} not found`);
          }
          if (flight.availableSeats <= 0) {
            throw new SeatUnavailableError('No seats available on this flight');
          }

          // Read the requested seat within transaction
          const seat = await seatRepository.findByFlightAndSeatNumber(
            flightId,
            normalizedSeatNumber,
            session
          );

          if (!seat) {
            throw new NotFoundError(
              `Seat ${normalizedSeatNumber} not found for flight ${flightId}`
            );
          }

          // Verify seat is currently AVAILABLE
          if (seat.status !== SEAT_STATUS.AVAILABLE) {
            throw new SeatUnavailableError(
              `Seat ${normalizedSeatNumber} is already booked (status: ${seat.status})`
            );
          }

          // Capture current version for Optimistic Concurrency Control
          const currentVersion = seat.version;
          const tentativeBookingId = new mongoose.Types.ObjectId();

          // Atomic version-checked update: status -> BOOKED, version -> version + 1
          const seatUpdateResult = await seatRepository.bookSeatOptimistic({
            flightId,
            seatNumber: normalizedSeatNumber,
            expectedVersion: currentVersion,
            bookingId: tentativeBookingId,
            session
          });

          // If matchedCount is 0, another node changed version or status concurrently
          if (seatUpdateResult.matchedCount === 0) {
            throw new VersionConflictError(
              `Optimistic concurrency conflict: Seat ${normalizedSeatNumber} was modified by another transaction (expected v${currentVersion})`
            );
          }

          // Atomically decrement flight available seats count
          const flightUpdateResult = await flightRepository.decrementAvailableSeats(
            flightId,
            session
          );

          if (flightUpdateResult.matchedCount === 0) {
            throw new SeatUnavailableError('Flight seat inventory depleted during booking');
          }

          const bookingReference = generateBookingReference();

          // Create Booking record
          const bookingDoc = await bookingRepository.create(
            {
              _id: tentativeBookingId,
              bookingReference,
              flightId,
              seatNumber: normalizedSeatNumber,
              passengerId,
              nodeId: activeNodeId,
              transactionId,
              status: BOOKING_STATUS.CONFIRMED,
              idempotencyKey: idempotencyKey || null
            },
            session
          );

          // Commit transaction
          await session.commitTransaction();

          return bookingDoc;
        } catch (txnError) {
          if (session.inTransaction()) {
            await session.abortTransaction();
          }

          // Check if failure was due to duplicate booking or duplicate idempotency key
          if (txnError.code === 11000) {
            if (idempotencyKey && txnError.keyPattern?.idempotencyKey) {
              const duplicateBooking = await bookingRepository.findByIdempotencyKey(idempotencyKey);
              if (duplicateBooking) {
                return duplicateBooking;
              }
            }
            throw new DuplicateBookingError(
              `A confirmed booking already exists for seat ${normalizedSeatNumber}`
            );
          }

          throw txnError;
        } finally {
          await session.endSession();
        }
      });

      // Log successful booking
      logBookingEvent({
        nodeId: activeNodeId,
        transactionId,
        flightId,
        seatNumber: normalizedSeatNumber,
        operation: LOG_OPERATIONS.BOOKING_CREATE,
        retryCount: retriesPerformed,
        result: LOG_RESULTS.SUCCESS,
        durationMs: Date.now() - startTime
      });

      return {
        booking: confirmedBooking,
        isIdempotentReplay: false
      };
    } catch (error) {
      logBookingEvent({
        nodeId: activeNodeId,
        transactionId,
        flightId,
        seatNumber: normalizedSeatNumber,
        operation: LOG_OPERATIONS.BOOKING_CREATE,
        retryCount: retriesPerformed,
        result: error.code || LOG_RESULTS.FAILED,
        error,
        durationMs: Date.now() - startTime
      });

      throw error;
    }
  }

  /**
   * Transactionally cancels an existing booking, releases the seat, and increments available flight seats.
   */
  async cancelBooking(identifier, nodeId = null) {
    const startTime = Date.now();
    const transactionId = uuidv4();
    const activeNodeId = nodeId || process.env.NODE_ID || env.NODE_ID;

    if (!identifier) {
      throw new ValidationError('Booking identifier is required');
    }

    let retriesPerformed = 0;

    try {
      const cancelledBooking = await executeWithRetry(async (attempt) => {
        retriesPerformed = attempt;

        const session = await mongoose.startSession();
        session.startTransaction({
          readPreference: 'primary',
          readConcern: { level: 'local' },
          writeConcern: { w: 'majority' }
        });

        try {
          const booking = await bookingRepository.findByIdOrReference(identifier, session);
          if (!booking) {
            throw new NotFoundError(`Booking '${identifier}' not found`);
          }

          if (booking.status === BOOKING_STATUS.CANCELLED) {
            throw new AppError('Booking is already cancelled', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.ALREADY_CANCELLED);
          }

          if (booking.status !== BOOKING_STATUS.CONFIRMED) {
            throw new AppError(
              `Cannot cancel booking in status: ${booking.status}`,
              HTTP_STATUS.BAD_REQUEST,
              ERROR_CODES.INVALID_STATUS
            );
          }

          // 1. Mark booking as CANCELLED
          await bookingRepository.updateStatus(booking._id, BOOKING_STATUS.CANCELLED, session);

          // 2. Release seat back to AVAILABLE
          await seatRepository.releaseSeat({
            flightId: booking.flightId,
            seatNumber: booking.seatNumber,
            bookingId: booking._id,
            session
          });

          // 3. Increment flight available seats
          await flightRepository.incrementAvailableSeats(booking.flightId, session);

          // 4. Commit transaction
          await session.commitTransaction();

          booking.status = BOOKING_STATUS.CANCELLED;
          return booking;
        } catch (txnError) {
          if (session.inTransaction()) {
            await session.abortTransaction();
          }
          throw txnError;
        } finally {
          await session.endSession();
        }
      });

      logBookingEvent({
        nodeId: activeNodeId,
        transactionId,
        flightId: cancelledBooking.flightId,
        seatNumber: cancelledBooking.seatNumber,
        operation: LOG_OPERATIONS.BOOKING_CANCEL,
        retryCount: retriesPerformed,
        result: LOG_RESULTS.SUCCESS,
        durationMs: Date.now() - startTime
      });

      return cancelledBooking;
    } catch (error) {
      logBookingEvent({
        nodeId: activeNodeId,
        transactionId,
        flightId: 'N/A',
        seatNumber: 'N/A',
        operation: LOG_OPERATIONS.BOOKING_CANCEL,
        retryCount: retriesPerformed,
        result: error.code || LOG_RESULTS.FAILED,
        error,
        durationMs: Date.now() - startTime
      });

      throw error;
    }
  }

  async getBooking(identifier) {
    const booking = await bookingRepository.findByIdOrReference(identifier);
    if (!booking) {
      throw new NotFoundError(`Booking '${identifier}' not found`);
    }
    return booking;
  }
}

module.exports = new BookingService();
