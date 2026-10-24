const flightRepository = require('../repositories/flightRepository');
const seatRepository = require('../repositories/seatRepository');
const { NotFoundError } = require('../utils/errors');

class FlightService {
  async getAllFlights(filters = {}) {
    return flightRepository.findWithFilters(filters);
  }

  async getFlightById(flightId) {
    const flight = await flightRepository.findById(flightId);
    if (!flight) {
      throw new NotFoundError(`Flight with ID ${flightId} not found`);
    }
    return flight;
  }

  async getFlightSeats(flightId, statusFilter = null) {
    // Verify flight exists
    await this.getFlightById(flightId);
    return seatRepository.findSeatsByFlight(flightId, statusFilter);
  }
}

module.exports = new FlightService();
