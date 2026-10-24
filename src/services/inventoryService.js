/**
 * Inventory service — the only component allowed to move a seat counter.
 *
 * Everything here runs on a caller-supplied `client` so the booking saga can compose
 * reserve + insert booking + insert payment + insert outbox event inside ONE
 * transaction. Because all four tables are distributed by `flight_id` and are
 * co-located, that transaction is a single-worker local transaction: no two-phase
 * commit, no distributed deadlock, and a rollback that is genuinely atomic.
 *
 * Two strategies, one schema:
 *
 *   single   one counter row per (flight, cabin). Simplest, and correct. Its only
 *            weakness is contention: every booking for a popular flight updates the
 *            same row, so writers queue on that row's lock.
 *   sharded  the same capacity split across N rows, selected per attempt. This is
 *            why `shard_no` is in the primary key from day one — the change is
 *            application-only, and the aggregate reads (`SUM(...) GROUP BY cabin`)
 *            are identical either way. Crucially, every shard row of a flight lives
 *            in the SAME Citus shard (the distribution key is flight_id, not the
 *            counter row), so trying several counters is still one local transaction
 *            rather than a distributed one.
 */
const env = require('../config/env');
const logger = require('../utils/logger');
const metrics = require('../observability/metrics');
const inventoryRepository = require('../repositories/inventoryRepository');
const flightRepository = require('../repositories/flightRepository');
const referenceRepository = require('../repositories/referenceRepository');
const { priceForCabin } = require('./pricingService');
const { ValidationError } = require('../utils/errors');

/** Seat-count split across N counters: the remainder spreads over the first rows. */
function splitCapacity(totalSeats, shardCount) {
  const base = Math.floor(totalSeats / shardCount);
  const remainder = totalSeats % shardCount;
  return Array.from({ length: shardCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * Creates the counter rows for a flight, one per cabin, with capacity taken from the
 * aircraft's seat-map template. Taking capacity from the template is what keeps the
 * seat map and the counter from disagreeing: the number of seats the map draws and
 * the number the counter will sell are the same number, by construction.
 *
 * Explicit `cabins` may be supplied by a loader that knows its own capacities; the
 * template is only the default.
 */
async function ensureInventoryForFlight(client, { flightId, departureDate, aircraftType, basePrice, cabins = null }) {
  const sizes = cabins || (await referenceRepository.cabinSizes(client, { aircraftType }));
  if (sizes.length === 0) {
    logger.warn('No seat-map template for aircraft type; inventory left empty', {
      flightId,
      aircraftType
    });
    return [];
  }

  const strategy = env.INVENTORY_STRATEGY;
  const shardCount = strategy === 'sharded' ? env.INVENTORY_SHARD_COUNT : 1;

  const rows = [];
  for (const entry of sizes) {
    const capacity = entry.seats !== undefined ? entry.seats : entry.totalSeats;
    if (shardCount === 1) {
      rows.push(
        await inventoryRepository.ensure(client, {
          flightId,
          departureDate,
          cabin: entry.cabin,
          shardNo: 0,
          totalSeats: capacity
        })
      );
      continue;
    }
    const shares = splitCapacity(capacity, shardCount);
    for (let shardNo = 0; shardNo < shardCount; shardNo += 1) {
      if (shares[shardNo] === 0) continue;
      rows.push(
        await inventoryRepository.ensure(client, {
          flightId,
          departureDate,
          cabin: entry.cabin,
          shardNo,
          totalSeats: shares[shardNo]
        })
      );
    }
  }
  return rows;
}

/**
 * Order in which counters are attempted in the sharded strategy.
 *
 * A random start offset spreads concurrent buyers across different rows instead of
 * having them all hammer shard 0 first. The rotation matters more than the randomness:
 * without it, a flight whose shard 0 is exhausted would make every request pay for one
 * failed UPDATE before finding a row with seats.
 */
function shardAttemptOrder(shardCount) {
  const start = Math.floor(Math.random() * shardCount);
  return Array.from({ length: shardCount }, (_, index) => (start + index) % shardCount);
}

/**
 * Reserves one seat, returning the counter row that was decremented.
 *
 * The returned `shardNo` is written onto the booking, so the later confirm/release
 * targets the exact row that was held. Without it, a release would have to guess which
 * counter to credit — and guessing wrong is how a seat counter quietly drifts.
 */
async function reserveSeat(client, { flightId, departureDate, cabin, count = 1, expectedVersion = null }) {
  const strategy = env.INVENTORY_STRATEGY;

  if (strategy !== 'sharded') {
    const result = await inventoryRepository.reserve(client, {
      flightId,
      departureDate,
      cabin,
      shardNo: 0,
      count,
      expectedVersion
    });
    metrics.recordInventoryReservation(cabin, result.reserved ? 'RESERVED' : result.reason || 'FAILED');
    if (result.reserved) return { reserved: true, shardNo: 0, inventory: result.inventory, reason: null };
    return { reserved: false, shardNo: null, inventory: result.inventory, reason: result.reason };
  }

  const shards = await inventoryRepository.listShards(client, { flightId, departureDate, cabin });
  if (shards.length === 0) {
    metrics.recordInventoryReservation(cabin, 'NO_INVENTORY');
    return { reserved: false, shardNo: null, inventory: null, reason: 'NO_INVENTORY' };
  }

  // Version pinning is a per-counter-row concept and the sharded strategy hides which
  // row holds the seats, so an expectation cannot be honoured honestly. Refusing is
  // the right answer: silently ignoring it would let a caller believe it had
  // optimistic concurrency when it did not.
  if (expectedVersion !== null && expectedVersion !== undefined) {
    throw new ValidationError(
      'Optimistic concurrency (expectedVersion) is unavailable when INVENTORY_STRATEGY=sharded; ' +
        'omit expectedVersion or switch the flight to the single-counter strategy',
      { strategy, expectedVersion }
    );
  }

  let lastReason = 'SOLD_OUT';
  let lastInventory = null;

  for (const index of shardAttemptOrder(shards.length)) {
    const shard = shards[index];
    const result = await inventoryRepository.reserve(client, {
      flightId,
      departureDate,
      cabin,
      shardNo: shard.shardNo,
      count
    });
    if (result.reserved) {
      metrics.recordInventoryReservation(cabin, 'RESERVED');
      return { reserved: true, shardNo: shard.shardNo, inventory: result.inventory, reason: null };
    }
    lastReason = result.reason;
    lastInventory = result.inventory;
    if (result.reason === 'NO_INVENTORY') break;
  }

  metrics.recordInventoryReservation(cabin, lastReason);
  return { reserved: false, shardNo: null, inventory: lastInventory, reason: lastReason };
}

/**
 * Turns a hold into a sale against the exact counter row that was decremented.
 *
 * A confirm that finds no held seats is logged for the same reason the release and
 * reclaim paths log one: it is not an error the caller can act on, but a counter whose
 * `held_seats` does not cover a booking the saga has just marked CONFIRMED has already
 * drifted, and the seat it failed to consume will show up later only as an oversell-audit
 * row. Both of the seat-returning paths warned and this one did not, which left the one
 * mutation that *consumes* a hold as the only silent way for the write model to stop
 * matching the bookings table.
 */
async function confirmSeat(client, { flightId, departureDate, cabin, shardNo = 0, count = 1 }) {
  const result = await inventoryRepository.confirm(client, { flightId, departureDate, cabin, shardNo, count });
  if (!result.confirmed) {
    logger.warn('Inventory confirm found no held seats to consume', {
      flightId,
      departureDate,
      cabin,
      shardNo,
      count
    });
  }
  return result;
}

/** Returns held seats to the pool (cancel, expiry, or saga compensation). */
async function releaseSeat(client, { flightId, departureDate, cabin, shardNo = 0, count = 1 }) {
  const result = await inventoryRepository.release(client, { flightId, departureDate, cabin, shardNo, count });
  if (!result.released) {
    // Not an error: the usual cause is a hold that already released, which the
    // `held_seats >= count` guard correctly refused to double-credit. Logged because
    // a release that repeatedly finds nothing is a symptom worth seeing.
    logger.warn('Inventory release found no held seats to return', {
      flightId,
      departureDate,
      cabin,
      shardNo,
      count
    });
  }
  return result;
}

/**
 * Returns a *confirmed* seat to the pool when a paid booking is cancelled.
 *
 * Distinct from `releaseSeat`: a confirmed seat is no longer held, so releasing it
 * would find nothing to return. See inventoryRepository.reclaim.
 */
async function reclaimSeat(client, { flightId, departureDate, cabin, shardNo = 0, count = 1 }) {
  const result = await inventoryRepository.reclaim(client, { flightId, departureDate, cabin, shardNo, count });
  if (!result.reclaimed) {
    logger.warn('Inventory reclaim found no seat to return (already reclaimed?)', {
      flightId,
      departureDate,
      cabin,
      shardNo,
      count
    });
  }
  return result;
}

/**
 * Authoritative availability, read from the write model. This is what a client should
 * check when it needs a number that is true *now*; the search endpoint reads the
 * read model, which is eventually consistent by design.
 */
async function getAvailability(client, { flightId, departureDate, cabin = null }) {
  const rows = cabin
    ? [await inventoryRepository.getCabin(client, { flightId, departureDate, cabin })].filter(Boolean)
    : await inventoryRepository.listCabins(client, { flightId, departureDate });

  const flight = await flightRepository.findById(client, { flightId, departureDate });

  return rows.map((row) => ({
    ...row,
    price: flight ? priceForCabin({ basePrice: flight.basePrice, cabin: row.cabin }) : null,
    currency: flight ? flight.currency : null
  }));
}

module.exports = {
  ensureInventoryForFlight,
  reserveSeat,
  confirmSeat,
  releaseSeat,
  reclaimSeat,
  getAvailability,
  splitCapacity,
  shardAttemptOrder
};
