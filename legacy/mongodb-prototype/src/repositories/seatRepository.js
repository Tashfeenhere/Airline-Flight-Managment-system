const Seat = require('../models/seat.model');
const { SEAT_STATUS } = require('../config/constants');

class SeatRepository {
  async findByFlightAndSeatNumber(flightId, seatNumber, session = null) {
    const query = Seat.findOne({
      flightId,
      seatNumber: seatNumber.toUpperCase()
    });
    if (session) query.session(session);
    return query.exec();
  }

  async findSeatsByFlight(flightId, status = null, session = null) {
    const filter = { flightId };
    if (status) {
      filter.status = status.toUpperCase();
    }
    const query = Seat.find(filter).sort({ seatNumber: 1 });
    if (session) query.session(session);
    return query.exec();
  }

  async createSeats(seatsData, session = null) {
    return Seat.insertMany(seatsData, { session });
  }

  /**
   * Core Optimistic Concurrency Control (OCC) operation.
   * Atomically matches the exact expectedVersion and status=AVAILABLE,
   * transitions status to BOOKED, attaches the bookingId, and increments version.
   * 
   * Returns MongoDB UpdateResult:
   * - matchedCount: 1 if version matched and status was AVAILABLE
   * - matchedCount: 0 if version changed or status was already BOOKED (conflict!)
   */
  async bookSeatOptimistic({ flightId, seatNumber, expectedVersion, bookingId, session }) {
    const options = session ? { session } : {};
    return Seat.updateOne(
      {
        flightId,
        seatNumber: seatNumber.toUpperCase(),
        version: expectedVersion,
        status: SEAT_STATUS.AVAILABLE
      },
      {
        $set: {
          status: SEAT_STATUS.BOOKED,
          bookingId
        },
        $inc: {
          version: 1
        }
      },
      options
    );
  }

  /**
   * Releases a previously booked seat back to AVAILABLE within a transaction.
   */
  async releaseSeat({ flightId, seatNumber, bookingId, session }) {
    const options = session ? { session } : {};
    return Seat.updateOne(
      {
        flightId,
        seatNumber: seatNumber.toUpperCase(),
        bookingId,
        status: SEAT_STATUS.BOOKED
      },
      {
        $set: {
          status: SEAT_STATUS.AVAILABLE,
          bookingId: null
        },
        $inc: {
          version: 1
        }
      },
      options
    );
  }
}

module.exports = new SeatRepository();
