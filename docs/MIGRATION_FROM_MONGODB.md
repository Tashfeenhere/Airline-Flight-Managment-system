# Migrating from the MongoDB prototype to Citus

This is the record of how the archived prototype under `legacy/mongodb-prototype/` was moved onto
distributed PostgreSQL. It documents the original document model, the tables that replaced it, why
the document model could not carry the guarantees the system needed, and how a live cutover would be
run.

---

## 1. The original collections and their shapes

The prototype stored three collections (see `legacy/mongodb-prototype/src/models/`).

### `flights`

| Field | Type | Notes |
|---|---|---|
| `flightNumber` | String | e.g. `PK123`, indexed |
| `origin` / `destination` | String | 3-letter IATA codes |
| `departureTime` / `arrivalTime` | Date | |
| `totalSeats` | Number | single capacity for the whole aircraft |
| `availableSeats` | Number | single remaining-count |
| `price` | Number | single fare |
| `status` | Enum | `SCHEDULED`/`ACTIVE`/`COMPLETED`/`CANCELLED` |
| `createdAt`/`updatedAt` | Date | mongoose timestamps |

Index: `{ origin, destination, departureTime }`, plus `flightNumber`.

### `seats`

| Field | Type | Notes |
|---|---|---|
| `flightId` | ObjectId | reference to a flight |
| `seatNumber` | String | e.g. `12A` |
| `status` | Enum | `AVAILABLE`/`BOOKED` |
| `version` | Number | OCC version, incremented on every transition |
| `bookingId` | ObjectId | null when available |

Indexes: unique `{ flightId, seatNumber }`, and `{ flightId, status }`. One document per physical
seat per flight.

### `bookings`

| Field | Type | Notes |
|---|---|---|
| `bookingReference` | String | unique, e.g. `BK-8B3E42A1` |
| `flightId` | ObjectId | |
| `seatNumber` | String | |
| `passengerId` | String | free-form passenger identifier |
| `nodeId` | String | originating node (`NODE_A`, …) |
| `transactionId` | String | UUID |
| `status` | Enum | `CONFIRMED`/`CANCELLED` |
| `idempotencyKey` | String | sparse-unique |
| `createdAt`/`updatedAt` | Date | |

Indexes: partial unique `{ flightId, seatNumber }` where `status = 'CONFIRMED'`; sparse unique
`{ idempotencyKey }`.

---

## 2. Why the document model was replaced

1. **No multi-document ACID the way the system needed it.** The prototype relied on a single-node
   replica set so that the seat update, the flight counter update and the booking insert could share
   one transaction. That is a single-node guarantee dressed up as a distributed one: add a second
   primary for capacity and the three writes no longer share an atomic unit. The redesign puts all
   three on one Citus shard instead, so the guarantee holds as the cluster grows.
2. **Counters that could drift.** `flight.availableSeats` was a single mutable number with no
   database-enforced relationship to the seats. Nothing prevented `availableSeats` and the set of
   `BOOKED` seats from disagreeing after a partial failure. The redesign makes the invariant a
   database constraint (`available_seats + held_seats <= total_seats`) and derives seat state instead
   of storing it.
3. **No global uniqueness.** MongoDB's unique indexes were per-shard concerns and the `idempotencyKey`
   index was sparse and single-collection. The redesign splits this deliberately: a per-flight
   partial unique index in the database (the concurrency backstop) plus a Redis `SET NX` record for
   cross-flight idempotency.
4. **One row per seat does not scale.** One seat document per flight is ~10 billion documents at 50M
   flights. The redesign stores a seat *template* per aircraft type and only materializes a physical
   seat when it is actually held.

---

## 3. Collection → table mapping

| MongoDB collection | Citus table(s) | Transformation |
|---|---|---|
| `flights` | `flights` | schedule/route/fare facts; ObjectId → uuid; single price → `base_price` |
| `flights` | `flight_inventory` | `totalSeats`/`availableSeats` → per-`(flight, cabin)` counters |
| `flights` (denormalized origin/destination/airline) | `airlines`, `airports`, `aircraft_types`, `cabins` | normalized reference tables |
| `seats` | `seat_map_templates` (+ derived) | one template per aircraft type, not per flight |
| `seats` (a held seat) | `bookings.seat_number` | the live hold *is* the seat's existence |
| `bookings` | `bookings` | one row per booking; ObjectId → uuid; status set widened |
| `bookings` (payment implied) | `payments` | explicit saga state machine |
| `bookings` (change events) | `booking_outbox` | transactional outbox for projection |

---

## 4. Field-by-field mapping and type changes

### `flights` → `flights` + reference tables

| Prototype field | New location | New type / notes |
|---|---|---|
| `_id` (ObjectId) | `flights.flight_id` | **uuid** (UUIDv7); ObjectId is not a valid uuid |
| `flightNumber` | `flights.flight_number` | `text` |
| — (was a plain string) | `flights.airline_code` | `text`, references the `airlines` dimension |
| `origin` / `destination` | same names | `text`; the `airports` table carries name/city/tz |
| `departureTime` | `flights.departure_time` | `timestamptz` |
| `arrivalTime` | `flights.arrival_time` | `timestamptz` (CHECK: arrival > departure) |
| — | `flights.departure_date` | `date`, **derived** from `departure_time` (CHECK-enforced) and the partition key |
| — | `flights.aircraft_type` | `text`, references `aircraft_types` |
| `price` | `flights.base_price` | `numeric(10,2)` (Mongo Number → exact decimal) |
| — | `flights.currency` | `text`, default `USD` |
| `status` | `flights.status` | same enum, plus `DEPARTED`; CHECK-constrained |
| `totalSeats` | `flight_inventory.total_seats` | `integer`, **per cabin** |
| `availableSeats` | `flight_inventory.available_seats` | `integer`, **per cabin** |
| — | `flight_inventory.held_seats` | `integer`, new — seats held by `PENDING` bookings |
| — | `flight_inventory.version` | `bigint` OCC counter |

### `seats` → `seat_map_templates` + `bookings.seat_number`

| Prototype field | New location | Notes |
|---|---|---|
| `flightId` | `seat_map_templates.aircraft_type` | seats are keyed by aircraft type, not flight |
| `seatNumber` | `seat_map_templates.seat_number` | `text` |
| `status` | — (derived) | a seat is `BOOKED` iff a live booking holds it; nothing stores it |
| `version` | — (removed) | the counter's `version` / the `uq_live_seat` index replace OCC on seats |
| `bookingId` | `bookings.booking_id` | the hold is a booking row with `seat_number` set |

### `bookings` → `bookings` + `payments`

| Prototype field | New location | New type / notes |
|---|---|---|
| `_id` (ObjectId) | `bookings.booking_id` | **uuid** |
| `bookingReference` | `bookings.booking_reference` | `text`; same `BK-XXXXXXXX` shape |
| `flightId` | `bookings.flight_id` | **uuid** (was ObjectId) + `departure_date` |
| `seatNumber` | `bookings.seat_number` | `text`, nullable (null in `lazy` mode) |
| `passengerId` | `bookings.user_id` + `passenger_name`/`passenger_ref` | free-form string → user uuid + denormalized name |
| `nodeId` | `bookings.node_id` | `text` (the `x-node-id` value) |
| `transactionId` | `bookings.transaction_id` | `text` → **uuid** |
| `status` | `bookings.status` | `CONFIRMED`/`CANCELLED` → `PENDING`/`CONFIRMED`/`CANCELLED`/`EXPIRED` |
| `idempotencyKey` | `bookings.idempotency_key` | `text`, now per-flight partial unique + Redis |
| `createdAt`/`updatedAt` | `created_at`/`updated_at` | `timestamptz` |
| — (new) | `bookings.inventory_shard` | which counter row this booking decremented |
| — (new) | `bookings.hold_expires_at` | required for `PENDING` (CHECK-enforced) |
| — (new) | `bookings.price`, `currency`, `payment_id` | fare captured at booking time; payment link |
| — (new) | `payments.saga_state` etc. | explicit saga state machine |

Type-change summary: **ObjectId → uuid**, **single aircraft counters → per-cabin counters**,
**stored seat status → derived**, **one booking status pair → a four-state lifecycle**, and
**mongoose `Number` money → `numeric(10,2)`**.

---

## 5. What was kept identical

The redesign deliberately did **not** change the HTTP contract, so any client of the prototype keeps
working:

- **Envelopes.** Success responses keep `{ success: true, isIdempotentReplay, data }` (and `count`
  on list responses). Errors keep `{ success: false, error: { code, message }, nodeId, timestamp }`.
- **Routes.** `GET /`, `GET /api/health`, `GET /api/flights`, `GET /api/flights/:flightId`,
  `GET /api/flights/:flightId/seats`, `POST /api/bookings`, `GET /api/bookings/:bookingId`,
  `POST /api/bookings/:bookingId/cancel`, and the `DELETE /api/bookings/:bookingId` alias.
- **Headers.** `x-node-id`, `idempotency-key` / `x-idempotency-key`, `x-request-start`.
- **Status codes.** `200` (idempotent replay), `201` (created), `400`, `404`, `409` (conflict:
  sold out / seat unavailable / version conflict / duplicate), `503` (transient / DB unavailable).
- **Idempotent replay semantics.** Supplying the same `Idempotency-Key` returns the original booking
  with `isIdempotentReplay: true` and HTTP `200`.
- **`bookingReference` format.** Still `BK-` + 10 Crockford base32 characters.

`passengerId` in the request body is still accepted for guest attribution while
`REQUIRE_AUTH_FOR_BOOKING=false`, mapping onto `bookings.user_id` (the well-known guest identity) so
the original request shape is not broken.

---

## 6. Operational cutover sequence

The general shape is **expand → backfill → dual-write → flip reads → flip writes → contract**. A
sketch for a live migration (the exact tooling is yours to build; this is the order and the
invariants to hold):

1. **Stand up the target.** Bring up the Citus cluster, register workers, `db:migrate`, and load
   reference tables + `users`. Verify with `db:status` that the booking tables share a colocation
   group.
2. **Backfill `flights` and `flight_inventory`.** Walk the MongoDB `flights` collection in
   `departure_date` order (this is the bulk-load path — see
   [DATA_LOADING.md](DATA_LOADING.md)). For each flight, derive `departure_date`, resolve
   `airline_code`/`aircraft_type`, insert the flight, and create one `flight_inventory` row per cabin
   whose `total_seats` equals the seats you intend to sell and `available_seats = total_seats`.
   **Pre-create the month partitions first** or the load fails.
3. **Backfill historical bookings read-only.** Insert existing bookings with their original status.
   `CONFIRMED` → `CONFIRMED`; `CANCELLED` → `CANCELLED`. They are historical and should not decrement
   the live counter (the counter was seeded from current availability, not from history).
4. **Dual-write.** Point the application at both stores: every new booking writes MongoDB (as before)
   and the Citus tables, in the same request, best-effort for Mongo and authoritative for Citus. Log
   any divergence. Keep this window short.
5. **Verify.** Run `npm run audit:oversell` on Citus and compare counts of live bookings against
   MongoDB. Reconcile any mismatch before proceeding — the whole point of step 6 is that Citus is
   now the source of truth.
6. **Flip reads.** Move `GET /api/flights` and the seat map to the read model / write model. The HTTP
   contract is unchanged, so clients cannot tell.
7. **Flip writes.** Make Citus authoritative for `POST /api/bookings` and cancellation; drop the
   MongoDB write from the request path.
8. **Contract.** After a soak period with no divergence, stop dual-writing and archive the MongoDB
   deployment.

A minimal dual-write/backfill sketch (pseudo-code, to be adapted):

```js
// backfill one flight, in departure_date order
for (const flight of mongoFlightsByDepartureDate()) {
  await withTransaction(async (client) => {
    const flightRow = await flightRepo.upsert(client, {
      flightId:          uuidv7(),                 // or a deterministic mapping from the ObjectId
      flightNumber:      flight.flightNumber,
      airlineCode:       flight.airlineCode,
      origin:            flight.origin,
      destination:       flight.destination,
      departureDate:     toUtcDate(flight.departureTime),
      departureTime:     flight.departureTime,
      arrivalTime:       flight.arrivalTime,
      aircraftType:      flight.aircraftType,
      basePrice:         flight.price,
    });
    for (const cabin of cabinsFor(flight.aircraftType)) {
      await inventoryRepo.ensureCounter(client, {
        flightId:      flightRow.flight_id,
        departureDate: flightRow.departure_date,
        cabin,
        totalSeats:    capacityOf(flight.aircraftType, cabin),
        availableSeats: capacityOf(flight.aircraftType, cabin), // starts equal to capacity
      });
    }
  });
}
```

Keep the ObjectId→uuid mapping deterministic if anything downstream references the old ids; UUIDv7
derived from the ObjectId's timestamp preserves rough ordering and makes the mapping reproducible.
