/**
 * Migration 012 — the region dimension.
 *
 * The dataset is a global network sliced into five regions. A region is a *slice of
 * rows*, not a separate namespace: one nullable `text` column on the tables that
 * describe or own geography (`airports`, `airlines`, `flights`, `users`,
 * `flight_inventory`) plus a small lookup table. That keeps the API querying
 * `public.*` exactly as before and keeps the partition scheme — which is keyed on
 * `departure_date` — untouched.
 *
 * Two deliberate omissions:
 *
 *   - `region` is in no primary key or unique constraint. On Citus every unique
 *     constraint must contain the distribution column (`flight_id` / `user_id`), so
 *     adding `region` would change every `ON CONFLICT` target in the repositories and
 *     loaders for no benefit.
 *   - No foreign keys to `regions`. A Citus distributed table cannot have an FK to a
 *     non-reference table, and 008 (already applied) is the migration that would have
 *     had to declare `regions` as a reference table. The loader validates the codes.
 *
 * `transactional: false` for the same reason 007 and 011 use it: Citus rejects DDL in
 * a distributed transaction. Every statement is independently idempotent, so a re-run
 * after a partial failure is a no-op.
 *
 * The index on `(region, departure_date)` is deliberately *not* created here. It is an
 * optional reporting index built after the bulk load (see `docs/DATA_LOADING.md` /
 * `loaders/README.md`); creating it first would make every `COPY` maintain it.
 */
module.exports = {
  id: '012',
  name: 'regions',
  target: 'write',
  transactional: false,
  async up(client) {
    // --- 1. The lookup table ------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS regions (
        code       text PRIMARY KEY,
        name       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      INSERT INTO regions (code, name) VALUES
        ('SOUTH_ASIA',    'South Asia'),
        ('MIDDLE_EAST',   'Middle East'),
        ('EUROPE',        'Europe'),
        ('NORTH_AMERICA', 'North America'),
        ('EAST_ASIA',     'East Asia')
      ON CONFLICT (code) DO NOTHING;
    `);

    // --- 2. Region columns --------------------------------------------------
    // Nullable with no default, so on PostgreSQL this is a metadata-only ALTER and
    // does not rewrite the existing (potentially large) tables.
    for (const table of ['flights', 'users', 'airports', 'airlines', 'flight_inventory']) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS region text`);
    }

    // --- 3. East Asian reference data --------------------------------------
    // 009 seeded only South Asia / Middle East / Europe / North America. Without
    // these rows every East Asia flight would be an orphan in
    // `scripts/validate-data.js`. Same shape and conflict target as 009.
    await client.query(`
      INSERT INTO airlines (code, name, country) VALUES
        ('SQ', 'Singapore Airlines', 'SG'),
        ('CX', 'Cathay Pacific',     'HK'),
        ('JL', 'Japan Airlines',     'JP'),
        ('KE', 'Korean Air',         'KR'),
        ('CA', 'Air China',          'CN')
      ON CONFLICT (code) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO airports (code, name, city, country, tz) VALUES
        ('SIN', 'Singapore Changi',        'Singapore', 'SG', 'Asia/Singapore'),
        ('HKG', 'Hong Kong International', 'Hong Kong', 'HK', 'Asia/Hong_Kong'),
        ('NRT', 'Tokyo Narita',            'Tokyo',     'JP', 'Asia/Tokyo'),
        ('ICN', 'Incheon International',   'Seoul',     'KR', 'Asia/Seoul'),
        ('PEK', 'Beijing Capital',         'Beijing',   'CN', 'Asia/Shanghai')
      ON CONFLICT (code) DO NOTHING;
    `);

    // --- 4. Backfill the existing reference rows ---------------------------
    // `WHERE region IS NULL` makes each statement a no-op on a re-run and prevents
    // it from overwriting a region an operator assigned by hand.
    const assignments = [
      { region: 'SOUTH_ASIA', airports: ['ISB', 'LHE', 'KHI'], airlines: ['PK'] },
      { region: 'MIDDLE_EAST', airports: ['DXB', 'DOH'], airlines: ['EK', 'QR'] },
      // IST sits on the Europe/Asia boundary; EUROPE matches 009's Europe/Istanbul tz.
      { region: 'EUROPE', airports: ['LHR', 'FRA', 'IST'], airlines: ['BA', 'LH', 'TK'] },
      { region: 'NORTH_AMERICA', airports: ['JFK'], airlines: ['AA', 'UA'] },
      {
        region: 'EAST_ASIA',
        airports: ['SIN', 'HKG', 'NRT', 'ICN', 'PEK'],
        airlines: ['SQ', 'CX', 'JL', 'KE', 'CA']
      }
    ];

    for (const { region, airports, airlines } of assignments) {
      await client.query(
        `UPDATE airports SET region = $1 WHERE code = ANY($2::text[]) AND region IS NULL`,
        [region, airports]
      );
      await client.query(
        `UPDATE airlines SET region = $1 WHERE code = ANY($2::text[]) AND region IS NULL`,
        [region, airlines]
      );
    }
  }
};
