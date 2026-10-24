# Distributed Airline Inventory API

A transactional seat-inventory API built on distributed PostgreSQL (Citus). It keeps
inventory as a **counter per (flight, cabin)** guarded by a conditional
`UPDATE ... WHERE available_seats > 0`, so racing buyers serialize and the losers
see zero rows updated. Bookings are created by a saga (hold -> authorize -> capture
-> confirm) and exposed through a CQRS read model for search.

This document is the human guide. The machine-readable contract is the OpenAPI
3.0.3 document in [`src/openapi/swaggerSpec.js`](../src/openapi/swaggerSpec.js),
served at `/api-docs.json` (UI at `/api-docs`).

- Conventions and envelopes: [Response contract](#1-response-contract)
- Auth and token rotation: [Authentication](#2-authentication)
- Replay safety: [Idempotency](#3-idempotency)
- Booking states: [Booking lifecycle](#4-booking-lifecycle)
- Search vs availability: [Consistency model](#5-consistency-model)
- Throttling: [Rate limits](#6-rate-limits)
- Every failure code: [Error codes](#7-error-codes)
- Copy-paste flows: [curl cookbook](#9-curl-cookbook)

---

## 1. Response contract

All responses are JSON except `GET /metrics`, which is Prometheus text
(`text/plain; version=0.0.4`). There are exactly two body shapes.

**Success** - any 2xx status:

```json
{
  "success": true,
  "data": { "...": "endpoint-specific payload" }
}
```

**Error** - any 4xx/5xx status:

```json
{
  "success": false,
  "error": {
    "code": "SEAT_UNAVAILABLE",
    "message": "Requested seat is no longer available",
    "details": { "seatNumber": "12A" }
  },
  "nodeId": "api-local",
  "timestamp": "2026-10-13T12:00:00.000Z"
}
```

- `error.code` is **stable**. Branch on it; never parse `error.message`, which is
  for humans and may change.
- `error.details` is optional and code-specific (field lists, conflicting ids,
  versions). Treat it as advisory.
- `nodeId` identifies the API instance that answered, for support correlation.

Request bodies are always `application/json`. Send
`Idempotency-Key` on booking creation (accepts `x-idempotency-key` as an alias).
`x-node-id` may be sent for log correlation; it never changes routing.

---

## 2. Authentication

Three roles exist: `PASSENGER`, `AGENT`, `ADMIN`. Self-registration creates a
`PASSENGER` only; agent/admin accounts are provisioned out of band.

### 2.1 Token pair

`POST /api/auth/login` (and `POST /api/auth/refresh`) return:

```json
{
  "accessToken":  "<JWT, short-lived: JWT_ACCESS_TTL, default 15m>",
  "refreshToken": "<opaque, rotating: JWT_REFRESH_TTL_SECONDS, default 30d>",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "refreshExpiresIn": 2592000
}
```

Send the access token on every authenticated request:

```
Authorization: Bearer <accessToken>
```

### 2.2 Refresh rotation and reuse detection

Refresh tokens are not stateless. Every login starts a **token family**; every
`POST /api/auth/refresh` inserts a new token in the same family and marks the
presented one as replaced. Consequences:

- A refresh token is **single-use**. Always store the newest `refreshToken` from
  the response and discard the old one.
- Presenting a token that has already been rotated can only mean it was stolen
  (the legitimate holder would already have the newer token), so the server
  **revokes the whole family** and every device in it is logged out.
- `POST /api/auth/refresh` fails with `401 TOKEN_INVALID` (unknown/revoked, or a
  reused token) or `401 TOKEN_EXPIRED` (past its expiry).

Client guidance: on any 401 from a refresh, clear local tokens and force a fresh
login. Do **not** auto-retry a refresh with the same token.

### 2.3 Flow

```
POST /api/auth/register   -> 201 PublicUser
POST /api/auth/login      -> 200 { user, accessToken, refreshToken, expiresIn }
        ... use accessToken until it expires ...
POST /api/auth/refresh    -> 200 { accessToken, refreshToken, ... }   (replace stored pair)
POST /api/auth/logout     -> 200 { revoked: true }                    (revoke this device)
GET  /api/auth/me         -> 200 current user
```

---

## 3. Idempotency

Booking creation is safe to retry. Pass a client-generated `Idempotency-Key`
header (a UUID is fine). The rules:

| Retry | Result |
|---|---|
| Same key + **same** body | `200` with the **original** booking, `Idempotent-Replay: true`. No new seat is consumed. |
| Same key + **different** body | `409 IDEMPOTENCY_CONFLICT`. Nothing is created. |
| New key | Normal processing: `201` (or `202`, see below), or a business error. |

Implementation notes that matter to clients:

- Idempotency is checked globally (Redis `SET NX`) and backstopped per
  `(flight, departure_date)` by the `uq_booking_idempotency` unique index, so two
  concurrent retries cannot both insert.
- Generate the key **before** the first attempt and reuse it verbatim for every
  retry of that logical booking.
- If a request fails with a business error (`409`, `410`), the key is **not**
  consumed against a booking; a corrected request should use a **new** key.

### Synchronous vs asynchronous confirmation

Controlled by `BOOKING_SAGA_INLINE`:

- `true` (default): the saga runs inline. `POST /api/bookings` answers
  `201` with `status: CONFIRMED` (or `409 PAYMENT_FAILED` on a declined payment).
- `false`: the hold is placed and the response is `202` with `status: PENDING`.
  The client polls `GET /api/bookings/{bookingId}` until it reaches a terminal
  state.

---

## 4. Booking lifecycle

```
        POST /api/bookings
                |
                v
          +-----------+
          |  PENDING  |   hold placed, inventory held, payment in flight
          +-----------+
           |    |    \
   payment |    |     \  hold TTL elapses (reaper)
  captured |    | user \  ------------------------> +-----------+
           |    | cancel                            |  EXPIRED  |
           v    v        saga compensation           +-----------+
     +------------+  \--> +-------------+
     | CONFIRMED  |       |  CANCELLED  |   (terminal)
     +------------+       +-------------+
           |                    ^
           |  POST /cancel       |
           +--------------------+
```

| From | To | Trigger |
|---|---|---|
| - | `PENDING` | `POST /api/bookings` places the hold and writes the booking + outbox event in one transaction. |
| `PENDING` | `CONFIRMED` | Payment captured; inventory is consumed (hold -> sale). Inline (`201`) or by the saga worker. |
| `PENDING` | `EXPIRED` | `hold_expires_at` (default `BOOKING_HOLD_TTL_SECONDS=600`) passes before payment settles. The reaper releases the counter; the seat drops out of the live-seat unique index. |
| `PENDING` | `CANCELLED` | `POST /api/bookings/{id}/cancel` on a still-live hold, or saga compensation after a payment failure. |
| `CONFIRMED` | `CANCELLED` | `POST /api/bookings/{id}/cancel`. Refunds the captured payment and releases the seat. |
| `CANCELLED`, `EXPIRED` | - | Terminal. Cancelling again is `409 ALREADY_CANCELLED`; cancelling a reaped hold is `410 HOLD_EXPIRED`. |

Only `PENDING` and `CONFIRMED` are **live**: they hold the seat number. A
cancelled or expired booking frees the seat for the next buyer.

---

## 5. Consistency model

Two different reads, on purpose:

- **`GET /api/flights/search`** reads the **CQRS projection** (eventually
  consistent). It is fast and never touches booking shards, but it can lag. The
  response carries `readModelLagMs`; a route that was just created may be missing
  until the outbox consumer projects it.
- **`GET /api/flights/{flightId}/availability`** reads the **write model**
  (strongly consistent). Use it right before booking to obtain the current
  `version` for `expectedVersion`.

Booking writes always go to the write model, so a booking is never lost to read
lag.

---

## 6. Rate limits

Two sliding windows, both returning `429 RATE_LIMITED` with a `Retry-After`
header (seconds):

| Scope | Default | Env |
|---|---|---|
| Auth endpoints (`/api/auth/*`) | 30 requests / minute | `AUTH_RATE_LIMIT_PER_MIN` |
| Everything else | 600 requests / minute | `API_RATE_LIMIT_PER_MIN` |

Rate limiting is disabled when `RATE_LIMIT_ENABLED=false` (always off under
`NODE_ENV=test`). Clients must honour `Retry-After` and back off exponentially
rather than retrying immediately.

---

## 7. Error codes

`code` is the stable identifier. `HTTP` is the status the API returns.

| Code | HTTP | When it happens | What the client should do |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | A body/query/path field is missing or malformed. `details.fields` lists them. | Fix the request; do not retry unchanged. |
| `INVALID_ID` | 400 | A path/query id is not a UUID. | Fix the id. |
| `UNAUTHENTICATED` | 401 | No bearer token on a protected endpoint. | Log in and send `Authorization`. |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password on login. | Re-prompt; do not hammer (watch the auth rate limit). |
| `TOKEN_INVALID` | 401 | Access/refresh token is malformed, revoked, or a reused refresh token. | Re-authenticate; for a reused refresh token, log out everywhere (the family was revoked). |
| `TOKEN_EXPIRED` | 401 | Access token past `exp`, or refresh token past its TTL. | Refresh once (access) or log in again (refresh). |
| `FORBIDDEN` | 403 | Authenticated but the role is insufficient (e.g. non-admin on `/api/admin/*`). | Stop; request elevated access. |
| `NOT_FOUND` | 404 | The resource does not exist, or is not visible to the caller. | Stop; verify the id/reference. |
| `SOLD_OUT` | 409 | No seats remain in the requested cabin. | Offer another cabin/flight; do not blind-retry. |
| `SEAT_UNAVAILABLE` | 409 | The requested specific seat is already held/booked. | Pick another seat and retry with a **new** idempotency key. |
| `DUPLICATE_BOOKING` | 409 | A live booking already holds that seat for this flight/date. | Same as `SEAT_UNAVAILABLE`: choose another seat. |
| `VERSION_CONFLICT` | 409 | `expectedVersion` is stale (inventory moved under you). | Re-read availability, then retry with the new version and a new key. |
| `PAYMENT_FAILED` | 409 | The (simulated) gateway declined; the saga compensated. | Surface failure; let the user retry with a new key. |
| `DUPLICATE_ENTRY` | 409 | A conflicting unique row exists (e.g. flight upsert). | Adjust the payload. |
| `DUPLICATE_USER` | 409 | Email already registered. | Prompt to log in or use another email. |
| `ALREADY_CANCELLED` | 409 | Cancel on a booking already CANCELLED. | Treat as success (idempotent intent reached). |
| `IDEMPOTENCY_CONFLICT` | 409 | Same `Idempotency-Key`, different body. | Use a new key for the corrected request. |
| `INVALID_STATUS` | 409 | The action is not allowed from the current booking state. | Re-read the booking; only act on live states. |
| `HOLD_EXPIRED` | 410 | The PENDING hold was reaped before payment/cancellation. | Start a new booking (new key); the old one is gone. |
| `RATE_LIMITED` | 429 | A rate window was exceeded. | Wait `Retry-After` seconds, then retry with backoff. |
| `INVENTORY_INVARIANT_VIOLATION` | 500 | Accounting invariant breached (correctness alarm). | Do not retry; alert operators with `nodeId`/`timestamp`. |
| `INTERNAL_ERROR` | 500 | Unexpected server fault. | Retry with backoff once; then report with `nodeId`. |
| `NOT_IMPLEMENTED` | 501 | A feature is disabled in this deployment. | Do not retry. |
| `TRANSIENT_TRANSACTION_ERROR` | 503 | Retries exhausted on a serialization failure/deadlock. | Retry the whole request with backoff. |
| `DATABASE_UNAVAILABLE` | 503 | The write model is unreachable. | Retry with backoff; check `/api/health/ready`. |

> Every value above is one of the frozen `ERROR_CODES` in
> [`src/config/constants.js`](../src/config/constants.js).

---

## 8. Pagination

List endpoints accept `limit` (1-200, default 20) and `offset` (default 0) and
return a `pagination` object:

```json
{ "limit": 20, "offset": 0, "total": 1, "hasMore": false }
```

`total` is the count before paging. Iterate by increasing `offset` until
`hasMore` is `false`.

---

## 9. curl cookbook

Set a base URL and a scratch file for tokens. Requires `curl` and `jq`.

```bash
BASE=http://localhost:3000
```

### 9.1 Happy path

**1. Register**

```bash
curl -s -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{
        "email": "ada.lovelace@example.com",
        "password": "S3cur3-Pa$$w0rd",
        "fullName": "Ada Lovelace",
        "phone": "+92-300-1234567"
      }' | jq .
# 201 { "success": true, "data": { "id": "...", "email": "...", "role": "PASSENGER", ... } }
```

**2. Log in and capture tokens**

```bash
curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada.lovelace@example.com","password":"S3cur3-Pa$$w0rd"}' \
  > /tmp/login.json

ACCESS=$(jq -r .data.accessToken  /tmp/login.json)
REFRESH=$(jq -r .data.refreshToken /tmp/login.json)
echo "access len: ${#ACCESS}"
```

**3. Search flights** (public)

```bash
curl -s "$BASE/api/flights/search?origin=ISB&destination=LHR&departureDate=2026-11-02&passengers=1" \
  | jq '{total: .data.total, lag: .data.readModelLagMs, first: .data.flights[0].flightNumber}'

FLIGHT_ID=$(curl -s "$BASE/api/flights/search?origin=ISB&destination=LHR&departureDate=2026-11-02" \
  | jq -r '.data.flights[0].flightId')
```

**4. Read authoritative availability** (write model) to get the version

```bash
curl -s "$BASE/api/flights/$FLIGHT_ID/availability?cabin=ECONOMY" \
  | jq '.data.cabins[0]'
VERSION=$(curl -s "$BASE/api/flights/$FLIGHT_ID/availability?cabin=ECONOMY" \
  | jq -r '.data.cabins[0].version')
```

**5. Inspect the seat map** (public)

```bash
curl -s "$BASE/api/flights/$FLIGHT_ID/seatmap?cabin=ECONOMY" \
  | jq '{rows: .data.rows, booked: [.data.seats[] | select(.status=="BOOKED") | .seatNumber]}'
```

**6. Create a booking** (idempotent). Generate the key once and reuse it.

```bash
IDEM=$(uuidgen 2>/dev/null || node -e "console.log(require('crypto').randomUUID())")

curl -s -X POST "$BASE/api/bookings" \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEM" \
  -d "{
        \"flightId\": \"$FLIGHT_ID\",
        \"cabin\": \"ECONOMY\",
        \"passengerName\": \"Ada Lovelace\",
        \"passengerRef\": \"PASS-9001\",
        \"seatNumber\": \"12A\",
        \"expectedVersion\": $VERSION
      }" | jq '{status: .data.status, ref: .data.bookingReference}'
# 201 { "status": "CONFIRMED", "ref": "BK-7F9A12K4QW" }
```

**7. Retry the exact same request** - replays the original booking, consumes no
new seat:

```bash
curl -si -X POST "$BASE/api/bookings" \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEM" \
  -d "{
        \"flightId\": \"$FLIGHT_ID\",
        \"cabin\": \"ECONOMY\",
        \"passengerName\": \"Ada Lovelace\",
        \"passengerRef\": \"PASS-9001\",
        \"seatNumber\": \"12A\",
        \"expectedVersion\": $VERSION
      }" | grep -iE '^HTTP|^idempotent-replay'
# HTTP/1.1 200 OK
# idempotent-replay: true
```

**8. Look the booking up, list my bookings, and cancel**

```bash
REF=$(curl -s "$BASE/api/users/me/bookings" -H "Authorization: Bearer $ACCESS" \
      | jq -r '.data.bookings[0].bookingReference')

curl -s "$BASE/api/bookings/reference/$REF" -H "Authorization: Bearer $ACCESS" | jq '.data.status'

BOOKING_ID=$(curl -s "$BASE/api/bookings/reference/$REF" -H "Authorization: Bearer $ACCESS" \
             | jq -r '.data.bookingId')

curl -s -X POST "$BASE/api/bookings/$BOOKING_ID/cancel" \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Change of plans"}' | jq '.data.status'
# "CANCELLED"  (the seat is released back to inventory)
```

**9. Rotate the refresh token** (single-use; store the new pair)

```bash
curl -s -X POST "$BASE/api/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}" \
  | jq '{expiresIn: .data.expiresIn, rotated: (.data.refreshToken != "'"$REFRESH"'")}'
# { "expiresIn": 900, "rotated": true }
```

Reusing `$REFRESH` again now yields `401 TOKEN_INVALID` and revokes the family.

### 9.2 Seat-conflict path

Two clients race for seat `12A` on the same flight. The first wins; the second is
told why and how to recover.

```bash
KEY_A=$(node -e "console.log(require('crypto').randomUUID())")
KEY_B=$(node -e "console.log(require('crypto').randomUUID())")
BODY="{\"flightId\":\"$FLIGHT_ID\",\"cabin\":\"ECONOMY\",\"passengerName\":\"Ada\",\"seatNumber\":\"12A\"}"

# Client A books 12A first.
curl -s -X POST "$BASE/api/bookings" \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY_A" -d "$BODY" | jq '{status: .data.status, seat: .data.seatNumber}'
# 201 { "status": "CONFIRMED", "seat": "12A" }

# Client B attempts the same seat with a different key.
curl -si -X POST "$BASE/api/bookings" \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY_B" -d "$BODY" | jq -R 'select(test("HTTP|code|message"))'
# 409 with a body of:
# {
#   "success": false,
#   "error": {
#     "code": "SEAT_UNAVAILABLE",
#     "message": "Requested seat is no longer available",
#     "details": { "seatNumber": "12A" }
#   },
#   "nodeId": "api-local",
#   "timestamp": "2026-10-13T12:00:00.000Z"
# }
```

Recovery:

1. Re-read the seat map and pick a free seat.
2. Re-read availability to get the fresh `version`.
3. Retry `POST /api/bookings` with a **new** `Idempotency-Key`.

If instead the failure was `409 VERSION_CONFLICT` (the counter moved between your
read and your write), the same recovery applies: refresh `version`, then retry.
`SOLD_OUT` and `DUPLICATE_BOOKING` are reported the same way with a different
`code`.

### 9.3 Operator checks

```bash
# Is the node ready to serve? (503 if a dependency is down)
curl -s "$BASE/api/health/ready" | jq '.data.status'

# Outbox backlog and read-model lag (ADMIN token required)
curl -s "$BASE/api/admin/outbox/stats" -H "Authorization: Bearer $ADMIN_ACCESS" \
  | jq '.data | {pending, oldestEventAgeMs}'

# Oversell audit (ADMIN)
curl -s -X POST "$BASE/api/admin/inventory/audit" \
  -H "Authorization: Bearer $ADMIN_ACCESS" -H 'Content-Type: application/json' \
  -d "{\"flightId\":\"$FLIGHT_ID\"}" | jq '.data | {checked, oversoldCount}'
```

---

## 10. Endpoint index

| Method | Path | Auth | Success |
|---|---|---|---|
| POST | `/api/auth/register` | public | 201 |
| POST | `/api/auth/login` | public | 200 |
| POST | `/api/auth/refresh` | public | 200 |
| POST | `/api/auth/logout` | public | 200 |
| GET | `/api/auth/me` | bearer | 200 |
| GET | `/api/flights/search` | public | 200 |
| GET | `/api/flights/{flightId}` | public | 200 |
| GET | `/api/flights/{flightId}/seatmap` | public | 200 |
| GET | `/api/flights/{flightId}/availability` | public | 200 |
| POST | `/api/bookings` | bearer (or guest) | 201 / 200 / 202 |
| GET | `/api/bookings/{bookingId}` | bearer | 200 |
| GET | `/api/bookings/reference/{bookingReference}` | bearer | 200 |
| POST | `/api/bookings/{bookingId}/cancel` | bearer | 200 |
| GET | `/api/users/me/bookings` | bearer | 200 |
| GET | `/api/health` | public | 200 |
| GET | `/api/health/live` | public | 200 |
| GET | `/api/health/ready` | public | 200 / 503 |
| GET | `/api/admin/topology` | bearer + ADMIN | 200 |
| POST | `/api/admin/flights` | bearer + ADMIN | 200 |
| POST | `/api/admin/partitions/maintain` | bearer + ADMIN | 200 |
| POST | `/api/admin/projections/reproject` | bearer + ADMIN | 200 |
| POST | `/api/admin/inventory/audit` | bearer + ADMIN | 200 |
| GET | `/api/admin/outbox/stats` | bearer + ADMIN | 200 |
| GET | `/metrics` | public | 200 (text/plain) |
