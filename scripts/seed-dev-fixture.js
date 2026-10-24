#!/usr/bin/env node
/**
 * `npm run seed:dev` — a TINY deterministic development fixture.
 *
 * Read this first: this script is NOT a data loader. It creates three users and about
 * six flights so a developer can log in and curl the API seconds after `db:migrate`.
 * The real population — ~100,000 users and ~50,000,000 flights — is loaded by the
 * Python bulk loaders against `docs/DATA_LOADING.md`; do not grow this file into one.
 * A fixture that tries to be a loader is slow, flaky, and competes with the loader for
 * the same shared tables.
 *
 *   node scripts/seed-dev-fixture.js                 # seed the default 3 users / 6 flights
 *   node scripts/seed-dev-fixture.js --users=5 --flights=12
 *   node scripts/seed-dev-fixture.js --reset         # delete the fixture's own rows, then reseed
 *   node scripts/seed-dev-fixture.js --help
 *
 * Everything it writes is reachable from a deterministic identity, which is what makes
 * `--reset` safe: flights carry a fixed UUID namespace and users carry a reserved email
 * domain, so a reset deletes exactly its own rows — never `TRUNCATE`, which on the
 * shared cluster would wipe the loader's work and any operator's in-flight booking.
 *
 * Flights are created through `flightService.upsertFlight`, not by raw INSERT, so the
 * inventory counters are seeded and the outbox event is emitted by the same code path
 * production uses. That is deliberate: a fixture written with hand-rolled SQL would
 * "work" while the real upsert stayed broken, which is the opposite of useful. The
 * seat capacities come from the `seat_map_templates` reference data (migration 009),
 * so a flight's counter can never disagree with the seat map the API serves.
 *
 * Re-running is idempotent: flights upsert on (flight_id, departure_date) and counters
 * use DO NOTHING, so a second run does not duplicate inventory or double-count seats.
 * Because the fixture is scheduled relative to *today*, a re-run on a later day adds the
 * same flight ids on new dates; `--reset` is what collapses that back to one clean set.
 *
 * Exit codes: 0 seeded/cleared, 1 seed or reset failed, 2 bad usage.
 */
'use strict';

const pool = require('../src/db/pool');
const env = require('../src/config/env');
const logger = require('../src/utils/logger');
const flightService = require('../src/services/flightService');
const authService = require('../src/services/authService');
const projectionService = require('../src/services/projectionService');
const userRepository = require('../src/repositories/userRepository');
const { hashPassword } = require('../src/auth/password');
const { USER_ROLES } = require('../src/config/constants');

const DEFAULT_USERS = 3;
const DEFAULT_FLIGHTS = 6;

// Bounds exist so `--reset` can enumerate every id the fixture could ever have created
// without a table scan. They are far above any sane dev fixture; the bulk loader is the
// tool for volume, not this script.
const MAX_FIXTURE_USERS = 200;
const MAX_FIXTURE_FLIGHTS = 200;

// The fixture's deterministic identity. Both patterns are reserved exclusively for this
// script: the UUID namespace is not a real v7 the app would generate, and example.com is
// IANA-reserved for documentation, so a reset can never delete a loader-created row.
const FIXTURE_FLIGHT_ID_NAMESPACE = 'f1c7d000-0000-7000-8000';
const FIXTURE_EMAIL_PREFIX = 'dev-fixture-';
const FIXTURE_EMAIL_DOMAIN = 'example.com';
const FIXTURE_PASSWORD = 'DevFixture!234';

// The first fixture user is an ADMIN so the admin-only endpoints (flight upsert, inventory
// audit, outbox stats) are reachable without editing the database by hand.
const FIXTURE_ADMIN_INDEX = 1;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Three routes, so search can return more than a single row, and a rotation across every
// real aircraft type in the reference data — including ATR72, the one with a single cabin,
// because a bug that only appears when a flight lacks a BUSINESS row would otherwise hide.
const FIXTURE_ROUTES = Object.freeze([
  { origin: 'ISB', destination: 'DXB', airlineCode: 'PK', durationMinutes: 210 },
  { origin: 'LHE', destination: 'DXB', airlineCode: 'PK', durationMinutes: 195 },
  { origin: 'KHI', destination: 'DOH', airlineCode: 'QR', durationMinutes: 150 }
]);
const FIXTURE_AIRCRAFT = Object.freeze(['A320', 'A321', 'B737', 'B777', 'B787', 'ATR72']);

class UsageError extends Error {}

const USAGE = `seed-dev-fixture — create a tiny local development fixture.

This is a SMALL developer fixture (a handful of users and flights), NOT a bulk
loader. The 100k-user / 50M-flight population is done by the Python loaders
described in docs/DATA_LOADING.md.

Usage:
  node scripts/seed-dev-fixture.js [options]

Options:
  --users <n>     Number of fixture users to create (default ${DEFAULT_USERS}, max ${MAX_FIXTURE_USERS}).
  --flights <n>   Number of fixture flights to create (default ${DEFAULT_FLIGHTS}, max ${MAX_FIXTURE_FLIGHTS}).
  --reset         Delete ONLY this fixture's rows (deterministic ids/emails),
                  then seed a fresh set. Never TRUNCATEs a shared table.
  -h, --help      Show this help and exit.

Prints the created credentials and ids so you can curl immediately.

Exit codes:
  0  seeded (and/or reset) successfully
  1  a database operation failed, or reset was refused
  2  bad usage (unknown option, missing or out-of-range value)
`;

function fixtureFlightId(index) {
  return `${FIXTURE_FLIGHT_ID_NAMESPACE}-${String(index).padStart(12, '0')}`;
}

function fixtureEmail(index) {
  return `${FIXTURE_EMAIL_PREFIX}${index}@${FIXTURE_EMAIL_DOMAIN}`;
}

/** 1-based range, matching the fixture's index base so ids and emails line up. */
function indexRange(count) {
  return Array.from({ length: count }, (_, offset) => offset + 1);
}

/**
 * The spec for flight `index`. Every field is a pure function of the index (and today's
 * UTC date), so two runs build the same flight and upsert instead of colliding.
 *
 * `departure_date` is not independently editable — the schema requires it to equal the
 * UTC date of `departure_time` — so both are derived from one millisecond timestamp and
 * cannot drift apart.
 */
function flightSpec(index) {
  const route = FIXTURE_ROUTES[(index - 1) % FIXTURE_ROUTES.length];
  const aircraftType = FIXTURE_AIRCRAFT[(index - 1) % FIXTURE_AIRCRAFT.length];

  // Spread flights over three upcoming dates and four departure hours so a route search
  // returns several results in a stable order, while staying well inside the partition
  // window migration 007 created (a few months either side of today).
  const now = new Date();
  const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dateOffsetDays = 10 + ((index - 1) % 3) * 7; // 10, 17, 24, then repeat
  const departureHourUtc = 6 + ((index - 1) % 4) * 3; // 06:00, 09:00, 12:00, 15:00
  const departureMs = midnightUtc + dateOffsetDays * DAY_MS + departureHourUtc * HOUR_MS;

  return {
    flightId: fixtureFlightId(index),
    flightNumber: `${route.airlineCode}${900 + index}`,
    airlineCode: route.airlineCode,
    origin: route.origin,
    destination: route.destination,
    departureDate: new Date(departureMs).toISOString().slice(0, 10),
    departureTime: new Date(departureMs).toISOString(),
    arrivalTime: new Date(departureMs + route.durationMinutes * MINUTE_MS).toISOString(),
    aircraftType,
    basePrice: 120 + index * 35,
    currency: 'USD',
    status: 'SCHEDULED'
  };
}

function parseCount(name, raw) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || String(value) !== String(raw).trim() || value < 1) {
    throw new UsageError(`${name} must be a positive integer, received: '${raw}'`);
  }
  const max = name === '--users' ? MAX_FIXTURE_USERS : MAX_FIXTURE_FLIGHTS;
  if (value > max) {
    throw new UsageError(`${name} is capped at ${max} for this dev fixture; use the bulk loader for volume`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    users: DEFAULT_USERS,
    flights: DEFAULT_FLIGHTS,
    reset: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? null : arg.slice(equals + 1);
    const value = () => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${name} requires a value`);
      i += 1;
      return next;
    };

    switch (name) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--reset':
        args.reset = true;
        break;
      case '--users':
        args.users = parseCount('--users', value());
        break;
      case '--flights':
        args.flights = parseCount('--flights', value());
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }

  return args;
}

/**
 * Deletes the fixture's own rows across both databases.
 *
 * Refuses when a booking references a fixture flight or user: those rows were created by
 * a developer exercising the API, not by this script, and deleting the flight under a live
 * booking would orphan it exactly the way `flightService.cancelFlight` refuses to. The
 * operator clears those bookings first (or uses `npm run db:reset` for a full wipe).
 */
async function resetFixture() {
  const flightIds = indexRange(MAX_FIXTURE_FLIGHTS).map(fixtureFlightId);
  const emails = indexRange(MAX_FIXTURE_USERS).map(fixtureEmail);

  const { rows: userRows } = await pool.query(
    'SELECT id FROM users WHERE email = ANY($1::text[])',
    [emails]
  );
  const userIds = userRows.map((row) => row.id);

  // Two lookups rather than one `flight_id = ANY(...) OR user_id = ANY(...)` on purpose:
  // OR-ing a non-distribution column into the predicate stops Citus routing the query by
  // flight_id and forces a scatter over every shard and partition, which on the 50M-row
  // production table is a scan a dev fixture has no business triggering. Split, the
  // flight lookup routes and the user lookup uses each shard's local (user_id, date) index.
  const { rows: bookingFlightRows } = await pool.query(
    'SELECT count(*)::int AS n FROM bookings WHERE flight_id = ANY($1::uuid[])',
    [flightIds]
  );
  let dependents = Number(bookingFlightRows[0]?.n || 0);
  if (userIds.length > 0) {
    const { rows: bookingUserRows } = await pool.query(
      'SELECT count(*)::int AS n FROM bookings WHERE user_id = ANY($1::uuid[])',
      [userIds]
    );
    dependents += Number(bookingUserRows[0]?.n || 0);
  }

  if (dependents > 0) {
    throw new Error(
      `refusing to reset: ${dependents} booking(s) reference fixture flights or users. ` +
        'Cancel them first, or run `npm run db:reset` to wipe the whole database.'
    );
  }

  // Order matters. The outbox rows go FIRST: a concurrently running consumer that already
  // claimed one would otherwise re-project a flight_availability row for a flight this
  // reset is about to delete, resurrecting a ghost in search.
  const outbox = await pool.query('DELETE FROM booking_outbox WHERE flight_id = ANY($1::uuid[])', [flightIds]);
  const inventory = await pool.query('DELETE FROM flight_inventory WHERE flight_id = ANY($1::uuid[])', [flightIds]);
  const flights = await pool.query('DELETE FROM flights WHERE flight_id = ANY($1::uuid[])', [flightIds]);

  // The read model is a SEPARATE database and is legitimately down while a developer works
  // on the write path, so a failure here must not abort a reset that already succeeded.
  let availability = null;
  try {
    const result = await pool.readQuery(
      'DELETE FROM flight_availability WHERE flight_id = ANY($1::uuid[])',
      [flightIds]
    );
    availability = result.rowCount;
  } catch (err) {
    logger.warn('Could not clear fixture rows from the read model', { error: err.message });
  }

  const users = await pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [emails]);

  return {
    flights: flights.rowCount,
    inventory: inventory.rowCount,
    outbox: outbox.rowCount,
    users: users.rowCount,
    availability // null means the read model was unreachable
  };
}

/**
 * Creates the fixture users through the real registration path, so the stored hash is
 * whatever the active KDF produces (argon2id or scrypt) rather than a hardcoded string.
 */
async function seedUsers(count) {
  const users = [];

  for (const index of indexRange(count)) {
    const email = fixtureEmail(index);
    const role = index === FIXTURE_ADMIN_INDEX ? USER_ROLES.ADMIN : USER_ROLES.PASSENGER;
    const fullName = `Dev Fixture User ${index}`;

    const existing = await userRepository.findByEmail(pool.writePool, { email });
    if (existing) {
      // Re-assert the documented credential. The whole point of printing the password is
      // that it works; if a rerun left a stale hash, the printed "curl immediately" line
      // would be a lie.
      await userRepository.updatePasswordHash(pool.writePool, {
        userId: existing.userId,
        passwordHash: await hashPassword(FIXTURE_PASSWORD)
      });
      users.push({ userId: existing.userId, email, role: existing.role, fullName: existing.fullName, created: false });
      continue;
    }

    const created = await authService.register({ email, password: FIXTURE_PASSWORD, fullName, role });
    users.push({ userId: created.userId, email: created.email, role: created.role, fullName: created.fullName, created: true });
  }

  return users;
}

/**
 * Seeds flights through `flightService.upsertFlight`, which writes the flight, its
 * per-cabin inventory counters and the outbox event in one transaction. Nothing here
 * touches the counters directly, so the fixture cannot produce state the API could not.
 */
async function seedFlights(count) {
  const flights = [];

  for (const index of indexRange(count)) {
    const spec = flightSpec(index);
    const saved = await flightService.upsertFlight({
      flightId: spec.flightId,
      flightNumber: spec.flightNumber,
      airlineCode: spec.airlineCode,
      origin: spec.origin,
      destination: spec.destination,
      departureDate: spec.departureDate,
      departureTime: spec.departureTime,
      arrivalTime: spec.arrivalTime,
      aircraftType: spec.aircraftType,
      basePrice: spec.basePrice,
      currency: spec.currency,
      status: spec.status
    });
    flights.push(saved);
  }

  return flights;
}

/**
 * Flushes the events the fixture just wrote into the search read model, so the first
 * `GET /api/flights/search` returns the seeded flights instead of an empty page.
 *
 * Best-effort on purpose: the outbox consumer does this anyway, and the read model may be
 * down. A projection failure must not fail a seed that already committed — it just leaves
 * search to catch up when the workers run.
 */
async function projectFixture(since) {
  try {
    const result = await projectionService.reprojectAvailability({
      since,
      // A minute of slack on the far end: the outbox `created_at` is the database clock,
      // and a small skew between it and this process must not clip the newest event.
      until: new Date(Date.now() + MINUTE_MS)
    });
    return result;
  } catch (err) {
    logger.warn('Read model not refreshed; search will lag until the outbox consumer runs', {
      error: err.message
    });
    return null;
  }
}

function printResetSummary(removed) {
  console.log('');
  console.log('Reset — removed the fixture\'s own rows:');
  console.log(
    `  flights=${removed.flights}  flight_inventory=${removed.inventory}  ` +
      `outbox=${removed.outbox}  users=${removed.users}  ` +
      `read_model_availability=${removed.availability === null ? 'unreachable' : removed.availability}`
  );
}

function printSeedSummary({ users, flights, projection }) {
  const base = `http://localhost:${env.PORT}`;
  const first = flights[0];
  const loginUser = users[0];

  console.log('');
  console.log('Dev fixture ready.');
  console.log('');
  console.log(`Users (all share the password ${FIXTURE_PASSWORD}):`);
  for (const user of users) {
    console.log(
      `  ${String(user.role).padEnd(9)} ${user.email.padEnd(32)} id=${user.userId}` +
        (user.created ? '' : '  (already existed)')
    );
  }
  console.log('');
  console.log('Flights:');
  for (const flight of flights) {
    const cabins = (flight.cabins || [])
      .map((cabin) => `${cabin.cabin}:${cabin.availableSeats}/${cabin.totalSeats}`)
      .join('  ');
    console.log(
      `  ${String(flight.flightNumber).padEnd(7)} ${flight.origin}->${flight.destination}  ` +
        `${flight.departureDate} ${String(flight.departureTime).slice(11, 16)}Z  ` +
        `${String(flight.aircraftType).padEnd(6)} from $${flight.basePrice}  [${cabins}]`
    );
    console.log(`    flightId=${flight.flightId}`);
  }
  console.log('');
  console.log('Read model:');
  // Truthy is not the same as refreshed. `projectFixture` only returns null when the
  // projection threw, so a run that succeeded while projecting nothing still carries an
  // object here — and the freshly seeded flights would then be absent from search while
  // this line claimed they were there. The count is what the operator is actually being
  // told, so the count is what decides the wording.
  console.log(
    !projection
      ? '  NOT refreshed (read model unreachable or projection failed); run `npm run workers:run` or `npm run readmodel:reproject`.'
      : projection.projected > 0
        ? `  projected ${projection.projected} availability row(s) — search returns these flights now.`
        : '  NOT refreshed (the replay window held no events for these flights); run `npm run workers:run` or `npm run readmodel:reproject`.'
  );
  console.log('');
  console.log('Try it now:');
  console.log('  # log in as the fixture admin and capture a token');
  console.log(`  curl -s -X POST ${base}/api/auth/login \\`);
  console.log("    -H 'Content-Type: application/json' \\");
  console.log(`    -d '{"email":"${loginUser.email}","password":"${FIXTURE_PASSWORD}"}'`);
  console.log('  # search (read model)');
  console.log(
    `  curl -s '${base}/api/flights/search?origin=${first.origin}&destination=${first.destination}&departureDate=${first.departureDate}'`
  );
  console.log('  # authoritative availability and seat map (write model)');
  console.log(`  curl -s '${base}/api/flights/${first.flightId}/availability?cabin=ECONOMY'`);
  console.log(`  curl -s '${base}/api/flights/${first.flightId}/seatmap?cabin=ECONOMY'`);
  console.log('');
}

function printUsage(out) {
  out.write(USAGE);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n`);
      printUsage(process.stderr);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  if (args.help) {
    printUsage(process.stdout);
    return;
  }

  if (args.reset) {
    printResetSummary(await resetFixture());
  }

  const users = await seedUsers(args.users);

  // Captured before the first upsert so the projection flush replays exactly the events
  // this run wrote (plus any concurrent ones, which is harmless — the upserts are guarded).
  const since = new Date(Date.now() - 5_000);
  const flights = await seedFlights(args.flights);
  const projection = await projectFixture(since);

  printSeedSummary({ users, flights, projection });
}

main()
  .catch((err) => {
    console.error(`\nSeed failed: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Closing on every path — success, refusal, usage error — is what keeps this from
    // becoming the hung operator script that never returns the prompt.
    await pool.close();
  });
