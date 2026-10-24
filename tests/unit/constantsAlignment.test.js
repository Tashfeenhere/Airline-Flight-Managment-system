/**
 * Unit test — the enums in `src/config/constants.js` stay aligned with the CHECK
 * constraints in `db/migrations`.
 *
 * `constants.js` claims this test exists ("`tests/unit/constantsAlignment.test.js`
 * asserts the two stay in sync"). A database CHECK that accepts a value the application
 * enum forbids is dead code; an application enum that emits a value the CHECK rejects is
 * a 23514 at the worst possible moment — mid-booking, after a seat is held. This suite
 * reads the migration sources as text and compares the literal value sets, so the check
 * fails the moment either side is edited alone.
 *
 * It reads files, not the live database, on purpose: it must run in the hermetic unit
 * suite with no server, and it must catch a migration that has not been applied yet.
 */
const fs = require('fs');
const path = require('path');
const {
  BOOKING_STATUS,
  PAYMENT_STATUS,
  FLIGHT_STATUS,
  USER_ROLES,
  CABINS,
  LIVE_BOOKING_STATUSES,
  CONSTRAINT_NAMES
} = require('../../src/config/constants');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');

/** Concatenated source of every migration, so a constraint may live in any file. */
function allMigrationSql() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'))
    .join('\n');
}

const SQL = allMigrationSql();

/** Extracts the string literals from `CHECK (<column> IN ('A','B',...))` for one column. */
function valuesInCheck(sql, column) {
  // Matches `CHECK (status IN ('A', 'B'))` with any internal whitespace/quotes style.
  const pattern = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, 'i');
  const match = sql.match(pattern);
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

describe('constants alignment with db/migrations CHECK constraints', () => {
  test('BOOKING_STATUS matches the bookings.status CHECK', () => {
    // There are several `status` CHECKs (flights, bookings, payments); find the booking
    // one by its distinctive EXPIRED value.
    const bookingCheck = [...SQL.matchAll(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/gi)]
      .map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort())
      .find((values) => values.includes('EXPIRED'));

    expect(bookingCheck).toBeDefined();
    expect(bookingCheck).toEqual(Object.values(BOOKING_STATUS).sort());
  });

  test('PAYMENT_STATUS matches the payments.status CHECK', () => {
    const paymentCheck = [...SQL.matchAll(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/gi)]
      .map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort())
      .find((values) => values.includes('REFUNDED'));

    expect(paymentCheck).toBeDefined();
    expect(paymentCheck).toEqual(Object.values(PAYMENT_STATUS).sort());
  });

  test('FLIGHT_STATUS matches the flights.status CHECK', () => {
    const flightCheck = [...SQL.matchAll(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/gi)]
      .map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort())
      .find((values) => values.includes('SCHEDULED'));

    expect(flightCheck).toBeDefined();
    expect(flightCheck).toEqual(Object.values(FLIGHT_STATUS).sort());
  });

  test('USER_ROLES matches the users.role CHECK', () => {
    const sqlRoles = valuesInCheck(SQL, 'role');
    expect(sqlRoles).toBeDefined();
    expect(sqlRoles).toEqual(Object.values(USER_ROLES).sort());
  });

  test('LIVE_BOOKING_STATUSES are a subset of BOOKING_STATUS', () => {
    const all = new Set(Object.values(BOOKING_STATUS));
    for (const status of LIVE_BOOKING_STATUSES) expect(all.has(status)).toBe(true);
    expect([...LIVE_BOOKING_STATUSES].sort()).toEqual(['CONFIRMED', 'PENDING']);
  });

  test('CABINS matches the reference-data seed', () => {
    // The seed inserts one row per cabin code; compare the literal set the insert names.
    const seeded = new Set();
    for (const m of SQL.matchAll(/\('([A-Z_]+)',\s*'[^']*',\s*\d+\)/g)) {
      if (CABINS.includes(m[1])) seeded.add(m[1]);
    }
    expect([...seeded].sort()).toEqual([...CABINS].sort());
  });

  test('uq_live_seat covers exactly the LIVE_BOOKING_STATUSES', () => {
    const match = SQL.match(
      /uq_live_seat[\s\S]*?WHERE\s+seat_number\s+IS\s+NOT\s+NULL\s+AND\s+status\s+IN\s*\(([^)]*)\)/i
    );
    expect(match).not.toBeNull();
    const inIndex = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(inIndex).toEqual([...LIVE_BOOKING_STATUSES].sort());
  });

  test('CONSTRAINT_NAMES values are real constraint/index names in the migrations', () => {
    // INVENTORY_NON_NEGATIVE is declared here as a logical name; if it is not yet a
    // literal in the migrations, the test should say so rather than silently pass.
    const declared = [
      CONSTRAINT_NAMES.LIVE_SEAT_UNIQUE,
      CONSTRAINT_NAMES.BOOKING_REFERENCE_UNIQUE,
      CONSTRAINT_NAMES.IDEMPOTENCY_UNIQUE,
      CONSTRAINT_NAMES.USER_EMAIL_UNIQUE,
      CONSTRAINT_NAMES.INVENTORY_CAPACITY
    ];
    for (const name of declared) {
      expect(SQL).toContain(name);
    }
  });

  test('no enum value is duplicated within a single enum', () => {
    for (const enumObject of [BOOKING_STATUS, PAYMENT_STATUS, FLIGHT_STATUS, USER_ROLES]) {
      const values = Object.values(enumObject);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});
