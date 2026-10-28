/**
 * Migration 004 — bookings, payments and the transactional outbox.
 *
 * All three are co-located with `flights` by `flight_id` and partitioned by
 * `departure_date`, so every write in the booking path is a single-shard,
 * single-worker transaction.
 *
 * Two database-level guarantees worth calling out:
 *
 * 1. `uq_live_seat` — a partial unique index over live seat assignments. It makes
 *    double-booking a *specific* seat impossible even if application logic were
 *    wrong, and it is the backstop the seat-map endpoint depends on.
 * 2. `uq_booking_idempotency` — unique per (flight, departure_date). A distributed
 *    table cannot carry a globally unique index unless the distribution column is
 *    part of it, so cross-flight idempotency is owned by the Redis idempotency
 *    record (SET NX), and this index is the per-flight backstop against two
 *    concurrent retries racing to insert.
 */
const citus = require('../../src/db/citus');

const DISTRIBUTION_COLUMN = 'flight_id';
const COLOCATE_WITH = 'flights';

module.exports = {
  id: '004',
  name: 'bookings_payments_outbox',
  target: 'write',
  transactional: false,
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        booking_id        uuid NOT NULL DEFAULT app_uuidv7(),
        booking_reference text NOT NULL,
        flight_id         uuid NOT NULL,
        departure_date    date NOT NULL,
        user_id           uuid NOT NULL,
        cabin             text NOT NULL,
        -- Which inventory counter row this booking decremented. Required so the
        -- confirm/compensate steps release the exact row that was held, which
        -- keeps every write single-shard (a sharded counter is no use if the
        -- release step has to scan all shards).
        inventory_shard   smallint NOT NULL DEFAULT 0,
        seat_number       text,
        passenger_name    text NOT NULL,
        passenger_ref     text,
        status            text NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED')),
        price             numeric(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
        currency          text NOT NULL DEFAULT 'USD',
        idempotency_key   text,
        hold_expires_at   timestamptz,
        node_id           text,
        transaction_id    uuid NOT NULL,
        payment_id        uuid,
        confirmed_at      timestamptz,
        cancelled_at      timestamptz,
        cancellation_reason text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),

        PRIMARY KEY (flight_id, departure_date, booking_id),

        CONSTRAINT ck_bookings_seat_upper
          CHECK (seat_number IS NULL OR seat_number = upper(seat_number)),
        -- A hold without an expiry could never be reaped.
        CONSTRAINT ck_bookings_pending_has_hold
          CHECK (status <> 'PENDING' OR hold_expires_at IS NOT NULL)
      ) PARTITION BY RANGE (departure_date);
    `);

    await citus.distribute(client, 'bookings', DISTRIBUTION_COLUMN, {
      colocateWith: COLOCATE_WITH
    });

    // Human-readable reference, unique within a flight+date. The distribution
    // column and the partition key are both present, as Citus/PostgreSQL require.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_reference
        ON bookings (flight_id, departure_date, booking_reference);
    `);

    // The hard anti-double-book guarantee for specific seats: at most one live
    // booking may hold a given seat number. Cancelled/expired rows drop out of the
    // predicate and stop blocking the seat.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_live_seat
        ON bookings (flight_id, departure_date, seat_number)
        WHERE seat_number IS NOT NULL AND status IN ('PENDING','CONFIRMED');
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_idempotency
        ON bookings (flight_id, departure_date, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_flight_status
        ON bookings (flight_id, departure_date, status);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_user_date
        ON bookings (user_id, departure_date DESC);
    `);

    await client.query(`
      -- Drives the hold-expiry reaper; partial so it only covers open holds.
      CREATE INDEX IF NOT EXISTS idx_bookings_hold_expiry
        ON bookings (hold_expires_at)
        WHERE status = 'PENDING';
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_transaction
        ON bookings (transaction_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        payment_id     uuid NOT NULL DEFAULT app_uuidv7(),
        flight_id      uuid NOT NULL,
        departure_date date NOT NULL,
        booking_id     uuid NOT NULL,
        amount         numeric(10,2) NOT NULL CHECK (amount >= 0),
        currency       text NOT NULL DEFAULT 'USD',
        provider       text NOT NULL DEFAULT 'SIMULATED',
        status         text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','AUTHORIZED','CAPTURED','FAILED','REFUNDED')),
        -- Saga step, persisted so a crash can be reconciled: the row records how
        -- far the reserve -> authorize -> capture -> confirm sequence got.
        saga_state     text,
        failure_reason text,
        provider_reference text,
        idempotency_key text,
        authorized_at  timestamptz,
        captured_at    timestamptz,
        refunded_at    timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),

        -- The partition key must appear in every unique constraint on a
        -- partitioned table; Citus additionally requires the distribution column.
        PRIMARY KEY (flight_id, departure_date, payment_id),
        -- One payment per booking.
        CONSTRAINT uq_payments_booking UNIQUE (flight_id, departure_date, booking_id)
      ) PARTITION BY RANGE (departure_date);
    `);

    await citus.distribute(client, 'payments', DISTRIBUTION_COLUMN, {
      colocateWith: COLOCATE_WITH
    });

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_status
        ON payments (status, departure_date);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_booking
        ON payments (flight_id, departure_date, booking_id);
    `);

    // Transactional outbox: written in the SAME transaction as the state change it
    // describes, so no event can be lost when the API process dies after commit.
    // A poller (src/workers/outboxConsumer.js) projects the read models from here.
    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_outbox (
        flight_id      uuid NOT NULL,
        departure_date date NOT NULL,
        event_id       uuid NOT NULL DEFAULT app_uuidv7(),
        event_type     text NOT NULL,
        aggregate_id   uuid NOT NULL,
        user_id        uuid,
        payload        jsonb NOT NULL,
        published      boolean NOT NULL DEFAULT false,
        attempts       integer NOT NULL DEFAULT 0,
        last_error     text,
        created_at     timestamptz NOT NULL DEFAULT now(),
        published_at   timestamptz,

        PRIMARY KEY (flight_id, departure_date, event_id)
      ) PARTITION BY RANGE (departure_date);
    `);

    await citus.distribute(client, 'booking_outbox', DISTRIBUTION_COLUMN, {
      colocateWith: COLOCATE_WITH
    });

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
        ON booking_outbox (created_at)
        WHERE published = false;
    `);
  }
};
