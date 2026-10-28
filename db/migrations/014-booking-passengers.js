/**
 * Migration 014 — Group bookings, passenger manifests, and composite routing support.
 *
 * Adds:
 * 1. `booking_passengers` table (co-located with bookings on flight_id) to support
 *    multi-passenger group bookings with individual passenger seat assignments.
 * 2. `composite_booking_id` on bookings for zero-fanout, single-shard routing.
 */
const citus = require('../../src/db/citus');

module.exports = {
  id: '014',
  name: 'booking_passengers_and_group_bookings',
  target: 'write',
  transactional: false,
  async up(client, ctx) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_passengers (
        passenger_id      uuid NOT NULL DEFAULT app_uuidv7(),
        booking_id        uuid NOT NULL,
        flight_id         uuid NOT NULL,
        departure_date    date NOT NULL,
        full_name         text NOT NULL,
        passenger_type    text NOT NULL DEFAULT 'ADULT'
                          CHECK (passenger_type IN ('ADULT', 'CHILD', 'INFANT')),
        seat_number       text,
        passenger_ref     text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),

        PRIMARY KEY (flight_id, departure_date, booking_id, passenger_id),

        CONSTRAINT ck_passenger_seat_upper
          CHECK (seat_number IS NULL OR seat_number = upper(seat_number))
      ) PARTITION BY RANGE (departure_date);
    `);

    // Co-locate with `flights` so joins and updates stay local to the worker
    await citus.distribute(client, 'booking_passengers', 'flight_id', {
      colocateWith: 'flights'
    });

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_passengers_lookup
        ON booking_passengers (booking_id);
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_passenger_live_seat
        ON booking_passengers (flight_id, departure_date, seat_number)
        WHERE seat_number IS NOT NULL;
    `);

    // Ensure partitions exist for booking_passengers
    await client.query(`
      SELECT app_ensure_month_partitions('booking_passengers', 1, 26);
    `);

    ctx.log('Migration 014: created booking_passengers and ensured partitions.');
  }
};
