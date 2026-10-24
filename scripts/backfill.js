#!/usr/bin/env node
'use strict';
/**
 * `npm run backfill` — the P9 bulk loader for flights, inventory and users.
 *
 * This is the in-repo implementation of the pipeline described in
 * `docs/DATA_LOADING.md` and `docs/MIGRATION_FROM_MONGODB.md`. It loads in
 * `departure_date` order, in bounded batches, with a checkpoint after every batch,
 * idempotent upserts, and partitions created before the first row lands. That makes
 * a crashed or throttled run resumable instead of a restart from zero.
 *
 * TWO SOURCES, ONE PIPELINE
 *
 *   synthetic   Deterministic schedules generated from a seed-free formula. Use it to
 *               prove the system at volume (1M+ flights) and to exercise the read
 *               model, because there is no schedule feed in this repository.
 *   ndjson      Newline-delimited JSON exports of the legacy MongoDB collections:
 *               `users.ndjson`, `flights.ndjson`, `bookings.ndjson`. Field mapping is
 *               the one documented in `docs/MIGRATION_FROM_MONGODB.md`; ObjectIds are
 *               mapped to a deterministic UUIDv5 so re-running produces the same ids.
 *
 * WHY BATCHES AND `ON CONFLICT`
 *
 * A loader is run at least twice in its life: after the first crash, and after the
 * bug fix. Every write here is therefore idempotent — flights upsert on
 * `(flight_id, departure_date)`, counters use `DO NOTHING` so a re-run never resets
 * live counts, and outbox events carry deterministic ids. The checkpoint is an
 * optimization (skip work already done), not the correctness mechanism.
 *
 * INVENTORY AND HISTORICAL BOOKINGS
 *
 * A flight is only sellable if a `flight_inventory` row exists: the reserve statement
 * updates that row and zero rows means `SOLD_OUT`. So inventory is loaded with the
 * flights, with `available_seats` taken from the source when it supplies one (legacy
 * `availableSeats`) and equal to capacity otherwise.
 *
 * When `bookings.ndjson` is present, historical bookings are inserted read-only and the
 * counters of their flights are recomputed to `total - CONFIRMED bookings`. That keeps
 * the audit invariant (`available + held + confirmed = total`) true after the import,
 * which naive "insert bookings without touching counters" does not. Run this leg before
 * the application starts serving traffic: it rewrites `available_seats` for the flights
 * it touches.
 *
 * WHAT THIS SCRIPT DOES NOT DO
 *
 * It is not a streaming replacement for a 50M-row `COPY` load. Each batch is a
 * coordinator round trip and the rows are materialized as JS arrays. For the full
 * production volume use the COPY-based path in `docs/DATA_LOADING.md`; this script is
 * the correct tool for the 1M-flight verification target, fixtures, re-imports and the
 * legacy cutover.
 *
 * USAGE
 *
 *   node scripts/backfill.js --source synthetic --start 2026-11-01 --days 30 \
 *                            --flights-per-day 100 --batch-size 500 --outbox
 *   node scripts/backfill.js --source ndjson --input ./mongo-export --reproject
 *   node scripts/backfill.js --source synthetic --dry-run
 *
 * Exit codes: 0 success, 1 a load failed, 2 bad usage. `--json` prints the summary on
 * stdout as JSON.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const pool = require('../src/db/pool');
const logger = require('../src/utils/logger');
const partitions = require('../src/db/partitions');
const flightRepository = require('../src/repositories/flightRepository');
const projectionService = require('../src/services/projectionService');
const { priceForCabin } = require('../src/services/pricingService');
const { OUTBOX_EVENT_TYPES } = require('../src/config/constants');

/** Default checkpoint lives under `tmp/`, which is git-ignored. */
const DEFAULT_CHECKPOINT = path.join('tmp', 'backfill.checkpoint.json');
const CHECKPOINT_VERSION = 1;

/** UUIDv5 namespace for deterministic backfill ids. Never used by the app at runtime. */
const BACKFILL_NAMESPACE = 'b4c6f1e2-0000-5000-8000-000000000001';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5000;

/**
 * Synthetic routes. Airline/airport codes are the ones migration 009 seeds, so the
 * data-quality validator does not report orphans. Durations are block times.
 */
const SYNTHETIC_ROUTES = Object.freeze([
  { airlineCode: 'PK', origin: 'ISB', destination: 'DXB', minutes: 210, price: 180 },
  { airlineCode: 'PK', origin: 'LHE', destination: 'DXB', minutes: 195, price: 165 },
  { airlineCode: 'QR', origin: 'KHI', destination: 'DOH', minutes: 150, price: 210 },
  { airlineCode: 'EK', origin: 'DXB', destination: 'LHR', minutes: 470, price: 640 },
  { airlineCode: 'TK', origin: 'IST', destination: 'FRA', minutes: 195, price: 240 },
  { airlineCode: 'BA', origin: 'LHR', destination: 'JFK', minutes: 465, price: 720 },
  { airlineCode: 'AA', origin: 'JFK', destination: 'FRA', minutes: 455, price: 690 },
  { airlineCode: 'LH', origin: 'FRA', destination: 'IST', minutes: 185, price: 230 }
]);

/** Rotated so every load exercises single- and multi-cabin aircraft. */
const SYNTHETIC_AIRCRAFT = Object.freeze(['A320', 'A321', 'B737', 'B777', 'B787', 'ATR72']);

/** Unknown-to-the-schema statuses in a legacy export are mapped, never invented. */
const LEGACY_STATUS = Object.freeze({
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  DEPARTED: 'DEPARTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
});

/** A placeholder that `verifyPassword` treats as "cannot log in"; forces a reset. */
const IMPORTED_PASSWORD_HASH = '!imported-account-reset-required';

const USAGE = `
backfill — load flights, inventory, users and historical bookings in batches.

Usage:
  node scripts/backfill.js [options]

Source:
  --source <name>           synthetic | ndjson (default synthetic).
  --input <dir>             For ndjson: directory holding users.ndjson, flights.ndjson
                            and bookings.ndjson (any of the three may be absent).

Synthetic:
  --start <YYYY-MM-DD>      First departure date, UTC (default: tomorrow).
  --days <n>                Number of departure dates to generate (default 30).
  --flights-per-day <n>     Flights per date (default 100).

Loading:
  --batch-size <n>          Rows per transaction (default ${DEFAULT_BATCH_SIZE}, max ${MAX_BATCH_SIZE}).
  --limit <n>               Stop after n rows processed this run (0 = no limit).
  --throttle-ms <n>         Sleep between batches (default 0).
  --outbox                  Emit one deterministic FLIGHT_UPSERTED event per flight.
                            Default: on for synthetic, off for ndjson (the legacy bulk
                            path leaves projection to an explicit step).
  --no-outbox               Disable outbox emission.
  --reproject               Replay emitted events into the read model after loading.
  --strict                  Abort on the first invalid source row instead of skipping it.

Checkpoint:
  --checkpoint <file>       Checkpoint path (default ${DEFAULT_CHECKPOINT}).
  --no-resume               Ignore an existing checkpoint and start from the beginning.
  --reset-checkpoint        Delete the checkpoint, then start from the beginning.
  --dry-run                 Report the plan and validate options; write nothing.

General:
  --json                    Print the summary as JSON.
  -h, --help                Show this help.

Exit codes: 0 success, 1 load failure, 2 usage error.
`;

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    source: 'synthetic',
    input: null,
    start: null,
    days: 30,
    flightsPerDay: 100,
    batchSize: DEFAULT_BATCH_SIZE,
    limit: 0,
    throttleMs: 0,
    outbox: null,
    reproject: false,
    strict: false,
    checkpoint: DEFAULT_CHECKPOINT,
    resume: true,
    resetCheckpoint: false,
    dryRun: false,
    json: false,
    help: false
  };

  const value = (name, next) => {
    if (next === undefined || String(next).startsWith('--')) {
      throw new UsageError(`--${name} requires a value`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--') && raw !== '-h') throw new UsageError(`Unexpected argument: ${raw}`);

    const [flag, inline] = raw.split('=', 2);
    const next = inline !== undefined ? inline : argv[i + 1];
    const take = () => {
      if (inline !== undefined) return inline;
      i += 1;
      return value(flag.slice(2), next);
    };

    switch (flag) {
      case '--source': opts.source = String(take()); break;
      case '--input': opts.input = String(take()); break;
      case '--start': opts.start = String(take()); break;
      case '--days': opts.days = parseInteger(flag, take(), 0, 100000); break;
      case '--flights-per-day': opts.flightsPerDay = parseInteger(flag, take(), 0, 100000); break;
      case '--batch-size': opts.batchSize = parseInteger(flag, take(), 1, MAX_BATCH_SIZE); break;
      case '--limit': opts.limit = parseInteger(flag, take(), 0, Number.MAX_SAFE_INTEGER); break;
      case '--throttle-ms': opts.throttleMs = parseInteger(flag, take(), 0, 600000); break;
      case '--outbox': opts.outbox = true; break;
      case '--no-outbox': opts.outbox = false; break;
      case '--reproject': opts.reproject = true; break;
      case '--strict': opts.strict = true; break;
      case '--checkpoint': opts.checkpoint = String(take()); break;
      case '--no-resume': opts.resume = false; break;
      case '--reset-checkpoint': opts.resetCheckpoint = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default: throw new UsageError(`Unknown option: ${flag}`);
    }
  }

  if (!['synthetic', 'ndjson'].includes(opts.source)) {
    throw new UsageError(`--source must be synthetic or ndjson, got "${opts.source}"`);
  }
  if (opts.source === 'ndjson' && !opts.input) {
    throw new UsageError('--source ndjson requires --input <dir>');
  }
  if (opts.outbox === null) opts.outbox = opts.source === 'synthetic';
  if (opts.reproject && !opts.outbox) {
    throw new UsageError('--reproject replays outbox events; it cannot be combined with --no-outbox');
  }
  if (opts.start && !/^\d{4}-\d{2}-\d{2}$/.test(opts.start)) {
    throw new UsageError(`--start must be YYYY-MM-DD, got "${opts.start}"`);
  }

  opts.start = opts.start || tomorrowUtc();
  opts.batchSize = Math.min(opts.batchSize, MAX_BATCH_SIZE);
  return opts;
}

function parseInteger(flag, raw, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || String(n) !== String(raw).trim() || n < min || n > max) {
    throw new UsageError(`${flag} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Dates and deterministic ids
// ---------------------------------------------------------------------------

function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateKey(date) {
  return utcMidnight(date).toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(utcMidnight(date).getTime() + days * DAY_MS);
}

function tomorrowUtc() {
  return dateKey(addDays(new Date(), 1));
}

/** Calendar-month difference from `from` to `to` (positive when `to` is later). */
function monthDiff(from, to) {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

/**
 * RFC 4122 UUIDv5: SHA-1 over the namespace bytes and the name, with the version and
 * variant nibbles overwritten. Deterministic across runs, processes and machines —
 * which is what makes "re-run the import" idempotent for ids the loader mints.
 */
function uuidv5(name, namespace = BACKFILL_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(String(name), 'utf8')])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `BK-` + 10 Crockford characters, matching the application's reference shape. */
function bookingReference(seed) {
  const digest = crypto.createHash('sha256').update(`reference:${seed}`).digest();
  let out = '';
  for (let i = 0; i < 10; i += 1) out += CROCKFORD[digest[i] % 32];
  return `BK-${out}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deterministic id for a legacy document. The collection name is part of the seed so
 * a flight ObjectId and a booking ObjectId with the same textual value cannot collide,
 * and the flight importer and the booking importer derive the SAME uuid for the same
 * legacy flight — the property that lets bookings find their flight after both were
 * mapped independently.
 */
function legacyUuid(collection, value, fallbackSeed) {
  if (typeof value === 'string' && UUID_RE.test(value)) return value.toLowerCase();
  if (value === undefined || value === null || value === '') return uuidv5(`${collection}:${fallbackSeed}`);
  return uuidv5(`legacy:${collection}:${String(value)}`);
}

/** Mongo extended JSON (`{"$date": "..."}`) is accepted alongside plain ISO strings. */
function asInstant(value) {
  if (value && typeof value === 'object' && value.$date !== undefined) return asInstant(value.$date);
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function asNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' && value.$numberLong !== undefined) return asNumber(value.$numberLong, fallback);
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Reference data and partition precondition
// ---------------------------------------------------------------------------

/**
 * Cabin capacities from the seat-map templates, which are the same rows the API serves
 * a seat map from. A synthetic flight therefore cannot advertise a capacity the seat
 * map does not have. Cached because the loader asks once per aircraft type.
 */
async function loadTemplateCapacities() {
  const { rows } = await pool.writePool.query(`
    SELECT aircraft_type, cabin, count(*)::int AS total_seats
      FROM seat_map_templates
     GROUP BY aircraft_type, cabin
     ORDER BY aircraft_type, min(seat_number)
  `);

  const byType = new Map();
  for (const row of rows) {
    if (!byType.has(row.aircraft_type)) byType.set(row.aircraft_type, []);
    byType.get(row.aircraft_type).push({ cabin: row.cabin, totalSeats: Number(row.total_seats) });
  }
  return byType;
}

/**
 * Creates every month partition the batch's dates require, on both the write model and
 * (for projection) the read model. `app_ensure_month_partitions` works on a window
 * relative to *today*, so the window is derived from the actual min/max months; loading
 * a past month widens `monthsBehind`, loading a future month widens `monthsAhead`.
 */
async function ensurePartitionsForDates(dates, { includeReadModel }) {
  if (dates.length === 0) return;

  const months = [...new Set(dates.map((date) => date.slice(0, 7)))].sort();
  const first = new Date(`${months[0]}-01T00:00:00.000Z`);
  const last = new Date(`${months[months.length - 1]}-01T00:00:00.000Z`);
  const now = new Date();
  const nowMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const window = {
    monthsBehind: Math.max(0, monthDiff(first, nowMonth)),
    monthsAhead: Math.max(0, monthDiff(nowMonth, last))
  };

  await partitions.ensurePartitions(pool.writePool, {
    parents: partitions.WRITE_PARENTS,
    ...window
  });

  if (includeReadModel) {
    await partitions.ensurePartitions(pool.readPool, {
      parents: partitions.READ_PARENTS,
      ...window
    });
  }
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

async function readCheckpoint(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (parsed.version !== CHECKPOINT_VERSION) return null;
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Write-to-temp-then-rename, so a crash mid-write never leaves a truncated checkpoint. */
async function writeCheckpoint(file, state) {
  await fsp.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Batch writes
// ---------------------------------------------------------------------------

const INVENTORY_BATCH_SQL = `
  INSERT INTO flight_inventory (
    flight_id, departure_date, cabin, shard_no, total_seats, available_seats, held_seats
  )
  SELECT f.flight_id, f.departure_date, f.cabin, 0, f.total_seats, f.available_seats, 0
    FROM unnest($1::uuid[], $2::date[], $3::text[], $4::int[], $5::int[])
      AS f(flight_id, departure_date, cabin, total_seats, available_seats)
  ON CONFLICT (flight_id, departure_date, cabin, shard_no) DO NOTHING
`;

const OUTBOX_BATCH_SQL = `
  INSERT INTO booking_outbox (
    event_id, flight_id, departure_date, event_type, aggregate_id, user_id, payload
  )
  SELECT e.event_id, e.flight_id, e.departure_date, $5, e.flight_id, NULL, e.payload::jsonb
    FROM unnest($1::uuid[], $2::uuid[], $3::date[], $4::text[])
      AS e(event_id, flight_id, departure_date, payload)
  ON CONFLICT (flight_id, departure_date, event_id) DO NOTHING
`;

const BOOKING_BATCH_SQL = `
  INSERT INTO bookings (
    booking_id, booking_reference, flight_id, departure_date, user_id, cabin,
    inventory_shard, seat_number, passenger_name, passenger_ref, status, price,
    currency, idempotency_key, hold_expires_at, node_id, transaction_id, payment_id,
    confirmed_at, cancelled_at, cancellation_reason, created_at, updated_at
  )
  SELECT b.booking_id, b.booking_reference, b.flight_id, b.departure_date, b.user_id,
         b.cabin, 0, b.seat_number, b.passenger_name, b.passenger_ref, b.status, b.price,
         b.currency, b.idempotency_key, NULL, b.node_id, b.transaction_id,
         b.payment_id,
         CASE WHEN b.status = 'CONFIRMED' THEN b.created_at END,
         CASE WHEN b.status = 'CANCELLED' THEN b.created_at END,
         CASE WHEN b.status = 'CANCELLED' THEN 'IMPORTED_CANCELLED' END,
         b.created_at, b.updated_at
    FROM unnest(
      $1::uuid[], $2::text[], $3::uuid[], $4::date[], $5::uuid[], $6::text[],
      $7::text[], $8::text[], $9::text[], $10::text[], $11::numeric[], $12::text[],
      $13::text[], $14::text[], $15::uuid[], $16::uuid[], $17::timestamptz[],
      $18::timestamptz[]
    ) AS b(
      booking_id, booking_reference, flight_id, departure_date, user_id, cabin,
      seat_number, passenger_name, passenger_ref, status, price, currency,
      idempotency_key, node_id, transaction_id, payment_id, created_at, updated_at
    )
  ON CONFLICT DO NOTHING
`;

const PAYMENT_BATCH_SQL = `
  INSERT INTO payments (
    payment_id, flight_id, departure_date, booking_id, amount, currency, provider,
    status, saga_state, provider_reference, idempotency_key, captured_at,
    created_at, updated_at
  )
  SELECT p.payment_id, p.flight_id, p.departure_date, p.booking_id, p.amount,
         p.currency, 'SIMULATED', 'CAPTURED', 'CAPTURED', p.provider_reference,
         p.idempotency_key, p.captured_at, p.captured_at, p.captured_at
    FROM unnest(
      $1::uuid[], $2::uuid[], $3::date[], $4::uuid[], $5::numeric[], $6::text[],
      $7::text[], $8::text[], $9::timestamptz[]
    ) AS p(payment_id, flight_id, departure_date, booking_id, amount, currency,
           provider_reference, idempotency_key, captured_at)
  ON CONFLICT DO NOTHING
`;

/** One `flight_upserted` snapshot per flight, shaped exactly as the projector expects. */
function outboxEventFor(flight, cabins) {
  const flightId = flight.flightId;
  const departureDate = flight.departureDate;
  return {
    eventId: uuidv5(`event:FLIGHT_UPSERTED:${flightId}:${departureDate}`),
    flightId,
    departureDate,
    payload: {
      flight: {
        flightId,
        flightNumber: flight.flightNumber,
        airlineCode: flight.airlineCode,
        origin: flight.origin,
        destination: flight.destination,
        aircraftType: flight.aircraftType,
        departureTime: flight.departureTime,
        arrivalTime: flight.arrivalTime,
        basePrice: flight.basePrice,
        currency: flight.currency || 'USD',
        status: flight.status || 'SCHEDULED'
      },
      cabins: cabins.map((cabin) => ({
        cabin: cabin.cabin,
        totalSeats: cabin.totalSeats,
        availableSeats: cabin.availableSeats,
        heldSeats: 0,
        version: 0,
        price: Number(priceForCabin({ basePrice: flight.basePrice, cabin: cabin.cabin })),
        currency: flight.currency || 'USD'
      }))
    }
  };
}

/** Writes one batch of flights and their inventory in a single transaction. */
async function writeFlightBatch(flights, { outbox }) {
  if (flights.length === 0) return { flights: 0, inventory: 0, outbox: 0 };

  return pool.withTransaction(async (client) => {
    const saved = await flightRepository.upsertMany(client, flights);

    const inventory = flights.flatMap((flight) => flight.cabins.map((cabin) => ({ flight, cabin })));
    if (inventory.length > 0) {
      await client.query(INVENTORY_BATCH_SQL, [
        inventory.map((entry) => entry.flight.flightId),
        inventory.map((entry) => entry.flight.departureDate),
        inventory.map((entry) => entry.cabin.cabin),
        inventory.map((entry) => Number(entry.cabin.totalSeats)),
        inventory.map((entry) => Number(entry.cabin.availableSeats))
      ]);
    }

    let emitted = 0;
    if (outbox) {
      const events = saved.map((flight, index) => outboxEventFor(flight, flights[index].cabins));
      await client.query(OUTBOX_BATCH_SQL, [
        events.map((event) => event.eventId),
        events.map((event) => event.flightId),
        events.map((event) => event.departureDate),
        events.map((event) => JSON.stringify(event.payload)),
        OUTBOX_EVENT_TYPES.FLIGHT_UPSERTED
      ]);
      emitted = events.length;
    }

    return { flights: saved.length, inventory: inventory.length, outbox: emitted };
  });
}

// ---------------------------------------------------------------------------
// Synthetic source
// ---------------------------------------------------------------------------

/**
 * Synthetic row for global index `i`. Every field is a pure function of the index and
 * the start date, so resume is exact and two runs cannot disagree about a flight.
 */
function syntheticFlight(i, startDate, flightsPerDay, templateCapacities) {
  const dayIndex = Math.floor(i / flightsPerDay);
  const withinDay = i % flightsPerDay;
  const route = SYNTHETIC_ROUTES[i % SYNTHETIC_ROUTES.length];
  const aircraftType = SYNTHETIC_AIRCRAFT[i % SYNTHETIC_AIRCRAFT.length];

  const departure = addDays(startDate, dayIndex);
  // Spread departures across the day so two flights on one route do not share a time.
  departure.setUTCHours(6 + (withinDay % 12), (withinDay * 7) % 60, 0, 0);
  const arrival = new Date(departure.getTime() + route.minutes * 60 * 1000);

  const template = templateCapacities.get(aircraftType);
  if (!template || template.length === 0) {
    throw new Error(`No seat_map_templates for aircraft type ${aircraftType}; run db:migrate`);
  }

  const flightId = uuidv5(`synthetic:${dateKey(startDate)}:${dayIndex}:${withinDay}`);
  const basePrice = route.price + (withinDay % 5) * 10;

  return {
    flightId,
    flightNumber: `${route.airlineCode}${1000 + (i % 9000)}`,
    airlineCode: route.airlineCode,
    origin: route.origin,
    destination: route.destination,
    departureDate: dateKey(departure),
    departureTime: departure.toISOString(),
    arrivalTime: arrival.toISOString(),
    aircraftType,
    basePrice,
    currency: 'USD',
    status: 'SCHEDULED',
    cabins: template.map((cabin) => ({
      cabin: cabin.cabin,
      totalSeats: cabin.totalSeats,
      availableSeats: cabin.totalSeats
    }))
  };
}

async function runSynthetic(opts, state, summary) {
  const startDate = new Date(`${opts.start}T00:00:00.000Z`);
  const total = opts.days * opts.flightsPerDay;
  const templateCapacities = await loadTemplateCapacities();
  const plan = {
    source: 'synthetic',
    start: opts.start,
    days: opts.days,
    flightsPerDay: opts.flightsPerDay,
    totalFlights: total,
    fromIndex: state.nextIndex || 0
  };

  if (opts.dryRun) return { ...summary, plan };

  const firstIndex = Math.min(state.nextIndex || 0, total);
  const stopIndex = opts.limit > 0 ? Math.min(total, firstIndex + opts.limit) : total;

  for (let offset = firstIndex; offset < stopIndex; offset += opts.batchSize) {
    const end = Math.min(offset + opts.batchSize, stopIndex);
    const batch = [];
    for (let i = offset; i < end; i += 1) {
      batch.push(syntheticFlight(i, startDate, opts.flightsPerDay, templateCapacities));
    }

    await ensurePartitionsForDates(batch.map((flight) => flight.departureDate), {
      includeReadModel: opts.outbox
    });
    const written = await writeFlightBatch(batch, { outbox: opts.outbox });

    summary.processed.flights += written.flights;
    summary.processed.inventoryRows += written.inventory;
    summary.processed.outboxEvents += written.outbox;
    state.nextIndex = end;
    await writeCheckpoint(opts.checkpoint, state);

    reportProgress(summary, opts, `synthetic flights ${end}/${total}`);
    if (opts.throttleMs > 0 && end < stopIndex) await sleep(opts.throttleMs);
  }

  return { ...summary, plan };
}

// ---------------------------------------------------------------------------
// NDJSON source
// ---------------------------------------------------------------------------

/** Streams a JSONL file, skipping `skip` lines and invoking `onRow` for the rest. */
async function streamJsonl(file, { skip = 0, onRow }) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  let processed = 0;
  let invalid = 0;

  for await (const line of rl) {
    lineNumber += 1;
    if (lineNumber <= skip) continue;
    if (line.trim() === '') continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      invalid += 1;
      onRow(null, { lineNumber, error: `invalid JSON: ${err.message}` });
      continue;
    }

    await onRow(row, { lineNumber });
    processed += 1;
  }

  return { linesRead: lineNumber, processed, invalid };
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch (err) {
    return false;
  }
}

function normaliseLegacyFlight(row, context) {
  const departureTime = asInstant(row.departureTime ?? row.departure_time);
  const arrivalTime = asInstant(row.arrivalTime ?? row.arrival_time);
  if (!departureTime || !arrivalTime) throw new Error('departureTime and arrivalTime are required');
  if (arrivalTime <= departureTime) throw new Error('arrivalTime must be after departureTime');

  const origin = String(row.origin || '').toUpperCase();
  const destination = String(row.destination || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) {
    throw new Error('origin and destination must be 3-letter IATA codes');
  }
  if (origin === destination) throw new Error('origin and destination must differ');

  const flightNumber = String(row.flightNumber ?? row.flight_number ?? '').trim();
  if (!flightNumber) throw new Error('flightNumber is required');

  const airlineCode = String(
    // A legacy flight number is `<airline letters><digits>` (PK321). Match the leading
    // LETTERS only: a `/^[A-Za-z0-9]{2,3}/` pattern turns PK321 into "PK3".
    row.airlineCode ?? row.airline_code ?? flightNumber.match(/^[A-Za-z]{2,3}/)?.[0] ?? 'PK'
  ).toUpperCase();
  const aircraftType = String(row.aircraftType ?? row.aircraft_type ?? context.defaultAircraftType);
  const legacyId = row._id !== undefined ? row._id : row.id;

  const flightId = legacyUuid(
    'flights',
    row.flightId ?? row.flight_id ?? legacyId,
    `flight:${flightNumber}:${dateKey(departureTime)}`
  );
  const departureDate = dateKey(departureTime);

  // Cabin capacities: an explicit array wins; the legacy single `totalSeats` becomes
  // one ECONOMY counter, which is the only cabin the prototype had.
  let cabins;
  if (Array.isArray(row.cabins) && row.cabins.length > 0) {
    cabins = row.cabins.map((cabin) => ({
      cabin: String(cabin.cabin).toUpperCase(),
      totalSeats: Math.max(0, Math.trunc(asNumber(cabin.totalSeats ?? cabin.seats, 0))),
      availableSeats: Math.max(
        0,
        Math.trunc(asNumber(cabin.availableSeats, asNumber(cabin.totalSeats ?? cabin.seats, 0)))
      )
    }));
  } else {
    const totalSeats = Math.max(0, Math.trunc(asNumber(row.totalSeats, context.defaultEconomySeats)));
    cabins = [{
      cabin: 'ECONOMY',
      totalSeats,
      availableSeats: Math.max(0, Math.trunc(asNumber(row.availableSeats, totalSeats)))
    }];
  }

  // The CHECK constraint allows available + held <= total; clamp a bad source value
  // rather than aborting the whole load on one inconsistent historical counter.
  for (const cabin of cabins) {
    if (cabin.availableSeats > cabin.totalSeats) cabin.availableSeats = cabin.totalSeats;
  }

  const status = LEGACY_STATUS[String(row.status || 'SCHEDULED').toUpperCase()];
  if (!status) throw new Error(`unknown flight status "${row.status}"`);

  return {
    flightId,
    flightNumber,
    airlineCode,
    origin,
    destination,
    departureDate,
    departureTime: departureTime.toISOString(),
    arrivalTime: arrivalTime.toISOString(),
    aircraftType,
    basePrice: Math.max(0, asNumber(row.price ?? row.basePrice ?? row.base_price, 0)),
    currency: String(row.currency || 'USD').toUpperCase(),
    status,
    cabins
  };
}

async function runNdjsonUsers(opts, state, summary) {
  const file = path.join(opts.input, 'users.ndjson');
  if (!(await fileExists(file))) return;

  let batch = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    await pool.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, password_hash, role, full_name, phone, is_active)
         SELECT u.id, u.email, $6, u.role, u.full_name, u.phone, TRUE
           FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])
             AS u(id, email, role, full_name, phone)
         ON CONFLICT DO NOTHING`,
        [
          current.map((user) => user.id),
          current.map((user) => user.email),
          current.map((user) => user.role),
          current.map((user) => user.fullName),
          current.map((user) => user.phone),
          IMPORTED_PASSWORD_HASH
        ]
      );
    });
    summary.processed.users += current.length;
    await writeCheckpoint(opts.checkpoint, state);
  };

  const offset = state.offsets.users || 0;
  await streamJsonl(file, {
    skip: offset,
    onRow: async (row, meta) => {
      if (!row) return recordInvalid(summary, opts, 'users', meta);
      const email = String(row.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) return recordInvalid(summary, opts, 'users', { ...meta, error: 'invalid email' });
      const legacyId = row._id !== undefined ? row._id : row.id;
      batch.push({
        id: legacyUuid('users', row.userId ?? row.id ?? legacyId, `user:${email}`),
        email,
        role: ['PASSENGER', 'AGENT', 'ADMIN'].includes(String(row.role).toUpperCase())
          ? String(row.role).toUpperCase()
          : 'PASSENGER',
        fullName: row.fullName ?? row.full_name ?? null,
        phone: row.phone ?? null
      });
      state.offsets.users = meta.lineNumber;
      if (batch.length >= opts.batchSize) await flush();
    }
  });
  await flush();
}

async function runNdjsonFlights(opts, state, summary) {
  const file = path.join(opts.input, 'flights.ndjson');
  if (!(await fileExists(file))) return;

  let batch = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    await ensurePartitionsForDates(current.map((flight) => flight.departureDate), {
      includeReadModel: opts.outbox
    });
    const written = await writeFlightBatch(current, { outbox: opts.outbox });
    summary.processed.flights += written.flights;
    summary.processed.inventoryRows += written.inventory;
    summary.processed.outboxEvents += written.outbox;
    await writeCheckpoint(opts.checkpoint, state);
  };

  const offset = state.offsets.flights || 0;
  await streamJsonl(file, {
    skip: offset,
    onRow: async (row, meta) => {
      if (!row) return recordInvalid(summary, opts, 'flights', meta);
      try {
        batch.push(normaliseLegacyFlight(row, {
          defaultAircraftType: 'A320',
          defaultEconomySeats: 180
        }));
      } catch (err) {
        return recordInvalid(summary, opts, 'flights', { ...meta, error: err.message });
      }
      state.offsets.flights = meta.lineNumber;
      if (batch.length >= opts.batchSize) await flush();
    }
  });
  await flush();
}

/**
 * Imports historical bookings read-only and then reconciles the counters of every
 * flight they touch. Without the reconciliation step the oversell audit would report
 * every imported CONFIRMED booking as a counter mismatch.
 */
async function runNdjsonBookings(opts, state, summary) {
  const file = path.join(opts.input, 'bookings.ndjson');
  if (!(await fileExists(file))) return;

  let batch = [];
  const affected = new Map(); // `${flightId}|${departureDate}` -> { flightId, departureDate }

  const flush = async () => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    const keys = new Map(affected);

    await pool.withTransaction(async (client) => {
      // Resolve each booking's flight date from the write model; a booking with no
      // flight in the target database is an orphan and is skipped.
      const flightIds = [...new Set(current.map((entry) => entry.flightId))];
      const { rows: flights } = await client.query(
        `SELECT flight_id, departure_date::text AS departure_date
           FROM flights WHERE flight_id = ANY($1::uuid[])`,
        [flightIds]
      );
      const byId = new Map();
      for (const row of flights) {
        if (!byId.has(row.flight_id)) byId.set(row.flight_id, row.departure_date);
      }

      const resolved = [];
      for (const entry of current) {
        const departureDate = entry.departureDate || byId.get(entry.flightId);
        if (!departureDate) {
          summary.skipped.bookings += 1;
          continue;
        }
        resolved.push({ ...entry, departureDate });
        if (entry.status === 'CONFIRMED') {
          keys.set(`${entry.flightId}|${departureDate}`, { flightId: entry.flightId, departureDate });
        }
      }
      if (resolved.length === 0) return;

      await client.query(BOOKING_BATCH_SQL, [
        resolved.map((b) => b.bookingId),
        resolved.map((b) => b.bookingReference),
        resolved.map((b) => b.flightId),
        resolved.map((b) => b.departureDate),
        resolved.map((b) => b.userId),
        resolved.map((b) => b.cabin),
        resolved.map((b) => b.seatNumber),
        resolved.map((b) => b.passengerName),
        resolved.map((b) => b.passengerRef),
        resolved.map((b) => b.status),
        resolved.map((b) => b.price),
        resolved.map((b) => b.currency),
        resolved.map((b) => b.idempotencyKey),
        resolved.map((b) => b.nodeId),
        resolved.map((b) => b.transactionId),
        resolved.map((b) => b.paymentId),
        resolved.map((b) => b.createdAt),
        resolved.map((b) => b.updatedAt)
      ]);

      const confirmed = resolved.filter((b) => b.status === 'CONFIRMED' && b.paymentId);
      if (confirmed.length > 0) {
        await client.query(PAYMENT_BATCH_SQL, [
          confirmed.map((b) => b.paymentId),
          confirmed.map((b) => b.flightId),
          confirmed.map((b) => b.departureDate),
          confirmed.map((b) => b.bookingId),
          confirmed.map((b) => b.price),
          confirmed.map((b) => b.currency),
          confirmed.map((b) => `import:${b.bookingId}`),
          confirmed.map((b) => `import:${b.bookingId}`),
          confirmed.map((b) => b.createdAt)
        ]);
      }

      // Counters become total - CONFIRMED for the affected flights. Offline step, by
      // design: importing history while live bookings are in flight is not supported.
      if (keys.size > 0) {
        const entries = [...keys.values()];
        await client.query(
          `UPDATE flight_inventory fi
              SET available_seats = GREATEST(0, fi.total_seats - COALESCE(c.n, 0)),
                  held_seats = 0,
                  updated_at = now()
             FROM (
               SELECT b.flight_id, b.departure_date, b.cabin, count(*)::int AS n
                 FROM bookings b
                WHERE b.status = 'CONFIRMED'
                  AND (b.flight_id, b.departure_date) IN (
                    SELECT * FROM unnest($1::uuid[], $2::date[])
                  )
                GROUP BY b.flight_id, b.departure_date, b.cabin
             ) c
            WHERE fi.flight_id = c.flight_id
              AND fi.departure_date = c.departure_date
              AND fi.cabin = c.cabin`,
          [entries.map((entry) => entry.flightId), entries.map((entry) => entry.departureDate)]
        );
      }
    });

    summary.processed.bookings += current.length;
    await writeCheckpoint(opts.checkpoint, state);
  };

  const offset = state.offsets.bookings || 0;
  await streamJsonl(file, {
    skip: offset,
    onRow: async (row, meta) => {
      if (!row) return recordInvalid(summary, opts, 'bookings', meta);
      try {
        const legacyId = row._id !== undefined ? row._id : row.id;
        const status = String(row.status || 'CONFIRMED').toUpperCase();
        if (!['CONFIRMED', 'CANCELLED'].includes(status)) {
          throw new Error(`status ${status} is not importable as history`);
        }
        const flightId = legacyUuid(
          'flights',
          row.flightId ?? row.flight_id,
          `flight:${legacyId}`
        );
        const bookingId = legacyUuid('bookings', row.bookingId ?? row.booking_id ?? legacyId, `booking:${legacyId}`);
        const createdAt = asInstant(row.createdAt ?? row.created_at) || new Date();
        const updatedAt = asInstant(row.updatedAt ?? row.updated_at) || createdAt;
        const transactionId = legacyUuid(
          'transactions',
          row.transactionId ?? row.transaction_id,
          `txn:${legacyId}`
        );
        const departureDate = row.departureDate ? asInstant(row.departureDate) : null;

        batch.push({
          bookingId,
          bookingReference: String(row.bookingReference ?? row.booking_reference ?? bookingReference(bookingId)),
          flightId,
          departureDate: departureDate ? dateKey(departureDate) : null,
          userId: legacyUuid(
            'users',
            row.userId ?? row.user_id ?? row.passengerId,
            `booking-user:${row.passengerId ?? legacyId}`
          ),
          cabin: String(row.cabin || 'ECONOMY').toUpperCase(),
          seatNumber: row.seatNumber ? String(row.seatNumber).toUpperCase() : null,
          passengerName: String(row.passengerName ?? row.passengerId ?? 'Imported Passenger'),
          passengerRef: row.passengerId ? String(row.passengerId).slice(0, 120) : null,
          status,
          price: Math.max(0, asNumber(row.price, 0)),
          currency: String(row.currency || 'USD').toUpperCase(),
          idempotencyKey: row.idempotencyKey ? String(row.idempotencyKey) : null,
          nodeId: row.nodeId ? String(row.nodeId) : 'import',
          transactionId,
          paymentId: status === 'CONFIRMED' ? uuidv5(`legacy:payment:${legacyId}`) : null,          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString()
        });
      } catch (err) {
        return recordInvalid(summary, opts, 'bookings', { ...meta, error: err.message });
      }
      state.offsets.bookings = meta.lineNumber;
      if (batch.length >= opts.batchSize) await flush();
    }
  });
  await flush();
}

async function runNdjson(opts, state, summary) {
  const input = path.resolve(opts.input);
  const plan = {
    source: 'ndjson',
    input,
    files: (await Promise.all(
      ['users.ndjson', 'flights.ndjson', 'bookings.ndjson'].map(async (name) => ({
        name,
        present: await fileExists(path.join(input, name))
      }))
    )).filter((entry) => entry.present)
  };

  if (plan.files.length === 0) {
    throw new UsageError(`No users.ndjson, flights.ndjson or bookings.ndjson in ${input}`);
  }
  if (opts.dryRun) return { ...summary, plan };

  if (plan.files.some((entry) => entry.name === 'users.ndjson')) {
    await runNdjsonUsers(opts, state, summary);
  }
  if (plan.files.some((entry) => entry.name === 'flights.ndjson')) {
    await runNdjsonFlights(opts, state, summary);
  }
  if (plan.files.some((entry) => entry.name === 'bookings.ndjson')) {
    await runNdjsonBookings(opts, state, summary);
  }

  return { ...summary, plan };
}

// ---------------------------------------------------------------------------
// Reporting and reprojection
// ---------------------------------------------------------------------------

function recordInvalid(summary, opts, source, meta) {
  summary.invalid.push({ source, line: meta.lineNumber, error: meta.error });
  if (opts.strict) {
    throw new Error(`${source}.ndjson line ${meta.lineNumber}: ${meta.error}`);
  }
  logger.warn('Skipping invalid backfill row', { source, line: meta.lineNumber, error: meta.error });
}

function reportProgress(summary, opts, label) {
  if (opts.json) return;
  process.stderr.write(
    `[backfill] ${label} — flights=${summary.processed.flights} inventory=${summary.processed.inventoryRows} ` +
      `users=${summary.processed.users} bookings=${summary.processed.bookings}\n`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replays the events this run wrote. `reprojectAvailability` is the same code path the
 * operator script uses, so there is no second copy of the projection arithmetic.
 */
async function reproject({ since }) {
  const result = await projectionService.reprojectAvailability({
    since,
    until: new Date(Date.now() + 60_000)
  });
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const startedAt = Date.now();
  const summary = {
    ok: true,
    source: opts.source,
    dryRun: opts.dryRun,
    checkpoint: opts.checkpoint,
    processed: { users: 0, flights: 0, inventoryRows: 0, bookings: 0, outboxEvents: 0 },
    skipped: { bookings: 0 },
    invalid: [],
    reprojection: null,
    elapsedMs: 0
  };

  let state = null;
  if (opts.resetCheckpoint) {
    try {
      await fsp.unlink(opts.checkpoint);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  if (opts.resume) state = await readCheckpoint(opts.checkpoint);
  if (!state) {
    state = {
      version: CHECKPOINT_VERSION,
      source: opts.source,
      input: opts.input ? path.resolve(opts.input) : null,
      nextIndex: 0,
      offsets: { users: 0, flights: 0, bookings: 0 },
      processed: { users: 0, flights: 0, inventoryRows: 0, bookings: 0, outboxEvents: 0 }
    };
  }

  // A checkpoint from a different source/input would resume in the wrong place.
  if (
    state.source !== opts.source ||
    (opts.source === 'ndjson' && state.input !== path.resolve(opts.input))
  ) {
    throw new UsageError(
      `Checkpoint ${opts.checkpoint} belongs to source=${state.source} input=${state.input || '-'}; ` +
        'use --reset-checkpoint to start a different load'
    );
  }

  const since = new Date();

  let result;
  if (opts.source === 'synthetic') {
    result = await runSynthetic(opts, state, summary);
  } else {
    result = await runNdjson(opts, state, summary);
  }

  if (opts.reproject && !opts.dryRun) {
    // Assign onto the returned summary: spreading `summary` into `result` happened
    // inside the source runner, so writing the field to `summary` here would be
    // invisible in the output.
    result.reprojection = await reproject({ since });
  }

  result.elapsedMs = Date.now() - startedAt;
  result.checkpointState = {
    nextIndex: state.nextIndex,
    offsets: state.offsets
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const p = result.processed;
    process.stdout.write(
      `\nbackfill complete (${result.elapsedMs}ms)\n` +
        `  users     ${p.users}\n` +
        `  flights   ${p.flights}\n` +
        `  inventory ${p.inventoryRows} rows\n` +
        `  bookings  ${p.bookings} (skipped ${result.skipped.bookings})\n` +
        `  outbox    ${p.outboxEvents} events\n` +
        `  invalid   ${result.invalid.length} rows\n` +
        (result.reprojection
          ? `  projected ${result.reprojection.projected ?? 0} events\n`
          : '')
    );
  }

  return 0;
}

if (require.main === module) {
  main()
    .then(async (code) => {
      await pool.close();
      process.exit(code);
    })
    .catch(async (err) => {
      if (err instanceof UsageError) {
        process.stderr.write(`backfill: ${err.message}\n\n${USAGE}\n`);
        await pool.close();
        process.exit(2);
      }
      logger.error('Backfill failed', { error: err.message, stack: err.stack });
      process.stderr.write(`backfill failed: ${err.message}\n`);
      await pool.close();
      process.exit(1);
    });
}

module.exports = {
  uuidv5,
  bookingReference,
  normaliseLegacyFlight,
  syntheticFlight,
  parseArgs
};
