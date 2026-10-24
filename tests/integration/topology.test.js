'use strict';
/**
 * Cluster topology and per-node connectivity.
 *
 * Locally the suite may be pointed at plain PostgreSQL; in CI/compose it runs against
 * a Citus coordinator and two workers. Rather than assuming one or the other, the
 * suite separates what must be true EVERYWHERE (both pools answer, capability probing
 * works, the topology report is honest) from what is only true on a distributed
 * cluster (distribution keys, co-location, worker reachability, one-worker-down
 * availability). The latter assertions run only when workers are actually attached,
 * and say so when they are skipped.
 *
 * The worker-down case is opt-in (`CITUS_CHAOS=1`) because it changes cluster state:
 * it disables one worker, proves the unaffected shard still sells, and re-enables the
 * worker in a `finally`. The plan's chaos requirement is met by this test plus
 * `scripts/chaos-worker-down.js`, which runs the same idea against a composed cluster.
 */
const { createFlight, cleanupFlight, closePools, pool, env } = require('../helpers/db');
const citus = require('../../src/db/citus');
const bookingService = require('../../src/services/bookingService');

const createdFlights = [];
let state = null;

beforeAll(async () => {
  state = await citus.distributionState(pool.writePool);
});

afterEach(async () => {
  for (const fixture of createdFlights.splice(0)) {
    await cleanupFlight(fixture.flightId, fixture.departureDate);
  }
});

afterAll(async () => {
  await closePools();
});

describe('pool connectivity', () => {
  test('the write pool reaches the coordinator', async () => {
    const { rows } = await pool.writePool.query(
      'SELECT 1 AS ok, current_database() AS db, current_user AS usr'
    );
    expect(rows[0].ok).toBe(1);
    expect(rows[0].db).toEqual(expect.any(String));
  });

  test('the read pool reaches the read-model database', async () => {
    const { rows } = await pool.readPool.query(
      "SELECT 1 AS ok, to_regclass('flight_availability') IS NOT NULL AS has_projection"
    );
    expect(rows[0].ok).toBe(1);
    expect(rows[0].has_projection).toBe(true);
  });

  test('capability probing reports every optional extension', async () => {
    const caps = await pool.probeCapabilities();
    expect(typeof caps.citusInstalled).toBe('boolean');
    expect(typeof caps.partmanInstalled).toBe('boolean');
    expect(typeof caps.nativeUuidv7).toBe('boolean');
    expect(caps.serverVersionNum).toBeGreaterThan(0);
  });
});

describe('Citus distribution', () => {
  test('the flight family is distributed by flight_id into one co-location group', async () => {
    if (!state.canDistribute) {
      console.warn(
        `Skipping distribution assertions: Citus installed=${state.citusInstalled}, ` +
          `active workers=${state.activeWorkers}`
      );
      return;
    }

    const { rows } = await pool.writePool.query(`
      SELECT c.relname AS table_name,
             p.partmethod,
             p.colocationid,
             column_to_column_name(p.logicalrelid, p.partkey) AS distribution_column
        FROM pg_dist_partition p
        JOIN pg_class c ON c.oid = p.logicalrelid
       WHERE c.relname = ANY($1::text[])
    `, [['flights', 'flight_inventory', 'bookings', 'payments', 'booking_outbox', 'user_bookings', 'users']]);

    const byName = new Map(rows.map((row) => [row.table_name, row]));
    const flightTables = ['flights', 'flight_inventory', 'bookings', 'payments', 'booking_outbox'];

    for (const table of flightTables) {
      const entry = byName.get(table);
      expect(entry).toBeDefined();
      expect(entry.distribution_column).toBe('flight_id');
    }

    // Co-location is what keeps a booking on ONE worker: reserve, insert booking,
    // payment and outbox all hash `flight_id` to the same shard placement.
    const colocationIds = new Set(flightTables.map((table) => byName.get(table).colocationid));
    expect(colocationIds.size).toBe(1);

    const userBookings = byName.get('user_bookings');
    expect(userBookings.distribution_column).toBe('user_id');

    // `users` is a reference table (partmethod 'n'), replicated to every worker, so
    // authentication is a local read even at 100k accounts.
    const users = byName.get('users');
    expect(users.partmethod).toBe('n');
  });

  test('every active worker answers a query from the coordinator', async () => {
    if (!state.canDistribute) {
      console.warn('Skipping worker reachability: no active Citus workers');
      return;
    }

    const { rows } = await pool.writePool.query(
      `SELECT nodename, nodeport, success, result
         FROM run_command_on_workers('SELECT 1')`
    );

    expect(rows.length).toBeGreaterThanOrEqual(state.activeWorkers);
    for (const row of rows) {
      expect(row.success).toBe(true);
      expect(String(row.result)).toBe('1');
    }
  });
});

describe('worker-down availability (opt-in chaos)', () => {
  test('a booking on an unaffected shard still succeeds while one worker is disabled', async () => {
    if (process.env.CITUS_CHAOS !== '1') {
      console.warn('Skipping worker-down test: set CITUS_CHAOS=1 to run it');
      return;
    }
    if (!state.canDistribute || state.activeWorkers < 2) {
      console.warn('Skipping worker-down test: needs a Citus cluster with at least two workers');
      return;
    }

    const fixture = await createFlight({ cabins: [{ cabin: 'ECONOMY', totalSeats: 2 }] });
    createdFlights.push(fixture);

    // Find where this flight's shard lives, then disable a worker that does NOT host
    // it. Disabling a different worker proves the cluster is not globally serialized
    // behind the failed node — unrelated shards keep selling.
    const shard = await pool.writePool.query(
      `SELECT get_shard_id_for_distribution_column('flights', $1::uuid) AS shard_id`,
      [fixture.flightId]
    );
    const shardId = shard.rows[0].shard_id;

    const placements = await pool.writePool.query(
      `SELECT n.nodeid, n.nodename, n.nodeport
         FROM pg_dist_placement p
         JOIN pg_dist_node n ON n.groupid = p.groupid
        WHERE p.shardid = $1 AND n.isactive AND n.noderole = 'primary'`,
      [shardId]
    );
    const hosting = new Set(placements.rows.map((row) => Number(row.nodeid)));

    const workers = await pool.writePool.query(
      `SELECT nodeid, nodename, nodeport
         FROM pg_dist_node
        WHERE isactive AND noderole = 'primary' AND groupid <> 0
        ORDER BY nodeid`
    );
    const victim = workers.rows.find((row) => !hosting.has(Number(row.nodeid)));
    if (!victim) {
      console.warn('Skipping worker-down test: every worker hosts a placement of the chosen shard');
      return;
    }

    let disabled = false;
    try {
      // `citus_disable_node` returns void; the observable post-condition is that the
      // node is gone from the active set, which the booking below exercises.
      await pool.writePool.query(
        `SELECT citus_disable_node($1, $2)`,
        [victim.nodename, Number(victim.nodeport)]
      );
      disabled = true;

      const booked = await bookingService.createBooking({
        userId: env.GUEST_USER_ID,
        flightId: fixture.flightId,
        cabin: 'ECONOMY',
        passengerName: 'Chaos Passenger'
      });
      expect(booked.booking.status).toBe('CONFIRMED');
    } finally {
      if (disabled) {
        await pool.writePool.query(
          `SELECT citus_enable_node($1, $2)`,
          [victim.nodename, Number(victim.nodeport)]
        );
      }
    }
  });
});
