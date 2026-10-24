const Flight = require('../models/flight.model');

class FlightRepository {
  async findById(flightId, session = null) {
    const query = Flight.findById(flightId);
    if (session) query.session(session);
    return query.exec();
  }

  async findByFlightNumber(flightNumber, session = null) {
    const query = Flight.findOne({ flightNumber: flightNumber.toUpperCase() });
    if (session) query.session(session);
    return query.exec();
  }

  async findWithFilters(filters = {}) {
    const queryObj = {};

    if (filters.flightNumber) {
      queryObj.flightNumber = filters.flightNumber.toUpperCase();
    }
    if (filters.origin) {
      queryObj.origin = filters.origin.toUpperCase();
    }
    if (filters.destination) {
      queryObj.destination = filters.destination.toUpperCase();
    }
    if (filters.maxPrice !== undefined && filters.maxPrice !== '') {
      queryObj.price = { $lte: Number(filters.maxPrice) };
    }
    if (filters.hasAvailableSeats === 'true' || filters.hasAvailableSeats === true || filters.availableSeats === true) {
      queryObj.availableSeats = { $gt: 0 };
    } else if (filters.minAvailableSeats !== undefined && filters.minAvailableSeats !== '') {
      queryObj.availableSeats = { $gte: Number(filters.minAvailableSeats) };
    }
    if (filters.status) {
      queryObj.status = filters.status.toUpperCase();
    }

    return Flight.find(queryObj).sort({ departureTime: 1 }).exec();
  }

  async create(flightData, session = null) {
    const docs = await Flight.create([flightData], { session });
    return docs[0];
  }

  /**
   * Atomically decrements available seats count within a transaction.
   * Condition ensures availableSeats > 0 to prevent negative inventory.
   */
  async decrementAvailableSeats(flightId, session = null) {
    const options = session ? { session } : {};
    return Flight.updateOne(
      { _id: flightId, availableSeats: { $gt: 0 } },
      { $inc: { availableSeats: -1 } },
      options
    );
  }

  /**
   * Atomically increments available seats count within a transaction.
   * Used when rolling back or cancelling a confirmed booking.
   */
  async incrementAvailableSeats(flightId, session = null) {
    const options = session ? { session } : {};
    return Flight.updateOne(
      { _id: flightId },
      { $inc: { availableSeats: 1 } },
      options
    );
  }
}

module.exports = new FlightRepository();
