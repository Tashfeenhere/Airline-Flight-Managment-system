/**
 * Migration 005 — `user_bookings`, the secondary index that makes "my bookings"
 * a single-shard lookup.
 *
 * Bookings are sharded by `flight_id` (that is what keeps a booking transaction on
 * one worker). A per-user query would therefore scatter across every shard. This
 * table is distributed by `user_id` instead, so `GET /api/me/bookings` reads from
 * exactly one shard.
 *
 * It cannot be co-located with `bookings` (different distribution key), so it is
 * maintained asynchronously by the outbox consumer: eventually consistent, never
 * authoritative. Everything it holds is a projection of a booking that already
 * committed elsewhere.
 */
const citus = require('../../src/db/citus');

module.exports = {
  id: '005',
  name: 'user_bookings_projection',
  target: 'write',
  transactional: false,
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_bookings (
        user_id           uuid NOT NULL,
        booking_id        uuid NOT NULL,
        flight_id         uuid NOT NULL,
        departure_date    date NOT NULL,
        booking_reference text NOT NULL,
        status            text NOT NULL,
        cabin             text NOT NULL,
        seat_number       text,
        passenger_name    text,
        origin            text,
        destination       text,
        flight_number     text,
        airline_code      text,
        departure_time    timestamptz,
        price             numeric(10,2),
        currency          text,
        booking_created_at timestamptz NOT NULL,
        -- Bookkeeping for the projection itself: which outbox event produced the
        -- current row. Makes replays idempotent and stale updates detectable.
        last_event_at     timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),

        PRIMARY KEY (user_id, booking_id)
      );
    `);

    // Distributed by user_id — deliberately a DIFFERENT distribution key from the
    // booking tables, which is exactly why this projection is asynchronous.
    await citus.distribute(client, 'user_bookings', 'user_id', {
      shardCount: citus.shardCount
    });

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_bookings_recent
        ON user_bookings (user_id, booking_created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_user_bookings_status
        ON user_bookings (user_id, status);
    `);
  }
};
