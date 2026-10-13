const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const Flight = require('../src/models/flight.model');
const Seat = require('../src/models/seat.model');
const Booking = require('../src/models/booking.model');

let replSet;

async function setupTestDB() {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });

  const uri = replSet.getUri();
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000
  });

  // Ensure indexes are built
  await Promise.all([
    Flight.init(),
    Seat.init(),
    Booking.init()
  ]);

  return uri;
}

async function teardownTestDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (replSet) {
    await replSet.stop();
  }
}

async function clearTestDB() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

async function seedTestFlightAndSeats({
  flightNumber = 'PK123',
  origin = 'ISB',
  destination = 'LHR',
  totalSeats = 6,
  availableSeats = 6,
  price = 850,
  seats = ['12A', '12B', '12C', '14A', '14B', '14C']
} = {}) {
  const flight = await Flight.create({
    flightNumber,
    origin,
    destination,
    departureTime: new Date(Date.now() + 24 * 3600 * 1000),
    arrivalTime: new Date(Date.now() + 32 * 3600 * 1000),
    totalSeats,
    availableSeats,
    price,
    status: 'SCHEDULED'
  });

  const seatDocs = seats.map((seatNumber) => ({
    flightId: flight._id,
    seatNumber,
    status: 'AVAILABLE',
    version: 0,
    bookingId: null
  }));

  const createdSeats = await Seat.insertMany(seatDocs);

  return { flight, seats: createdSeats };
}

module.exports = {
  setupTestDB,
  teardownTestDB,
  clearTestDB,
  seedTestFlightAndSeats
};
