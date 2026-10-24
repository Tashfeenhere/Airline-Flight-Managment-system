'use strict';
/**
 * Monthly partitioning.
 *
 * Partitions are a correctness precondition here, not an optimization: a booking is
 * inserted with its departure date, and if no partition covers that month the INSERT
 * fails. The tests therefore assert three separate things:
 *
 *   - the partitions the fixture month needs exist on every parent;
 *   - a query that names the date prunes to exactly that month (otherwise the planner
 *     would scan every month, and the partitioning would buy nothing);
 *   - a date outside the maintained horizon is rejected loudly instead of silently
 *     landing somewhere unexpected.
 */
const { DEFAULT_DEPARTURE_DATE, closePools, pool } = require('../helpers/db');

const fixtureMonth = DEFAULT_DEPARTURE_DATE.slice(0, 7).replace('-', ''); // '202612'
const WRITE_PARENTS = ['flights', 'flight_inventory', 'bookings', 'payments', 'booking_outbox'];

/** Every `Relation Name` in an EXPLAIN (FORMAT JSON) plan, depth-first. */
function relationNames(plan) {
  const names = [];
  const visit = (node) => {
    if (!node) return;
    if (node['Relation Name']) names.push(node['Relation Name']);
    for (const child of node.Plans || []) visit(child);
  };
  for (const entry of plan) visit(entry.Plan);
  return names;
}

async function explain(executor, sql) {
  const { rows } = await executor.query(`EXPLAIN (FORMAT JSON) ${sql}`);
  const raw = rows[0]['QUERY PLAN'];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

afterAll(async () => {
  await closePools();
});

describe('partition coverage', () => {
  test(`every write parent has a ${fixtureMonth} partition`, async () => {
    const { rows } = await pool.writePool.query(`
      SELECT parent.relname AS parent, child.relname AS child
        FROM pg_inherits i
        JOIN pg_class parent ON parent.oid = i.inhparent
        JOIN pg_class child  ON child.oid  = i.inhrelid
       WHERE parent.relname = ANY($1::text[])
    `, [WRITE_PARENTS]);

    const children = new Set(rows.map((row) => row.child));
    for (const parent of WRITE_PARENTS) {
      expect(children.has(`${parent}_p${fixtureMonth}`)).toBe(true);
    }
  });

  test('the read model has the same month for availability', async () => {
    const { rows } = await pool.readPool.query(`
      SELECT child.relname AS child
        FROM pg_inherits i
        JOIN pg_class parent ON parent.oid = i.inhparent
        JOIN pg_class child  ON child.oid  = i.inhrelid
       WHERE parent.relname = 'flight_availability'
    `);

    expect(rows.map((row) => row.child)).toContain(`flight_availability_p${fixtureMonth}`);
  });
});

describe('partition pruning', () => {
  test('a booking lookup by departure_date scans exactly one month', async () => {
    const plan = await explain(
      pool.writePool,
      `SELECT booking_id FROM bookings
        WHERE departure_date = DATE '${DEFAULT_DEPARTURE_DATE}'
          AND flight_id = '00000000-0000-7000-8000-000000000123'::uuid`
    );

    const scanned = relationNames(plan).filter((name) => name.startsWith('bookings_'));
    expect(scanned).toEqual([`bookings_p${fixtureMonth}`]);
  });

  test('a search read prunes the availability model to one month', async () => {
    const plan = await explain(
      pool.readPool,
      `SELECT flight_id FROM flight_availability
        WHERE origin = 'DEL' AND destination = 'BOM'
          AND departure_date = DATE '${DEFAULT_DEPARTURE_DATE}'`
    );

    const scanned = relationNames(plan).filter((name) =>
      name.startsWith('flight_availability_')
    );
    expect(scanned).toEqual([`flight_availability_p${fixtureMonth}`]);
  });
});

describe('horizon guard', () => {
  test('a departure outside every partition is rejected by the database', async () => {
    await expect(
      pool.writePool.query(`
        INSERT INTO flights (
          flight_id, flight_number, airline_code, origin, destination, departure_date,
          departure_time, arrival_time, aircraft_type, base_price
        ) VALUES (
          app_uuidv7(), 'TS-999', 'TS', 'DEL', 'BOM', DATE '2035-01-15',
          TIMESTAMPTZ '2035-01-15T08:00:00Z', TIMESTAMPTZ '2035-01-15T10:00:00Z',
          'A320', 100
        )
      `)
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('app_ensure_month_partitions is idempotent', async () => {
    // Re-running the current window may create a partition on a fresh database and
    // must create none on the second call. Either way the second answer is zero.
    const first = await pool.writePool.query(
      `SELECT app_ensure_month_partitions('bookings', 0, 0) AS created`
    );
    expect(Number(first.rows[0].created)).toBeGreaterThanOrEqual(0);

    const second = await pool.writePool.query(
      `SELECT app_ensure_month_partitions('bookings', 0, 0) AS created`
    );
    expect(Number(second.rows[0].created)).toBe(0);
  });
});
