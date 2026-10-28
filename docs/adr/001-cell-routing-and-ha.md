/**
 * Architecture Decision Records (ADR 001)
 *
 * Subject: Multi-Region Geography, Cell-Based Routing, and High Availability Topology
 * Work Package: WP9
 */

# ADR 001: Cell-Based Write Routing, Synchronous Local HA, and Nearest-Node Reads

## Context
Airline flight inventory is a single-writer distributed problem. Attempting active-active multi-master writes on identical flight cabin counters across geographic regions risks split-brain oversell when networks partition. Under the CAP theorem, airline seat inventory must strictly adhere to **Consistency and Partition Tolerance (CP)** for writes, while scaling **Availability (AP)** for read models, flight schedules, and search.

## Decision

1. **Cell Ownership by Flight Origin Region**:
   - Every flight is assigned to a home "Cell" (regional Citus cluster) based on its origin airport region (`flight_cell` mapping).
   - All booking write operations (`POST /api/bookings`, `POST /api/bookings/:id/cancel`) are routed strictly to the home cell of that flight.
   - If the home cell is unreachable due to a network partition, the write fails cleanly with `503 Service Unavailable` and a `Retry-After` header rather than risking double-allocation.

2. **Per-Node High Availability (Patroni + Citus)**:
   - Each stateful Citus node (Coordinator and Workers) operates with:
     - 1 Primary (Read/Write)
     - 1 Synchronous Standby in the same local region (RPO = 0)
     - 1 Asynchronous Standby in an offsite disaster-recovery region
   - Coordinated via a 3-node etcd cluster with fencing/watchdog to eliminate split-brain risk.
   - Failover RTO is bounded under 30 seconds.

3. **PgBouncer & Connection Pooling**:
   - Minimum 2 PgBouncer instances running in transaction pooling mode behind HAProxy / VIP.
   - Workers and coordinator endpoints are registered via stable internal DNS/VIP, not transient container names.

4. **Nearest-Node Reads & Forwarding**:
   - Searches (Elasticsearch / PostgreSQL read-model) and read queries (`GET /api/flights/:id`) are served by the nearest local healthy node.
   - Client requests carry standard latency hints (`x-node-id`, `x-region`, `x-home-cell`, `x-read-model-lag-ms`).
   - SDK / UI measures RTT to all regional endpoints, automatically binds to the lowest-latency healthy endpoint, and transparently handles failover retries using idempotent request keys.

## Consequences
- **Positive**: Zero oversell guarantee is preserved even during cross-region fiber cuts. RPO = 0 for local node failures.
- **Trade-off**: Bookings on flights originating in an isolated region cannot be created until the cell primary or standby is reachable. Read models continue serving cached inventory with lag indicators.
