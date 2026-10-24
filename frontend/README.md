# AeroScale — Distributed Airline Inventory Frontend

Production-quality React frontend for the Distributed Airline Inventory system. Backed by Citus PostgreSQL sharding, transactional outbox event streaming, anti-oversell conditional locks, and CQRS search read-models.

---

## 🛠 Tech Stack

- **Framework**: Vite + React 18
- **Routing**: React Router v6 (Nested layouts, protected routes, admin route guards)
- **State Management**: Zustand (Auth tokens, role status, session-persisted search parameters)
- **HTTP Client**: Axios with Bearer auth interceptor and refresh token rotation queue
- **Icons**: Lucide React (Clean, enterprise-grade vector icons — no emojis)
- **Charts**: Recharts (Transactional outbox volume and velocity)
- **Theme**: Aerospace Dark Theme (Custom CSS tokens, glassmorphism, responsive data tables, interactive SVG seat map)

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
cd frontend
npm install
```

### 2. Development Server
```bash
npm run dev
```
The app runs at `http://127.0.0.1:5173/`. All `/api/*` requests are automatically proxied to the backend at `http://localhost:3000`.

### 3. Production Build
```bash
npm run build
```

---

## 🧭 Page & Route Directory (22 Routes)

| Route | Page | Purpose | Clearance |
|---|---|---|---|
| `/` | `HomePage` | Hero search widget, architecture highlights, popular routes | Public |
| `/flights/search` | `SearchResultsPage` | Filterable flight cards, price ceiling, CQRS lag indicator | Public |
| `/flights/:flightId` | `FlightDetailPage` | Aircraft details, cabin class tabs, interactive SVG seat map | Public |
| `/auth/signup` | `SignUpPage` | Passenger self-registration | Public |
| `/auth/signin` | `SignInPage` | Credentials login with quick-fill demo accounts | Public |
| `/auth/verify-email` | `EmailVerificationPage` | Non-blocking token validation shell | Public |
| `/auth/forgot-password` | `ForgotPasswordPage` | Account password recovery shell | Public |
| `/flights/:flightId/book` | `BookingCheckoutPage` | Passenger form & client-generated idempotency key protection | PASSENGER / AGENT |
| `/bookings/:id/confirmation` | `BookingConfirmationPage` | E-ticket boarding pass & printable receipt | PASSENGER / AGENT |
| `/my-bookings` | `MyBookingsPage` | Historical & active reservations with cancellation workflow | PASSENGER / AGENT |
| `/bookings/:bookingId` | `BookingDetailPage` | Saga lifecycle timeline inspection | PASSENGER / AGENT |
| `/bookings/reference/:ref` | `BookingByReferencePage` | Human-readable reference code lookup | PASSENGER / AGENT |
| `/profile` | `ProfilePage` | Identity credentials and session token management | PASSENGER / AGENT |
| `/admin/dashboard` | `AdminDashboardPage` | Cluster telemetry KPIs and outbox volume trend charts | ADMIN |
| `/admin/flights` | `AdminFlightsPage` | Sharded flight schedules data table with status filters | ADMIN |
| `/admin/flights/create` | `AdminCreateFlightPage` | Provision new flight routes and initialize cabin counters | ADMIN |
| `/admin/inventory/audit` | `AdminInventoryAuditPage` | Anti-oversell invariant audit runner | ADMIN |
| `/admin/outbox` | `AdminOutboxStatsPage` | Transactional outbox streaming queue monitor | ADMIN |
| `/admin/partitions` | `AdminPartitionsPage` | Monthly partition table horizon configuration | ADMIN |
| `/admin/topology` | `AdminTopologyPage` | Citus coordinator and distributed worker shard map | ADMIN |
| `/admin/projections` | `AdminReprojectionPage` | CQRS read-model background reprojection trigger | ADMIN |
| `*` | `NotFoundPage` | Aeronautical 404 error page | Public |

---

## 🛡 Concurrency & Anti-Oversell Principles

1. **Idempotency**: Checkout requests send an `Idempotency-Key` header. Retries replay the original booking state without charging multiple seats.
2. **Conditional Locking**: Backend executes `UPDATE flight_inventory SET available_seats = available_seats - 1 WHERE available_seats > 0`, ensuring racing transactions never oversell.
3. **CQRS Decoupling**: Searches read the read-model projection, while reservations query the write-model counter directly.
