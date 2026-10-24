/**
 * Live Stress Test Script: Distributed Airline Seat Inventory System
 * Fires 100 concurrent requests across Node A (3001), Node B (3002), and Node C (3003)
 * for Flight PK123, Seat 12A.
 */
const http = require('http');

const NODES = [
  process.env.NODE_A_URL || 'http://localhost:3001',
  process.env.NODE_B_URL || 'http://localhost:3002',
  process.env.NODE_C_URL || 'http://localhost:3003'
];

const TARGET_FLIGHT = process.env.FLIGHT_NUMBER || 'PK123';
const TARGET_SEAT = process.env.SEAT_NUMBER || '12A';
const TOTAL_REQUESTS = parseInt(process.env.CONCURRENT_REQUESTS || '100', 10);

function sendRequest(nodeUrl, method, path, body = null) {
  return new Promise((resolve) => {
    const url = new URL(path, nodeUrl);
    const postData = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      },
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          parsed = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsed,
          nodeUrl
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 0,
        error: err.message,
        nodeUrl
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        statusCode: 408,
        error: 'Request Timeout',
        nodeUrl
      });
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runStressTest() {
  console.log('================================================================');
  console.log(' DISTRIBUTED AIRLINE SEAT INVENTORY SYSTEM - LIVE CONCURRENCY TEST');
  console.log('================================================================');
  console.log(`Target Flight: ${TARGET_FLIGHT}`);
  console.log(`Target Seat:   ${TARGET_SEAT}`);
  console.log(`Total Requests: ${TOTAL_REQUESTS}`);
  console.log(`Target Nodes:  ${NODES.join(', ')}\n`);

  // 1. Discover reachable nodes
  const activeNodes = [];
  for (const nodeUrl of NODES) {
    const health = await sendRequest(nodeUrl, 'GET', '/api/health');
    if (health.statusCode === 200) {
      activeNodes.push(nodeUrl);
      console.log(` [✓] Node active at ${nodeUrl} (Node ID: ${health.data.nodeId || 'UNKNOWN'})`);
    } else {
      console.log(` [✗] Node unreachable at ${nodeUrl} (${health.error || `HTTP ${health.statusCode}`})`);
    }
  }

  if (activeNodes.length === 0) {
    console.error('\nERROR: No active backend nodes reachable! Please start at least one node.');
    console.error('Run "npm run start:node-a" or "docker compose up" first.');
    process.exit(1);
  }

  console.log(`\nDiscovered ${activeNodes.length} active node(s). Resolving flight details...`);

  // 2. Fetch Flight details
  const flightsRes = await sendRequest(activeNodes[0], 'GET', `/api/flights?flightNumber=${TARGET_FLIGHT}`);
  if (flightsRes.statusCode !== 200 || !flightsRes.data?.data?.length) {
    console.error(`\nERROR: Could not find Flight ${TARGET_FLIGHT}. Did you run "npm run seed"?`);
    process.exit(1);
  }

  const flight = flightsRes.data.data[0];
  const flightId = flight._id || flight.id;
  console.log(`Found Flight ${TARGET_FLIGHT} (ID: ${flightId}, Available Seats: ${flight.availableSeats})`);

  console.log(`\n>>> FIRING ${TOTAL_REQUESTS} CONCURRENT BOOKING REQUESTS NOW <<<\n`);
  const startTime = Date.now();

  const requests = Array.from({ length: TOTAL_REQUESTS }, (_, idx) => {
    // Round-robin distribution across active nodes
    const targetNode = activeNodes[idx % activeNodes.length];
    const passengerId = `PASS-STRESS-${String(idx + 1).padStart(3, '0')}`;

    return sendRequest(targetNode, 'POST', '/api/bookings', {
      flightId,
      seatNumber: TARGET_SEAT,
      passengerId
    });
  });

  const responses = await Promise.all(requests);
  const totalDuration = Date.now() - startTime;

  let successCount = 0;
  let conflictCount = 0;
  let errorCount = 0;
  let winningBooking = null;

  responses.forEach((res) => {
    if (res.statusCode === 201) {
      successCount++;
      winningBooking = res.data?.data;
    } else if (res.statusCode === 409) {
      conflictCount++;
    } else {
      errorCount++;
    }
  });

  console.log('================================================================');
  console.log('                       STRESS TEST SUMMARY                      ');
  console.log('================================================================');
  console.log(`Total Time Elapsed:   ${totalDuration} ms`);
  console.log(`Successful (201):     ${successCount}`);
  console.log(`Conflicts (409):      ${conflictCount}`);
  console.log(`Errors / Other:       ${errorCount}`);
  console.log('----------------------------------------------------------------');

  if (winningBooking) {
    console.log('WINNING BOOKING DETAILS:');
    console.log(`  Booking Reference:  ${winningBooking.bookingReference}`);
    console.log(`  Processed by Node:  ${winningBooking.nodeId}`);
    console.log(`  Transaction ID:     ${winningBooking.transactionId}`);
    console.log(`  Passenger ID:       ${winningBooking.passengerId}`);
    console.log(`  Status:             ${winningBooking.status}`);
  }

  console.log('----------------------------------------------------------------');
  if (successCount === 1 && conflictCount === TOTAL_REQUESTS - 1 && errorCount === 0) {
    console.log('>>> TEST PASSED: EXACTLY ONE CONFIRMED BOOKING WAS CREATED! <<<');
    console.log('>>> ZERO DOUBLE-BOOKINGS OCCURRED UNDER DISTRIBUTED LOAD!   <<<');
    process.exit(0);
  } else {
    console.error('>>> TEST FAILED: INVARIANT VIOLATION DETECTED! <<<');
    process.exit(1);
  }
}

if (require.main === module) {
  runStressTest();
}

module.exports = runStressTest;
