/**
 * Migration 008 — Citus topology for the shared dimensions.
 *
 * Reference tables are replicated in full to every worker. That is what lets a
 * booking query join `flights` (distributed) with `seat_map_templates`,
 * `aircraft_types` or `users` (reference) without a network hop between workers and
 * without a cross-shard transaction.
 *
 * On vanilla PostgreSQL this migration is a no-op: the tables already exist as
 * ordinary local tables, which is the same thing a reference table is when there
 * is only one node.
 */
const citus = require('../../src/db/citus');

const REFERENCE_TABLES = [
  'airlines',
  'airports',
  'cabins',
  'aircraft_types',
  'seat_map_templates',
  'users'
];

module.exports = {
  id: '008',
  name: 'citus_reference_tables',
  target: 'write',
  transactional: false,
  async up(client, ctx) {
    const state = await citus.distributionState(client);

    if (!state.canDistribute) {
      ctx.log(
        `Citus not active (installed=${state.citusInstalled}, activeWorkers=${state.activeWorkers}); ` +
          'reference tables remain plain local tables.'
      );
      return;
    }

    for (const table of REFERENCE_TABLES) {
      await citus.makeReference(client, table);
    }
  }
};
