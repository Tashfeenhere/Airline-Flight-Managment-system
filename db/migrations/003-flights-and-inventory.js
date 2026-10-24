/**
 * Migration 003 — flights and count-based inventory.
 *
 * The central schema decision of the redesign: inventory is a *counter per
 * (flight, cabin)*, not a row per physical seat. At 50M flights a seat-per-row
 * model would mean ~9-10 billion rows; counters mean ~150M, and the physical seat
 * only materializes when someone actually holds it (on `bookings.seat_number`).
 *
 * Anti-oversell lives on one conditional UPDATE against `flight_inventory`
 * (`available_seats > 0`), which takes a row lock: racing buyers serialize and the
 * losers see zero rows updated. That single statement is the invariant.
 *
 * `shard_no` is part of the primary key from day one even though the default
 * `INVENTORY_STRATEGY=single` uses exactly one row (shard_no = 0). Splitting a hot
 * flight's counter across N rows is then a pure application change — the schema
 * and the aggregate queries (`SUM(...) GROUP BY cabin`) stay identical.
 */
const citus = require('../../src/db/citus');

const DISTRIBUTION_COLUMN = 'flight_id';
const TABLE = 'flights';

module.exports = {
  id: '003',
  name: 'flights_and_inventory',
  target: 'write',
  transactional: false,
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS flights (
        flight_id       uuid NOT NULL DEFAULT app_uuidv7(),
        flight_number   text NOT NULL,
        airline_code    text NOT NULL,
        origin          text NOT NULL,
        destination     text NOT NULL,
        departure_date  date NOT NULL,
        departure_time  timestamptz NOT NULL,
        arrival_time    timestamptz NOT NULL,
        aircraft_type   text NOT NULL,
        base_price      numeric(10,2) NOT NULL CHECK (base_price >= 0),
        currency        text NOT NULL DEFAULT 'USD',
        status          text NOT NULL DEFAULT 'SCHEDULED'
                        CHECK (status IN ('SCHEDULED','ACTIVE','DEPARTED','COMPLETED','CANCELLED')),
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),

        -- The distribution column (flight_id) and the partition key
        -- (departure_date) must both appear: Citus requires the distribution
        -- column in every unique constraint, and PostgreSQL requires all
        -- partition-key columns in the primary key of a partitioned table.
        PRIMARY KEY (flight_id, departure_date),

        CONSTRAINT ck_flights_route CHECK (origin <> destination),
        CONSTRAINT ck_flights_time_order CHECK (arrival_time > departure_time),
        -- The partition key is derived, not independently editable: a drift
        -- between departure_date and departure_time would silently defeat
        -- partition pruning and could park a row in the wrong month.
        CONSTRAINT ck_flights_departure_date
          CHECK (departure_date = (departure_time AT TIME ZONE 'UTC')::date)
      ) PARTITION BY RANGE (departure_date);
    `);

    // Distribute BEFORE creating partitions: Citus distributes the parent and then
    // gives each partition its own set of shards.
    await citus.distribute(client, TABLE, DISTRIBUTION_COLUMN, {
      shardCount: citus.shardCount
    });

    await client.query(`
      CREATE TABLE IF NOT EXISTS flight_inventory (
        flight_id       uuid NOT NULL,
        departure_date  date NOT NULL,
        cabin           text NOT NULL,
        shard_no        smallint NOT NULL DEFAULT 0,
        total_seats     integer NOT NULL CHECK (total_seats >= 0),
        available_seats integer NOT NULL CHECK (available_seats >= 0),
        held_seats      integer NOT NULL DEFAULT 0 CHECK (held_seats >= 0),
        version         bigint NOT NULL DEFAULT 0,
        updated_at      timestamptz NOT NULL DEFAULT now(),

        PRIMARY KEY (flight_id, departure_date, cabin, shard_no),

        -- The accounting invariant, enforced by the database rather than trusted
        -- to application code: seats sold or held can never exceed capacity.
        CONSTRAINT inv_capacity CHECK (available_seats + held_seats <= total_seats),
        CONSTRAINT ck_inventory_shard_non_negative CHECK (shard_no >= 0)
      ) PARTITION BY RANGE (departure_date);
    `);

    // Co-located with `flights`: a booking transaction that touches both tables
    // stays on a single worker and commits as one local ACID transaction.
    await citus.distribute(client, 'flight_inventory', DISTRIBUTION_COLUMN, {
      colocateWith: TABLE
    });

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_flights_number_date
        ON flights (flight_number, departure_date);

      CREATE INDEX IF NOT EXISTS idx_flights_route_date
        ON flights (origin, destination, departure_date);

      CREATE INDEX IF NOT EXISTS idx_flights_status_date
        ON flights (status, departure_date);
    `);
  }
};
