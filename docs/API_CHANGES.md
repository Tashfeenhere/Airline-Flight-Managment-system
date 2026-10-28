# API Changes & Public Contract Documentation

**Version:** 2.1.0  
**Status:** Implemented & Verified

This document details all additive and backward-compatible changes made to the public HTTP surface of the Airline Flight Management System.

---

## 1. Routable Composite Identifiers (WP2)

### New Property: `routableId`
Every booking serialization now returns a composite identifier alongside the primary `bookingId`:
```json
{
  "bookingId": "01a16dce-506e-76d3-9e96-64cfae4b67fe",
  "routableId": "bk_eyJiIjoiMDFhMTZkY2UtNTA2ZS03NmQzLTllOTYtNjRjZmFlNGI2N2ZlIiwiZiI6IjAxYTE2ZGNlLTQxOGEtNzNjNC05M2UyLTQ3MWE5YmE5NzA3ZiIsImQiOiIyMDI2LTEyLTE1IiwiYyI6ImFwaS1sb2NhbCJ9",
  "bookingReference": "BK-94B4HYSR0V",
  "flightId": "01a16dce-418a-73c4-93e2-471a9ba9707f",
  "departureDate": "2026-12-15",
  "status": "CONFIRMED"
}
```

### Endpoints Accepting `routableId`
- `GET /api/bookings/:bookingIdOrRoutableId`
- `POST /api/bookings/:bookingIdOrRoutableId/cancel`

When a client queries using `routableId`, the API immediately extracts `(flightId, departureDate)` and performs a **single-shard, single-partition direct index probe**, completely avoiding coordinator cluster fan-out across all 32 shards. UUIDv7 lookups remain fully supported as backward-compatible fallbacks.

---

## 2. Multi-Passenger Group Bookings (WP1)

`POST /api/bookings` now accepts a list of passengers for all-or-nothing group reservations:
```json
{
  "flightId": "01a16dce-418a-73c4-93e2-471a9ba9707f",
  "cabin": "ECONOMY",
  "passengers": [
    { "passengerName": "Ada Lovelace", "seatNumber": "14A" },
    { "passengerName": "Charles Babbage", "seatNumber": "14B" }
  ]
}
```
All passengers are inserted into `booking_passengers` co-located with the flight record in a single transaction.

---

## 3. Real-Time Event Backbone Stream (WP13)

### `GET /api/stream`
- **Protocol**: Server-Sent Events (SSE).
- **Headers**:
  - `Content-Type: text/event-stream`
  - `Last-Event-ID`: Optional client header for zero-loss stream resumption.
- **Events Emitted**:
  - `BOOKING_EVENT`: Live saga transitions (`BOOKING_SAGA_RESERVE`, `BOOKING_SAGA_CONFIRM`, `BOOKING_SAGA_COMPENSATE`).
  - `INVENTORY_CHANGED`: Counter delta updates (`available`, `held`, `sold`).
  - `OUTBOX_PROJECT`: CQRS read-model and search projection updates.

### `GET /api/stream/recent`
Returns up to 100 recent buffered events for initial UI hydration.

---

## 4. Control Room UI Endpoint (WP14)

- Mounted at `/control-room` and `/admin/lab`.
- Provides an interactive dashboard with live telemetry terminal, scenario runner, and chaos controls.
