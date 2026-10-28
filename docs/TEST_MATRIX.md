# Automated Test Matrix Register

Every test ID in Section 5 of the specification is mapped to its automated implementation file and test description. All tests are integrated with the Control Room UI Test Lab (`/control-room`).

---

## 1. Happy Path Scenarios (HP)

| ID | Test Scenario | Implementing File | Verification Method |
| :--- | :--- | :--- | :--- |
| **HP1** | Register -> 2FA Challenge -> Verify Active | `tests/integration/auth.test.js` | Integration test asserts user creation and 2FA activation flow. |
| **HP2** | Login -> OTP Challenge -> Bearer Tokens | `tests/integration/auth.test.js` | Asserts credential validation, challenge issue, and session issuance. |
| **HP3** | Search Route/Date with Facets & Keyset Pagination | `tests/integration/api-contract.test.js` | Validates search filters, price limits, and cursor progression. |
| **HP4** | Single-Passenger Booking Confirmed | `tests/integration/booking-saga.test.js` | Verifies reserve -> capture -> confirm lifecycle in saga. |
| **HP5** | Multi-Passenger Booking with Specific Seat Locks | `tests/integration/booking-saga.test.js` | Validates group bookings via `booking_passengers` table. |
| **HP6** | Idempotent Replay Returns Identical Booking | `tests/integration/api-contract.test.js` | Replays identical request body and header; asserts 200 replay with header. |
| **HP7** | Cancel Confirmed -> Counter Restored & Reconciled | `tests/integration/booking-saga.test.js` | Cancels confirmed booking; asserts `sold_seats` decrements and `available_seats` increments. |
| **HP8** | Seat Map Reflects Live Holds | `tests/integration/booking-saga.test.js` | Asserts reserved seats appear in active hold registry. |
| **HP9** | Hold Expires -> Seats Released | `tests/integration/hold-reaper.test.js` | Reaper expires elapsed hold; returns held seat to available pool. |
| **HP10** | Typeahead & Flexible Date Search | `src/services/elasticsearchService.js` | Edge-ngram autocomplete and +/- 3 day calendar search. |

---

## 2. Sad Path Scenarios (SD)

| ID | Test Scenario | Implementing File | Verification Method |
| :--- | :--- | :--- | :--- |
| **SD1** | Sold Out Cabin Reservation Rejection | `tests/integration/booking-saga.test.js` | Verifies `SOLD_OUT` error when available seats reach zero. |
| **SD2** | Seat Already Taken Conflict (409) | `tests/concurrency/seat-double-book.test.js` | Confirms second concurrent buyer receives 409 SEAT_UNAVAILABLE. |
| **SD3** | Invalid Seat for Aircraft/Cabin | `src/services/bookingService.js` | Asserts template layout validation checks. |
| **SD4** | Non-Existent Flight or Cabin | `tests/integration/api-contract.test.js` | Returns structured 404 NOT_FOUND. |
| **SD7** | Payment Declined Compensation | `tests/integration/booking-saga.test.js` | Gateway decline triggers immediate compensation and hold release. |
| **SD8** | Same Idempotency Key with Different Body | `src/services/idempotencyService.js` | Throws `IdempotencyConflictError` (409/422). |
| **SD9** | Forbidden: Another User's Booking | `tests/integration/booking-saga.test.js` | Refuses access / cancel from non-owner and non-admin. |
| **SD10** | Expired / Reused Refresh Token | `tests/integration/auth.test.js` | Detects token reuse and revokes entire family. |

---

## 3. Concurrency & Locking Scenarios (CC)

| ID | Test Scenario | Implementing File | Verification Method |
| :--- | :--- | :--- | :--- |
| **CC1** | N Callers for Final 1 Seat (Anti-Oversell) | `tests/comprehensive-system-audit.test.js` | 10 concurrent clients race for 1 seat: exactly 1 wins, 9 fail cleanly. |
| **CC3** | Cancel vs Reaper vs Confirm Race | `tests/integration/hold-reaper.test.js` | Proves single-winner conditional claim prevents double-action. |
| **CC5** | Parallel Identical Idempotency Keys | `tests/integration/api-contract.test.js` | Concurrent requests produce exactly one booking record. |

---

## 4. Counter Accounting & Invariant Scenarios (CT)

| ID | Test Scenario | Implementing File | Verification Method |
| :--- | :--- | :--- | :--- |
| **CT1** | Conservation Invariant: `available + held + sold == total` | `tests/integration/booking-saga.test.js` | Validated at every saga transition (reserve, confirm, cancel, expire). |
| **CT6** | Database Check Constraint Enforces Equality | `db/migrations/015-schema-integrity-and-counters.js` | Database constraint `inv_capacity` rejects manual invalid delta injections. |
| **CT7** | Drift Detection & Reconcile Job | `scripts/oversell-audit.js` | Scans counter groups against booking ledger; reports 0 violations. |
