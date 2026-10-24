const request = require('supertest');
const express = require('express');
const routes = require('../../src/routes');
const requestLogger = require('../../src/middleware/requestLogger');
const errorHandler = require('../../src/middleware/errorHandler');
const Flight = require('../../src/models/flight.model');
const Seat = require('../../src/models/seat.model');
const Booking = require('../../src/models/booking.model');
const {
  setupTestDB,
  teardownTestDB,
  clearTestDB,
  seedTestFlightAndSeats
} = require('../setup');

/**
 * Creates an independent Express node instance with its own NODE_ID
 */
function createNodeInstance(nodeId) {
  const nodeApp = express();
  nodeApp.use(express.json());

  // Attach node-specific identification middleware
  nodeApp.use((req, res, next) => {
    process.env.NODE_ID = nodeId;
    res.setHeader('X-Node-Id', nodeId);
    next();
  });

  nodeApp.use(requestLogger);
  nodeApp.use('/api', routes);
  nodeApp.use(errorHandler);

  return nodeApp;
}

describe('Requirement 7: Multiple Independent Backend Nodes Competing Concurrently', () => {
  let seeded;
  let nodeAApp;
  let nodeBApp;
  let nodeCApp;

  beforeAll(async () => {
    await setupTestDB();

    // Instantiate Node A, Node B, and Node C
    nodeAApp = createNodeInstance('NODE_A');
    nodeBApp = createNodeInstance('NODE_B');
    nodeCApp = createNodeInstance('NODE_C');
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    seeded = await seedTestFlightAndSeats();
  });

  it('MUST prevent double booking when Node A, Node B, and Node C concurrently attempt to book the same seat', async () => {
    const flightId = seeded.flight._id.toString();
    const seatNumber = '12A';

    console.log('[MULTI_NODE_TEST] Launching simultaneous booking requests across Node A, Node B, and Node C for PK123 / 12A...');

    // Launch requests distributed across all three independent nodes
    const requests = [
      // Batch from Node A
      request(nodeAApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-A-1' }),
      request(nodeAApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-A-2' }),
      request(nodeAApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-A-3' }),
      request(nodeAApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-A-4' }),

      // Batch from Node B
      request(nodeBApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-B-1' }),
      request(nodeBApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-B-2' }),
      request(nodeBApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-B-3' }),
      request(nodeBApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-B-4' }),

      // Batch from Node C
      request(nodeCApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-C-1' }),
      request(nodeCApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-C-2' }),
      request(nodeCApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-C-3' }),
      request(nodeCApp).post('/api/bookings').send({ flightId, seatNumber, passengerId: 'PASS-NODE-C-4' }),
    ];

    const results = await Promise.allSettled(requests);

    const successfulBookings = [];
    const conflictResponses = [];

    results.forEach((res) => {
      if (res.status === 'fulfilled') {
        if (res.value.status === 201) {
          successfulBookings.push(res.value.body.data);
        } else if (res.value.status === 409) {
          conflictResponses.push(res.value.body);
        }
      }
    });

    console.log(`[MULTI_NODE_TEST] Successes: ${successfulBookings.length}, Conflicts (409): ${conflictResponses.length}`);

    // EXACTLY 1 booking must succeed across all nodes
    expect(successfulBookings.length).toBe(1);
    expect(conflictResponses.length).toBe(requests.length - 1);

    const winningBooking = successfulBookings[0];
    console.log(`[MULTI_NODE_TEST] Winning Node: ${winningBooking.nodeId}, Booking Reference: ${winningBooking.bookingReference}`);

    // The winning booking must have come from one of the valid nodes
    expect(['NODE_A', 'NODE_B', 'NODE_C']).toContain(winningBooking.nodeId);
    expect(winningBooking.seatNumber).toBe('12A');

    // Database state verification
    const confirmedCount = await Booking.countDocuments({
      flightId: seeded.flight._id,
      seatNumber: '12A',
      status: 'CONFIRMED'
    });
    expect(confirmedCount).toBe(1);

    const seat = await Seat.findOne({ flightId: seeded.flight._id, seatNumber: '12A' });
    expect(seat.status).toBe('BOOKED');
    expect(seat.version).toBe(1);
    expect(seat.bookingId.toString()).toBe(winningBooking._id.toString());
  });
});
