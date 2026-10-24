'use strict';
/**
 * Shared harness for the integration and concurrency suites.
 *
 * Design rules these helpers encode — read them before writing a suite:
 *
 * 1. EVERY TEST OWNS A FRESH FLIGHT. `createFlight()` mints a UUIDv7 and books only
 *    against that id, so suites running back-to-back under `--runInBand` on one shared
 *    database never collide. Do NOT `TRUNCATE` the shared tables — that would delete the
 *    dev fixture and whatever another suite is mid-way through asserting on.
 *
 * 2. CLEAN UP WHAT YOU CREATED. `cleanupFlight()` deletes exactly one flight's rows from
 *    both the write model and the read model, child tables before parents. Call it in
 *    `afterAll` (or `afterEach`) so a thousand test runs do not grow the cluster without
 *    bound.
 *
 * 3. CLOSE THE POOLS. `pool` is a per-file singleton (jest gives each file its own module
 *    registry); a file that does not `await closePools()` in `afterAll` leaks its
 *    connections and jest hangs on exit. The pools wait for checked-out clients, so a
 *    test that throws without releasing would hang `close()` forever — never hold a
 *    client across an assertion.
 *
 * 4. DATES LIVE INSIDE THE SEEDED HORIZON. The dev cluster has monthly partitions roughly
 *    one month behind to six ahead; an insert outside that range fails loudly with "no
 *    partition of relation". `DEFAULT_DEPARTURE_DATE` sits comfortably inside it and is
 *    also recent enough that the hold reaper (which only scans a 2-day lookback by
 *    default) will consider holds on it. Override per suite when a test needs a specific
 *    month (e.g. partition pruning).
 *
 * 5. CITUS IS OPTIONAL LOCALLY. `capabilities()` reports whether the server is really
 *    Citus. A suite that asserts on shard placement or worker failure must gate on it and
 *    skip-with-reason when `citusInstalled` is false, never assert something that is only
 *    true on a multi-node cluster.
 */
const pool = require('../../src/db/pool');
const env = require('../../src/config/env');
const ids = require('../../src/utils/ids');
const flightService = require('../../src/services/flightService');
const inventoryRepository = require('../../src/repositories/inventoryRepository');
const outboxConsumer = require('../../src/workers/outboxConsumer');

/** Inside the dev partition horizon (~202609..202704) and >= the reaper lookback window. */
const DEFAULT_DEPARTURE_DATE = '2026-12-15';
/** The one aircraft type the baseline reference data (migration 009) ships a seat map for. */
const DEFAULT_AIRCRAFT = 'A320';

/**
 * Creates a flight plus its inventory counters and returns the service result
 * (`{ flightId, departureDate, cabins: [{ cabin, totalSeats, ... }] }`).
 *
 * Pass `cabins: [{ cabin, totalSeats }]` to override the aircraft template — this is how
 * the oversell test gets a deliberately tiny cabin to race against. `departureTime` is
 * pinned to UTC midnight-plus so its UTC date equals `departureDate`, which the
 * `ck_flights_departure_date` constraint requires.
 */
async function createFlight(overrides = {}) {
  const flightId = overrides.flightId || ids.newUuid();
  const departureDate = overrides.departureDate || DEFAULT_DEPARTURE_DATE;
  const input = {
    flightId,
    flightNumber: overrides.flightNumber || 'TS-100',
    airlineCode: overrides.airlineCode || 'TS',
    origin: overrides.origin || 'DEL',
    destination: overrides.destination || 'BOM',
    departureDate,
    departureTime: overrides.departureTime || `${departureDate}T08:30:00.000Z`,
    arrivalTime: overrides.arrivalTime || `${departureDate}T10:45:00.000Z`,
    aircraftType: overrides.aircraftType || DEFAULT_AIRCRAFT,
    basePrice: overrides.basePrice !== undefined ? overrides.basePrice : 10000,
    currency: overrides.currency || 'USD'
  };
  if (overrides.cabins) input.cabins = overrides.cabins;

  const flight = await flightService.upsertFlight(input);
  return { flightId, departureDate, flight };
}

/** 42P01 = undefined_table: tolerate a schema that lacks an optional table (e.g. seat_assignments). */
async function safeDelete(executor, sql, params) {
  try {
    await executor.query(sql, params);
  } catch (err) {
    if (err && err.code === '42P01') return;
    throw err;
  }
}

/**
 * Removes one flight's entire footprint from both models. Children before parents; the
 * read model is a separate database, so it is cleaned on its own pool. Idempotent — safe
 * to call for a flight whose creation half-failed.
 */
async function cleanupFlight(flightId, departureDate = DEFAULT_DEPARTURE_DATE) {
  await safeDelete(pool.writePool, 'DELETE FROM payments WHERE flight_id = $1', [flightId]);
  await safeDelete(pool.writePool, 'DELETE FROM seat_assignments WHERE flight_id = $1', [flightId]);
  await safeDelete(pool.writePool, 'DELETE FROM user_bookings WHERE flight_id = $1', [flightId]);
  await safeDelete(pool.writePool, 'DELETE FROM bookings WHERE flight_id = $1', [flightId]);
  await safeDelete(pool.writePool, 'DELETE FROM booking_outbox WHERE flight_id = $1', [flightId]);
  await safeDelete(pool.writePool, 'DELETE FROM flight_inventory WHERE flight_id = $1', [flightId]);
  await safeDelete(pool.writePool, 'DELETE FROM flights WHERE flight_id = $1', [flightId]);
  await safeDelete(pool.readPool, 'DELETE FROM flight_availability WHERE flight_id = $1', [flightId]);
}

/** Authoritative counter for one cabin, read from the write model. */
async function cabinAvailability(flightId, departureDate, cabin) {
  const result = await flightService.getAvailability({ flightId, departureDate, cabin });
  return result.cabins[0] || null;
}

/** Scoped oversell audit for one flight — the two accounting equalities the design promises. */
async function auditFlight(flightId, departureDate = null, cabin = null) {
  const result = await inventoryRepository.audit(pool.writePool, { flightId, departureDate, cabin });
  return result.violations;
}

/** Projects the outbox into the read model until it is drained (bounded). */
async function drainOutbox({ batchSize = 200, maxPasses = 50 } = {}) {
  return outboxConsumer.drain({ batchSize, maxPasses });
}

/** Whether the connected server is really Citus (and partman/uuidv7), for skip-gating. */
async function capabilities() {
  return pool.probeCapabilities();
}

/** Closes both pools. Every suite must call this in afterAll or jest will hang. */
async function closePools() {
  await pool.close();
}

module.exports = {
  pool,
  env,
  ids,
  DEFAULT_DEPARTURE_DATE,
  DEFAULT_AIRCRAFT,
  createFlight,
  cleanupFlight,
  cabinAvailability,
  auditFlight,
  drainOutbox,
  capabilities,
  closePools
};
