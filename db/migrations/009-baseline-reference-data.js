/**
 * Migration 009 — baseline reference data.
 *
 * These are *dimensions*, not fixtures: airlines, airports, cabins, aircraft types
 * and their seat-map templates are reference data the API needs in order to serve a
 * seat map or validate a cabin. Business data — the 50M flight instances and 100k
 * users — is loaded separately (Python bulk loaders for flights/users, plus
 * `npm run seed:dev` for a small local fixture).
 *
 * Every insert is idempotent (ON CONFLICT DO NOTHING) so re-running migrations, or
 * adding rows by hand, is safe. Nothing here is deleted by a re-run.
 */

// aircraft_type, cabin, first row, last row, seat letters (left to right)
const SEAT_MAPS = [
  ['A320', 'BUSINESS', 1, 3, 'ACDF'],
  ['A320', 'ECONOMY', 4, 30, 'ABCDEF'],
  ['A321', 'BUSINESS', 1, 4, 'ACDF'],
  ['A321', 'ECONOMY', 5, 36, 'ABCDEF'],
  ['B737', 'BUSINESS', 1, 3, 'ACDF'],
  ['B737', 'ECONOMY', 4, 32, 'ABCDEF'],
  ['B777', 'FIRST', 1, 2, 'ACDF'],
  ['B777', 'BUSINESS', 3, 9, 'ACDF'],
  ['B777', 'ECONOMY', 10, 45, 'ABCDEF'],
  ['B787', 'BUSINESS', 1, 5, 'ACDF'],
  ['B787', 'ECONOMY', 6, 40, 'ABCDEF'],
  ['ATR72', 'ECONOMY', 1, 18, 'ACDF']
];

module.exports = {
  id: '009',
  name: 'baseline_reference_data',
  target: 'write',
  transactional: true,
  async up(client) {
    await client.query(`
      INSERT INTO airlines (code, name, country) VALUES
        ('PK', 'Pakistan International Airlines', 'PK'),
        ('EK', 'Emirates',                        'AE'),
        ('QR', 'Qatar Airways',                   'QA'),
        ('TK', 'Turkish Airlines',                'TR'),
        ('BA', 'British Airways',                 'GB'),
        ('LH', 'Lufthansa',                       'DE'),
        ('AA', 'American Airlines',               'US'),
        ('UA', 'United Airlines',                 'US')
      ON CONFLICT (code) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO airports (code, name, city, country, tz) VALUES
        ('ISB', 'Islamabad International',   'Islamabad', 'PK', 'Asia/Karachi'),
        ('LHE', 'Allama Iqbal International','Lahore',    'PK', 'Asia/Karachi'),
        ('KHI', 'Jinnah International',      'Karachi',   'PK', 'Asia/Karachi'),
        ('DXB', 'Dubai International',       'Dubai',     'AE', 'Asia/Dubai'),
        ('DOH', 'Hamad International',       'Doha',      'QA', 'Asia/Qatar'),
        ('IST', 'Istanbul Airport',          'Istanbul',  'TR', 'Europe/Istanbul'),
        ('LHR', 'London Heathrow',           'London',    'GB', 'Europe/London'),
        ('FRA', 'Frankfurt Airport',         'Frankfurt', 'DE', 'Europe/Berlin'),
        ('JFK', 'John F. Kennedy International','New York','US', 'America/New_York')
      ON CONFLICT (code) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO cabins (code, name, rank) VALUES
        ('ECONOMY',         'Economy',          1),
        ('PREMIUM_ECONOMY', 'Premium Economy',  2),
        ('BUSINESS',        'Business',         3),
        ('FIRST',           'First',            4)
      ON CONFLICT (code) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO aircraft_types (code, name, manufacturer) VALUES
        ('A320',  'Airbus A320',        'Airbus'),
        ('A321',  'Airbus A321',        'Airbus'),
        ('B737',  'Boeing 737-800',     'Boeing'),
        ('B777',  'Boeing 777-300ER',   'Boeing'),
        ('B787',  'Boeing 787-9',       'Boeing'),
        ('ATR72', 'ATR 72-600',         'ATR')
      ON CONFLICT (code) DO NOTHING;
    `);

    // Seat maps are generated from the row/letter definition above. Letters at the
    // two ends of a row are windows, B/E are middles, the rest are aisles — which
    // is what the seat-map endpoint reports.
    const values = SEAT_MAPS.map(
      ([type, cabin, rowFrom, rowTo, letters]) =>
        `('${type}','${cabin}',${rowFrom},${rowTo},'${letters}')`
    ).join(',\n        ');

    await client.query(`
      WITH seat_rows AS (
        SELECT * FROM (VALUES
        ${values}
        ) AS t(aircraft_type, cabin, row_from, row_to, letters)
      )
      INSERT INTO seat_map_templates (aircraft_type, cabin, seat_number, seat_position, is_exit_row)
      SELECT
        r.aircraft_type,
        r.cabin,
        gs.row_no::text || ch.letter,
        CASE
          WHEN ch.letter = left(r.letters, 1) OR ch.letter = right(r.letters, 1) THEN 'WINDOW'
          WHEN ch.letter IN ('B', 'E') THEN 'MIDDLE'
          ELSE 'AISLE'
        END,
        gs.row_no IN (12, 13)
      FROM seat_rows r
      CROSS JOIN LATERAL generate_series(r.row_from, r.row_to) AS gs(row_no)
      CROSS JOIN LATERAL unnest(string_to_array(r.letters, NULL)) AS ch(letter)
      ON CONFLICT (aircraft_type, cabin, seat_number) DO NOTHING;
    `);
  }
};
