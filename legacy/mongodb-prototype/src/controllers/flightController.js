const flightService = require('../services/flightService');
const { HTTP_STATUS } = require('../config/constants');

class FlightController {
  constructor() {
    this.getAllFlights = this.getAllFlights.bind(this);
    this.getFlightById = this.getFlightById.bind(this);
    this.getFlightSeats = this.getFlightSeats.bind(this);
  }

  async getAllFlights(req, res, next) {
    try {
      const { flightNumber, origin, destination, maxPrice, hasAvailableSeats, minAvailableSeats, status } = req.query;
      const flights = await flightService.getAllFlights({
        flightNumber,
        origin,
        destination,
        maxPrice,
        hasAvailableSeats,
        minAvailableSeats,
        status
      });

      res.status(HTTP_STATUS.OK).json({
        success: true,
        count: flights.length,
        data: flights
      });
    } catch (err) {
      next(err);
    }
  }

  async getFlightById(req, res, next) {
    try {
      const { flightId } = req.params;
      const flight = await flightService.getFlightById(flightId);

      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: flight
      });
    } catch (err) {
      next(err);
    }
  }

  async getFlightSeats(req, res, next) {
    try {
      const { flightId } = req.params;
      const { status } = req.query;
      const seats = await flightService.getFlightSeats(flightId, status);

      res.status(HTTP_STATUS.OK).json({
        success: true,
        count: seats.length,
        data: seats
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new FlightController();
