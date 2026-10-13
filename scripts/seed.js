const mongoose = require('mongoose');
const env = require('../src/config/env');
const Flight = require('../src/models/flight.model');
const Seat = require('../src/models/seat.model');
const Booking = require('../src/models/booking.model');
const logger = require('../src/utils/logger');
const { FLIGHT_STATUS, SEAT_STATUS } = require('../src/config/constants');

async function seedData(customUri = null) {
  const uri = customUri || env.MONGO_URI;
  logger.info(`Starting database seed against: ${uri}`);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000
  });

  try {
    // Clear existing test/demo data
    await Booking.deleteMany({});
    await Seat.deleteMany({});
    await Flight.deleteMany({});

    logger.info('Cleaned existing collections.');

    // 1. Create Flight PK123 (The canonical test flight)
    const flightPK123 = await Flight.create({
      flightNumber: 'PK123',
      origin: 'ISB',
      destination: 'LHR',
      departureTime: new Date(Date.now() + 24 * 60 * 60 * 1000), // tomorrow
      arrivalTime: new Date(Date.now() + 32 * 60 * 60 * 1000),
      totalSeats: 6,
      availableSeats: 6,
      price: 850,
      status: FLIGHT_STATUS.SCHEDULED
    });

    // Create seats for PK123 including 12A
    const pk123Seats = ['12A', '12B', '12C', '14A', '14B', '14C'].map((seatNumber) => ({
      flightId: flightPK123._id,
      seatNumber,
      status: SEAT_STATUS.AVAILABLE,
      version: 0,
      bookingId: null
    }));

    await Seat.insertMany(pk123Seats);
    logger.info(`Seeded Flight PK123 (ID: ${flightPK123._id}) with seats: ${pk123Seats.map(s => s.seatNumber).join(', ')}`);

    // 2. Create Flight PK786
    const flightPK786 = await Flight.create({
      flightNumber: 'PK786',
      origin: 'KHI',
      destination: 'JFK',
      departureTime: new Date(Date.now() + 48 * 60 * 60 * 1000),
      arrivalTime: new Date(Date.now() + 62 * 60 * 60 * 1000),
      totalSeats: 4,
      availableSeats: 4,
      price: 950,
      status: FLIGHT_STATUS.SCHEDULED
    });

    const pk786Seats = ['1A', '1B', '2A', '2B'].map((seatNumber) => ({
      flightId: flightPK786._id,
      seatNumber,
      status: SEAT_STATUS.AVAILABLE,
      version: 0,
      bookingId: null
    }));

    await Seat.insertMany(pk786Seats);
    logger.info(`Seeded Flight PK786 (ID: ${flightPK786._id}) with seats: ${pk786Seats.map(s => s.seatNumber).join(', ')}`);

    logger.info('Database seeding completed successfully.');
    return { flightPK123, flightPK786 };
  } catch (err) {
    logger.error('Error seeding database:', { error: err.message });
    throw err;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

if (require.main === module) {
  seedData()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = seedData;
