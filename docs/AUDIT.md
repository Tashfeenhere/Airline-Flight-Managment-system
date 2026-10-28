# Codebase Audit: Suspected Defects & Architectural Fact-Checking

**Repository:** `MuTashfeen/Airline-Flight-Managment-system` (Distributed Airline Inventory Platform)  
**Evaluator:** Principal Backend Engineer, SRE & Security Lead  
**Audit Date:** 2026-10-24  

---

## 1. Verified Infrastructure & Architecture Facts

| Claim / Component | Actual State in Codebase | Verdict | Notes & Line References |
| :--- | :--- | :---: | :--- |
| **Elasticsearch Client** | `package.json` contains no `@elastic/elasticsearch` or `@opensearch-project/opensearch`. | **CONFIRMED** | Search is solely PostgreSQL CQRS (`db/migrations/006-read-model.js:23`). |
| **Elasticsearch Service** | `docker-compose.yml` has no Elasticsearch or OpenSearch container definition. | **CONFIRMED** | `docker-compose.yml` only runs Citus coordinator, 2 workers, readmodel PG, redis, pgbouncer, api. |
| **Nodemailer Usage** | Present in `package.json:68`. Configured in `src/services/mailerService.js:23`. | **CONFIRMED** | Uses Gmail SMTP or console logging in dev; no mail catcher (Mailpit) in compose. |
| **Docker Compose High Availability** | Compose runs exactly 1 coordinator, 2 workers, 1 readmodel, 1 redis, 1 pgbouncer, 1 api. | **CONFIRMED** | `docker-compose.yml:50-200`. Zero standby nodes, zero Patroni/failover automation. |
| **Frontend Stack** | `frontend/` directory exists with Vite + React 19 + Zustand + Recharts (`frontend/package.json:12`). | **CONFIRMED** | Contains functional auth, admin dashboards, passenger search, but no SSE/WebSocket live feed. |

---

## 2. Item-by-Item Defect Verification (Section 3)

### A. Booking Transaction
* **Item 1: Inline saga holds inventory row lock during network call**
  - **Verdict:** **REFUTED**
  - **Evidence:** [`src/services/bookingService.js:18-21`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/services/bookingService.js#L18-L21) and lines [464-519](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/services/bookingService.js#L464-L519). The database transaction commits the reservation and PENDING booking first. Authorize ([lines 633-640](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/services/bookingService.js#L633-L640)) and Capture ([lines 682-686](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/services/bookingService.js#L682-L686)) execute strictly *outside* the DB transaction. Confirmation runs in a second distinct transaction ([lines 706-746](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/services/bookingService.js#L706-L746)).

* **Item 2: Booking path never reads `flights`**
  - **Verdict:** **REFUTED**
  - **Evidence:** [`src/services/bookingService.js:236-252`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/services/bookingService.js#L236-L252). `loadBookingContext` explicitly queries `flightRepository.findAnyById` and checks `flight.status === 'CANCELLED'` and `new Date(flight.departureTime).getTime() <= Date.now()`.

* **Item 3: `executeWithRetry` on drop during COMMIT**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`src/concurrency/transactionRetry.js:77-80`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/concurrency/transactionRetry.js#L77-L80). Network error regex matches `/Connection terminated|server closed the connection/i`. If the socket drops right as `COMMIT` is processed by the server, the client cannot distinguish if the commit succeeded or failed, replaying `runCreateSaga` and potentially creating a duplicate booking if no idempotency key was supplied.

* **Item 4: One `seat_number` per booking row (group bookings impossible)**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`db/migrations/004-bookings-payments-outbox.js:43`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/db/migrations/004-bookings-payments-outbox.js#L43). The table `bookings` has a scalar `seat_number text`, `passenger_name text`. Multi-passenger bookings require repeated individual bookings with separate references.

* **Item 5: Cancel of CONFIRMED booking idempotency**
  - **Verdict:** **PARTIAL**
  - **Evidence:** [`src/repositories/bookingRepository.js:222-238`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/repositories/bookingRepository.js#L222-L238). `claimForCancel` returns `wasConfirmed` based on `confirmed_at IS NOT NULL`. A second cancel call on an already-cancelled booking returns null (`allowedFrom` requires `PENDING` or `CONFIRMED`), raising a 409 conflict rather than returning the existing cancellation payload idempotently.

---

### B. Sharding and Lookups
* **Item 6: `GET/cancel /api/bookings/:bookingId` and `GET /api/flights/:flightId` fan out to all shards/partitions**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`src/repositories/bookingRepository.js:95-101`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/repositories/bookingRepository.js#L95-L101). `findAnyById` runs `SELECT ... FROM bookings WHERE booking_id = $1 LIMIT 1`. Because `bookings` is distributed by `flight_id` and partitioned by `departure_date`, querying by `booking_id` alone causes Citus to scatter the query across all 32 shards and all monthly partitions.

* **Item 7: Shard & partition explosion**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** 32 Citus shards × monthly range partitions × 5 partitioned tables = hundreds to thousands of shard placement tables in pg_catalog.

* **Item 8: `users` is a Citus reference table**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`db/migrations/008-citus-reference-tables.js:21`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/db/migrations/008-citus-reference-tables.js#L21). `users` is distributed via `citus.makeReference(client, 'users')`. Every registration and `last_login_at` update executes a 2-phase commit across all Citus workers, and bcrypt/argon2 hashes are broadcast to all worker nodes.

* **Item 9: `departure_date` local timezone mismatch**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`db/migrations/001-extensions-and-helpers.js:108-112`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/db/migrations/001-extensions-and-helpers.js#L108-L112) and `ck_flights_departure_date`. `departure_date` is enforced strictly as UTC date (`(departure_time AT TIME ZONE 'UTC')::date`). A flight departing at 02:00 AM in Tokyo (JST, UTC+9) has a local departure date of Day $X$, but its UTC `departure_date` is Day $X-1$, leading to search misses when users search by local departure date.

---

### C. Data Lifecycle
* **Item 10: `partitions:maintain` drops partitions without row protection on `--force`**
  - **Verdict:** **PARTIAL**
  - **Evidence:** [`src/db/partitions.js:268-281`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/db/partitions.js#L268-L281). If `--force` is passed or if a retention script runs with default retention window, partitions holding rows are dropped or detached. There is no cryptographic checksum archive verification before destruction.

* **Item 11: Missing Foreign Keys on reference tables and co-located tables**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`db/migrations/004-bookings-payments-outbox.js:31-69`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/db/migrations/004-bookings-payments-outbox.js#L31-L69). `bookings` has no foreign key constraint to `flights` (`flight_id`, `departure_date`) or `users` (`user_id`).

---

### D. Loader
* **Item 12: Skeleton loader uses time-random UUIDs**
  - **Verdict:** **REFUTED**
  - **Evidence:** [`loaders/load_flights.py:247`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/loaders/load_flights.py#L247). `load_flights.py` generates deterministic UUIDs using `uuid.uuid5(NAMESPACE, f"synthetic:{region}:{day_iso}:{j}")`.

* **Item 13 & 14: Flights and inventory commit separately**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`loaders/load_flights.py:324-340`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/loaders/load_flights.py#L324-L340). `flush_flights` commits in its own `with self.conn.transaction():`, followed separately by `flush_inventory` in its own transaction. A crash between the two leaves orphaned flight records with missing inventory counters.

* **Item 15: Loading through coordinator temporary stage**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`loaders/load_flights.py:325-327`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/loaders/load_flights.py#L325-L327). `COPY` loads into session-local temp tables `FLIGHT_STAGE`, then runs `INSERT INTO flights SELECT ... FROM flights_stage`, pulling data through the coordinator query planner.

---

### E. Idempotency, Outbox, Reaper, Read Model
* **Item 16: Idempotency database backstop vs Redis**
  - **Verdict:** **PARTIAL**
  - **Evidence:** [`src/services/idempotencyService.js:68-120`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/services/idempotencyService.js#L68-L120). Redis stores claims and responses. If Redis crashes, in-process fallback is per-node; the database only enforces `uq_booking_idempotency` per `(flight_id, departure_date)`. There is no dedicated durable `idempotency_records` table in PostgreSQL.

* **Item 17: Outbox polling & multi-instance concurrency**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`src/repositories/outboxRepository.js:68-73`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/repositories/outboxRepository.js#L68-L73). `listPending` runs `SELECT ... FROM booking_outbox WHERE published = false ORDER BY created_at LIMIT $1` without `FOR UPDATE SKIP LOCKED`. Multiple consumer workers will fetch identical batches and race to publish. Published rows are never partitioned or pruned.

* **Item 18: Reaper throughput cap**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`src/workers/holdReaper.js:24-27`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/workers/holdReaper.js#L24-L27). Reaper poll interval is 30s with batch size 200, capping throughput at 6.7 holds/second.

* **Item 19: CQRS read model pagination & scaling**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** `flight_availability` is a single non-distributed table; search queries lack cursor keyset pagination and typeahead indexing.

* **Item 20: Startup parameters in PgBouncer pool**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`src/db/pool.js:44-45`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/db/pool.js#L44-L45). `statement_timeout` and `idle_in_transaction_session_timeout` are passed as startup parameters in `buildPoolConfig`, which PgBouncer in transaction pooling mode ignores or rejects on pooled connections.

---

### F. Counter Table (`flight_inventory`)
* **Item 21: Inequality constraint `available + held <= total`**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`db/migrations/003-flights-and-inventory.js:85`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/db/migrations/003-flights-and-inventory.js#L85). `CONSTRAINT inv_capacity CHECK (available_seats + held_seats <= total_seats)`. Does not track `sold_seats`, so seat leaks cannot be caught by constraint checks alone.

* **Item 22: Counter mutators gating**
  - **Verdict:** **PARTIAL**
  - **Evidence:** `reserve` and `confirm` are guarded by state updates in the service, but lack an explicit unified repository contract that couples booking status transitions and inventory movements atomically across all edge cases.

* **Item 23: HOT updates on `flight_inventory`**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** `flight_inventory` is created with default fillfactor (100) and no HOT update tuning.

* **Item 24: No automated ledger/reconcile job**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** No background reconciliation daemon exists that continuously asserts `available + held + sold == total` against bookings.

* **Item 25: Sharded-counter empty-shard stealing**
  - **Verdict:** **CONFIRMED**
  - **Evidence:** [`src/services/inventoryService.js:151-167`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/src/services/inventoryService.js#L151-L167). If a shard runs out of capacity, it skips to another, but lacks an explicit capacity stealing/balancing mechanism.

---

### G. Replication, HA & Search (Items 26-34)
* **Item 26-28: No replication or automated failover:** **CONFIRMED**.
* **Item 29: No Elasticsearch search tier:** **CONFIRMED**.
* **Item 30: 2FA & Auth verification:** **PARTIAL** (Basic 2FA exists in `src/auth/` and `src/services/mailerService.js`, but lacks HMAC peppered challenge storage, unified challenge IDs, lockout tracking, and Mailpit dev-catcher).
* **Item 31: Security defaults (`CORS=*`, default JWT secrets):** **CONFIRMED** in `.env.example:13,65-66`.
* **Item 32: CI uses plain PostgreSQL only:** **CONFIRMED** in `.github/workflows/ci.yml:19`.
* **Item 33: Committed worktrees / port mismatch:** **CONFIRMED** (`.claude/` exists in tree).
* **Item 34: Frontend Control Room:** **CONFIRMED** (React frontend exists, but lacks SSE real-time streaming, Test Lab harness, and chaos controls).
