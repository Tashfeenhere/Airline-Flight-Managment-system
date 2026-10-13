# Distributed Airline Seat Inventory System (Backend Prototype)

A distributed, transactionally consistent backend foundation for airline seat inventory management built with **Node.js**, **Express**, and **MongoDB Multi-Document Transactions**.

This system is engineered specifically to demonstrate and solve the fundamental distributed concurrency problem: **preventing double-booking when multiple independent airport/booking-office nodes attempt to book the same flight seat simultaneously**.

---

## 1. The Core Distributed Problem & Invariant

### The Scenario
Suppose Flight **PK123** has Seat **12A**.
Two or more independent airport nodes (e.g., **Node A** at Islamabad Airport and **Node B** at Lahore Airport) simultaneously read the seat:
```
seat: "12A"
status: "AVAILABLE"
version: 41
```
Both nodes attempt to book the seat for different passengers at the exact same millisecond.

### The Invariant
$$\text{Flight } F + \text{Seat } S \implies \le 1 \text{ Confirmed Booking}$$

Only **one** request must successfully transition the seat:
```
status: "AVAILABLE"  -->  "BOOKED"
version: 41          -->  42
```
The second request detects a version/concurrency conflict, aborts cleanly, and does **not** create a second confirmed booking.

### Why Application Locks Do Not Work
In a distributed setup with multiple independent server instances (running on separate processes, ports, or containers), local in-memory locks (such as JavaScript `Mutex`, `async-lock`, or global variables) **cannot** protect across separate processes. The database must be the **sole authoritative source of truth**.

---

## 2. Distributed Architecture

```
                      +-----------------------------+
                      |           Clients           |
                      +-----------------------------+
                                     |
             +-----------------------+-----------------------+
             |                       |                       |
             v                       v                       v
      +--------------+        +--------------+        +--------------+
      |    Node A    |        |    Node B    |        |    Node C    |
      | (Port 3001)  |        | (Port 3002)  |        | (Port 3003)  |
      | NODE_ID=NODE_A|       | NODE_ID=NODE_B|       | NODE_ID=NODE_C|
      +--------------+        +--------------+        +--------------+
             |                       |                       |
             +-----------------------+-----------------------+
                                     |
                                     v
                 +---------------------------------------+
                 |           MongoDB Cluster             |
                 |     Replica Set 'rs0' (Authoritative) |
                 +---------------------------------------+
                 | Collections:                          |
                 |  - flights                            |
                 |  - seats (with OCC version)           |
                 |  - bookings (with unique constraints) |
                 +---------------------------------------+
```

---

## 3. Concurrency Control & Transaction Flow

### Step-by-Step Booking Flow (`POST /api/bookings`)
1. **Validation & Context**:
   - Validates `flightId`, `seatNumber`, `passengerId`.
   - Generates a UUID `transactionId`.
   - Captures `nodeId` from the environment (`process.env.NODE_ID`).
2. **Idempotency Check**:
   - If `idempotencyKey` is provided and already exists, immediately returns the confirmed booking (`200 OK`) without re-executing.
3. **MongoDB Transaction Start**:
   - Starts a multi-document session with `readConcern: 'local'` and `writeConcern: 'majority'`.
4. **Read Seat & Capture Version**:
   - Reads the seat within the session.
   - Verifies `status === 'AVAILABLE'`.
   - Captures `currentVersion = seat.version`.
5. **Atomic Version-Checked Update**:
   ```javascript
   Seat.updateOne(
     { flightId, seatNumber, version: currentVersion, status: 'AVAILABLE' },
     { $set: { status: 'BOOKED', bookingId: tentativeBookingId }, $inc: { version: 1 } },
     { session }
   );
   ```
   If `matchedCount === 0`, another node committed first. The transaction is aborted immediately with a `VERSION_CONFLICT` / `SEAT_UNAVAILABLE` error.
6. **Flight Inventory Update**:
   - Atomically decrements `availableSeats` on the flight:
     `Flight.updateOne({ _id: flightId, availableSeats: { $gt: 0 } }, { $inc: { availableSeats: -1 } }, { session })`
7. **Create Booking Record**:
   - Inserts the `Booking` document with `status: 'CONFIRMED'`, `nodeId`, `transactionId`, and `bookingReference`.
8. **Commit Transaction**:
   - Commits the transaction atomically. All three document updates (Seat, Flight, Booking) persist together.
9. **Hard Safety Net (Partial Unique Index)**:
   - A database-level partial unique index on `bookings`:
     `{ flightId: 1, seatNumber: 1 }` where `{ status: 'CONFIRMED' }`
     mathematically forbids MongoDB from storing two confirmed bookings for the same flight and seat.

### Cancellation Flow (`POST /api/bookings/:bookingId/cancel`)
1. Starts a MongoDB transaction.
2. Locates the booking; validates `status === 'CONFIRMED'`.
3. Sets booking `status -> 'CANCELLED'`.
4. Releases seat: `status -> 'AVAILABLE'`, `bookingId -> null`, `version -> version + 1`.
5. Restores flight inventory: `$inc: { availableSeats: 1 }`.
6. Commits transaction.

---

## 4. Database Models & Schema

### `Flight`
| Field | Type | Description |
|---|---|---|
| `flightNumber` | String | e.g., "PK123" (indexed) |
| `origin` | String | 3-letter IATA code (e.g. "ISB") |
| `destination` | String | 3-letter IATA code (e.g. "LHR") |
| `departureTime` | Date | Scheduled departure |
| `arrivalTime` | Date | Scheduled arrival |
| `totalSeats` | Number | Total aircraft seat capacity |
| `availableSeats`| Number | Currently unbooked seats |
| `price` | Number | Fare price |
| `status` | Enum | `SCHEDULED`, `ACTIVE`, `COMPLETED`, `CANCELLED` |

### `Seat`
| Field | Type | Description |
|---|---|---|
| `flightId` | ObjectId | Reference to Flight (indexed) |
| `seatNumber` | String | e.g., "12A" |
| `status` | Enum | `AVAILABLE`, `BOOKED` (indexed) |
| `version` | Number | Monotonically increasing OCC version |
| `bookingId` | ObjectId | Reference to Booking (null if available) |
| *Index* | Compound Unique | `{ flightId: 1, seatNumber: 1 }` |

### `Booking`
| Field | Type | Description |
|---|---|---|
| `bookingReference` | String | Unique code (e.g. `BK-8B3E42A1`) |
| `flightId` | ObjectId | Reference to Flight |
| `seatNumber` | String | e.g., "12A" |
| `passengerId` | String | Passenger identifier |
| `nodeId` | String | Node that created booking (`NODE_A`, etc.) |
| `transactionId` | String | UUID of transaction |
| `status` | Enum | `CONFIRMED`, `CANCELLED` |
| `idempotencyKey` | String | Sparse unique key for idempotent retries |
| *Index* | Partial Unique | `{ flightId: 1, seatNumber: 1 }` (status: `CONFIRMED`) |

---

## 5. Interactive Swagger / OpenAPI Documentation

The system includes built-in OpenAPI 3.0.3 specification and Swagger UI for interactive exploration and end-to-end API testing.

- **Swagger UI Interactive Explorer**: [`http://localhost:3000/api-docs`](http://localhost:3000/api-docs) (or ports `3001`, `3002`, `3003`)
- **Raw OpenAPI 3.0 JSON Specification**: [`http://localhost:3000/api-docs.json`](http://localhost:3000/api-docs.json)

### Testing the Backend Directly from Swagger UI
1. Start the server (e.g. `npm start` or Docker cluster `docker compose up`).
2. Open `http://localhost:3000/api-docs` in your browser.
3. Use the **Try it out** button to execute queries against `GET /api/flights`, inspect seats via `GET /api/flights/{flightId}/seats`, reserve seats via `POST /api/bookings` (with idempotency tokens and cluster node headers), and cancel reservations.

---

## 6. API Reference

### Root Node Status
```http
GET /
```
Returns instance status and links to `/api-docs` and `/api/health`.

### Health Check
```http
GET /api/health
```
**Response (200 OK):**
```json
{
  "status": "UP",
  "nodeId": "NODE_A",
  "port": 3001,
  "database": "CONNECTED",
  "timestamp": "2026-09-27T19:30:00.000Z",
  "uptime": 12.34
}
```

### Search Flights
```http
GET /api/flights?origin=ISB&destination=LHR&hasAvailableSeats=true
```
**Filters supported**: `flightNumber`, `origin`, `destination`, `maxPrice`, `hasAvailableSeats`, `minAvailableSeats`, `status`.

### Get Flight Seat Map
```http
GET /api/flights/:flightId/seats
```

### Create Booking (Atomic & Version-Checked)
```http
POST /api/bookings
Content-Type: application/json
Idempotency-Key: OPTIONAL-UUID-OR-STRING

{
  "flightId": "65b928f7e939850a32a53e27",
  "seatNumber": "12A",
  "passengerId": "PASS-9001",
  "idempotencyKey": "OPTIONAL-UNIQUE-KEY"
}
```
**Success Response (201 Created):**
```json
{
  "success": true,
  "isIdempotentReplay": false,
  "data": {
    "_id": "65b928f7e939850a32a53e29",
    "bookingReference": "BK-E4F18A32",
    "flightId": "65b928f7e939850a32a53e27",
    "seatNumber": "12A",
    "passengerId": "PASS-9001",
    "nodeId": "NODE_A",
    "transactionId": "d70f074a-4a25-4c01-a185-5a1e2fc64c8d",
    "status": "CONFIRMED",
    "createdAt": "2026-09-27T19:30:05.123Z"
  }
}
```

**Conflict Response (409 Conflict):**
```json
{
  "success": false,
  "error": {
    "code": "SEAT_UNAVAILABLE",
    "message": "Seat 12A is already booked (status: BOOKED)"
  },
  "nodeId": "NODE_B",
  "timestamp": "2026-09-27T19:30:05.145Z"
}
```

### Cancel Booking
```http
POST /api/bookings/:bookingId/cancel
# or RESTful DELETE:
DELETE /api/bookings/:bookingId
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Booking cancelled successfully and seat released",
  "data": {
    "bookingReference": "BK-E4F18A32",
    "status": "CANCELLED"
  }
}
```

---

## 7. Running with Docker Compose (Multi-Node Cluster)

The Docker Compose configuration starts:
1. **`airline_mongo`**: MongoDB 7.0 configured as single-node replica set `rs0` (required for multi-document transactions).
2. **`airline_mongo_init`**: Automated replica set initiation and database seeder (populates Flight `PK123` with Seat `12A`).
3. **`airline_node_a`**: Node A listening on port `3001` (`NODE_ID=NODE_A`).
4. **`airline_node_b`**: Node B listening on port `3002` (`NODE_ID=NODE_B`).
5. **`airline_node_c`**: Node C listening on port `3003` (`NODE_ID=NODE_C`).

### Start the Cluster
```bash
docker compose up --build
```

### Verify Node Health
```bash
curl http://localhost:3001/api/health   # Node A
curl http://localhost:3002/api/health   # Node B
curl http://localhost:3003/api/health   # Node C
```

---

## 8. Running Locally (Without Docker)

### Prerequisites
- Node.js >= 18
- MongoDB replica set running locally (e.g. `mongod --replSet rs0`)

### Installation & Seeding
```bash
npm install
npm run seed
```

### Starting the Independent Backend Nodes
Open three separate terminals:
```bash
# Terminal 1: Node A
npm run start:node-a

# Terminal 2: Node B
npm run start:node-b

# Terminal 3: Node C
npm run start:node-c
```

---

## 9. Automated Testing

The automated test suite uses an in-memory MongoDB replica set (`mongodb-memory-server`), making all tests **100% hermetic, self-contained, and runnable without any external MongoDB or Docker daemon**.

### Run All Tests
```bash
npm test
```

### Covered Test Cases
1. **Swagger / OpenAPI Documentation & Standards Integration**:
   - Verifies Swagger UI rendering at `/api-docs` and valid OpenAPI 3.0 specification at `/api-docs.json`.
   - Tests request validation for query parameters, path variables (e.g. MongoDB ObjectIds), and request bodies.
   - Tests meaningful HTTP status codes (200, 201, 400, 404, 409, 503) and structured error envelopes.
   - Tests RESTful `DELETE /api/bookings/:bookingId` cancellation alias.
2. **Normal Successful Booking**:
   - Checks seat transition `AVAILABLE -> BOOKED`, OCC version `0 -> 1`, flight `availableSeats` decrement.
3. **Booking an Already-Booked Seat**:
   - Subsequent booking attempts for the same seat return `409 Conflict (SEAT_UNAVAILABLE)`.
4. **Booking Cancellation**:
   - Restores seat to `AVAILABLE`, increments flight `availableSeats`, transitions booking to `CANCELLED`.
5. **Transaction Rollback**:
   - Injects simulated database IO failures during booking insert; verifies complete rollback with seat remaining `AVAILABLE` and availableSeats unchanged.
6. **Idempotency**:
   - Submitting the same `idempotencyKey` returns the original confirmed booking without creating duplicate records.
7. **Critical Concurrency Test (50-100 Concurrent Requests)**:
   - Races 100 simultaneous booking requests for Flight `PK123`, Seat `12A`.
   - Asserts:
     - **Confirmed bookings in DB = EXACTLY 1**.
     - Exactly 1 request returns `201 Created`.
     - Exactly 99 requests return `409 Conflict`.
     - Seat status is `BOOKED` with `version = 1`.
8. **Multi-Node Concurrency Simulation**:
   - Races concurrent requests across `NODE_A`, `NODE_B`, and `NODE_C` simultaneously.
   - Verifies cross-node distributed invariant enforcement.

---

## 10. Live Concurrency Stress Test Script

You can run the live stress test script against running cluster nodes:
```bash
npm run stress
```
This utility:
1. Discovers reachable nodes (`http://localhost:3001`, `3002`, `3003`).
2. Fetches Flight `PK123` details.
3. Dispatches 100 simultaneous booking requests distributed across all active nodes for Seat `12A`.
4. Verifies that **EXACTLY 1** booking was confirmed and all other 99 attempts failed safely.

