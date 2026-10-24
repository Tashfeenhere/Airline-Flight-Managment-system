/**
 * Migration registry.
 *
 * Ordering is by `id` (zero-padded, so string order is apply order). Each entry
 * declares which database it targets:
 *   'write' -> the Citus coordinator (bookings, inventory, users, ...)
 *   'read'  -> the CQRS read model (search/availability)
 *   'all'   -> both (shared helpers)
 *
 * Add new migrations as new files; never edit an applied one (the runner reports
 * that as drift).
 */
const modules = [
  require('./001-extensions-and-helpers'),
  require('./002-reference-tables'),
  require('./003-flights-and-inventory'),
  require('./004-bookings-payments-outbox'),
  require('./005-user-bookings-projection'),
  require('./006-read-model'),
  require('./007-initial-partitions'),
  require('./008-citus-reference-tables'),
  require('./009-baseline-reference-data'),
  require('./010-refresh-tokens'),
  require('./011-booking-confirmed-timestamp'),
  require('./012-regions'),
  require('./013-two-factor-and-verification')
];

const migrations = modules
  .map((migration) => {
    if (!migration.id || !migration.name || typeof migration.up !== 'function') {
      throw new Error(
        `Invalid migration module: ${JSON.stringify({
          id: migration.id,
          name: migration.name,
          hasUp: typeof migration.up === 'function'
        })}`
      );
    }
    return migration;
  })
  .sort((a, b) => a.id.localeCompare(b.id));

// Guard against duplicate ids, which would make apply order ambiguous.
const seen = new Set();
for (const migration of migrations) {
  if (seen.has(migration.id)) {
    throw new Error(`Duplicate migration id '${migration.id}' in db/migrations`);
  }
  seen.add(migration.id);
}

module.exports = {
  migrations,
  targets: ['write', 'read']
};
