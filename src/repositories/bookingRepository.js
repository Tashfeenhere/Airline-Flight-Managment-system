const mongoose = require('mongoose');
const Booking = require('../models/booking.model');
const { BOOKING_STATUS } = require('../config/constants');

class BookingRepository {
  async create(bookingData, session = null) {
    const docs = await Booking.create([bookingData], { session });
    return docs[0];
  }

  async findById(bookingId, session = null) {
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return null;
    }
    const query = Booking.findById(bookingId);
    if (session) query.session(session);
    return query.exec();
  }

  async findByBookingReference(bookingReference, session = null) {
    const query = Booking.findOne({ bookingReference: bookingReference.toUpperCase() });
    if (session) query.session(session);
    return query.exec();
  }

  async findByIdOrReference(identifier, session = null) {
    if (mongoose.Types.ObjectId.isValid(identifier)) {
      const byId = await this.findById(identifier, session);
      if (byId) return byId;
    }
    return this.findByBookingReference(identifier, session);
  }

  async findByIdempotencyKey(idempotencyKey, session = null) {
    if (!idempotencyKey) return null;
    const query = Booking.findOne({ idempotencyKey });
    if (session) query.session(session);
    return query.exec();
  }

  async updateStatus(bookingId, status, session = null) {
    const options = session ? { session } : {};
    return Booking.updateOne(
      { _id: bookingId },
      { $set: { status } },
      options
    );
  }

  async countConfirmedBookings(flightId, seatNumber) {
    return Booking.countDocuments({
      flightId,
      seatNumber: seatNumber.toUpperCase(),
      status: BOOKING_STATUS.CONFIRMED
    });
  }
}

module.exports = new BookingRepository();
