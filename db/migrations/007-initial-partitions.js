/**
 * Migration 007 — initial partitions.
 *
 * Runs against both targets: the write model's co-located tables and the read
 * model's `flight_availability`. Creating a partition of a *distributed* parent in
 * Citus creates a distributed child automatically, so this step works the same on
 * a Citus cluster and on vanilla PostgreSQL.
 *
 * The window is intentionally narrow (a few months either side of today) because
 * partitions exist to make pruning possible, not to pre-create empty space. The
 * bulk loader is expected to widen the horizon before it writes — see
 * `app_ensure_month_partitions()` and `npm run partitions:maintain`.
 */
const env = require('../../src/config/env');

const WRITE_PARENTS = [
  'flights',
  'flight_inventory',
  'bookings',
  'payments',
  'booking_outbox'
];

const READ_PARENTS = ['flight_availability'];

module.exports = {
  id: '007',
  name: 'initial_partitions',
  target: 'all',
  transactional: false,
  async up(client, ctx) {
    const parents = ctx.target === 'read' ? READ_PARENTS : WRITE_PARENTS;

    for (const parent of parents) {
      const { rows } = await client.query(
        'SELECT app_ensure_month_partitions($1, $2, $3) AS created',
        [parent, env.PARTITION_MONTHS_BEHIND, env.PARTITION_MONTHS_AHEAD]
      );
      ctx.log(
        `partitions for ${parent}: ${rows[0].created} created ` +
          `(window ${env.PARTITION_MONTHS_BEHIND} months back .. ${env.PARTITION_MONTHS_AHEAD} ahead)`
      );
    }
  }
};
