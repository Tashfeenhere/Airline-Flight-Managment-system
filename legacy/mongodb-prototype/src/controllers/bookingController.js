const bookingService = require('../services/bookingService');
const { HTTP_STATUS, HEADERS } = require('../config/constants');

class BookingController {
  constructor() {
    this.createBooking = this.createBooking.bind(this);
    this.getBooking = this.getBooking.bind(this);
    this.cancelBooking = this.cancelBooking.bind(this);
  }

  async createBooking(req, res, next) {
    try {
      const { flightId, seatNumber, passengerId } = req.body;
      const idempotencyKey =
        req.body.idempotencyKey ||
        req.headers[HEADERS.IDEMPOTENCY_KEY] ||
        req.headers[HEADERS.X_IDEMPOTENCY_KEY] ||
        null;

      const nodeId = req.headers[HEADERS.NODE_ID] || process.env.NODE_ID;

      const { booking, isIdempotentReplay } = await bookingService.createBooking({
        flightId,
        seatNumber,
        passengerId,
        idempotencyKey,
        nodeId
      });

      const statusCode = isIdempotentReplay ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;

      res.status(statusCode).json({
        success: true,
        isIdempotentReplay,
        data: booking
      });
    } catch (err) {
      next(err);
    }
  }

  async getBooking(req, res, next) {
    try {
      const { bookingId } = req.params;
      const booking = await bookingService.getBooking(bookingId);

      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: booking
      });
    } catch (err) {
      next(err);
    }
  }

  async cancelBooking(req, res, next) {
    try {
      const { bookingId } = req.params;
      const nodeId = req.headers[HEADERS.NODE_ID] || process.env.NODE_ID;
      const cancelled = await bookingService.cancelBooking(bookingId, nodeId);

      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Booking cancelled successfully and seat released',
        data: cancelled
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new BookingController();
