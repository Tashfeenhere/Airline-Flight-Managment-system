/**
 * Migration 006 — the CQRS read model (search / availability).
 *
 * Targets the *read* database (or a separate cluster in production), not the
 * Citus write model. This is what `GET /api/flights` searches: a denormalized row
 * per (route, date, flight, cabin) that answers "A -> B on date D with seats"
 * without touching the booking shards.
 *
 * It is rebuilt from the write model by the outbox consumer and by
 * `npm run readmodel:reproject`, so it can always be dropped and regenerated —
 * which is precisely why search can be allowed to lag.
 *
 * Partitioned by departure_date so old availability ages out with the same
 * partition lifecycle as the write model.
 */
module.exports = {
  id: '006',
  name: 'flight_availability_read_model',
  target: 'read',
  transactional: false,
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS flight_availability (
        origin          text NOT NULL,
        destination     text NOT NULL,
        departure_date  date NOT NULL,
        flight_id       uuid NOT NULL,
        flight_number   text NOT NULL,
        airline_code    text NOT NULL,
        aircraft_type   text,
        departure_time  timestamptz NOT NULL,
        arrival_time    timestamptz,
        cabin           text NOT NULL,
        total_seats     integer NOT NULL DEFAULT 0,
        available_seats integer NOT NULL DEFAULT 0,
        held_seats      integer NOT NULL DEFAULT 0,
        price           numeric(10,2) NOT NULL DEFAULT 0,
        currency        text NOT NULL DEFAULT 'USD',
        status          text NOT NULL DEFAULT 'SCHEDULED',
        -- The write-model version this projection was derived from: lets the
        -- consumer discard an out-of-order (stale) event instead of overwriting
        -- fresher data with older data.
        source_version  bigint NOT NULL DEFAULT 0,
        updated_at      timestamptz NOT NULL DEFAULT now(),

        PRIMARY KEY (origin, destination, departure_date, flight_id, cabin)
      ) PARTITION BY RANGE (departure_date);
    `);

    // The search access path: route + date, filtered by remaining seats.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_availability_route_date
        ON flight_availability (origin, destination, departure_date, available_seats);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_availability_departure_time
        ON flight_availability (departure_time);
    `);

    // Lets a flight's availability be found without knowing its route (used by the
    // reprojection job and by "flight changed" projections).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_availability_flight
        ON flight_availability (flight_id, departure_date);
    `);

    // Projection bookkeeping: the highest write-model version projected per flight,
    // so the consumer and the freshness reporter can reason about lag.
    await client.query(`
      CREATE TABLE IF NOT EXISTS projection_state (
        projection   text PRIMARY KEY,
        last_event_at timestamptz,
        last_event_id uuid,
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
};
