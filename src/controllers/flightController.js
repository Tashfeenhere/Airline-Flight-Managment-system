/**
 * Flight endpoints: search, detail, seat map and authoritative availability.
 *
 * The single mapping decision this file owns is the shape of an `Availability`: the
 * services speak in the write model's vocabulary (`totalSeats`, `availableSeats`) and
 * the API contract speaks in the read model's (`capacity`, `available`, `held`). Both
 * names are defensible; having two of them is not, so the translation happens here,
 * once, at the edge — and never by renaming the fields inside a service that other
 * callers (the workers, the CLI) also depend on.
 */
const flightService = require('../services/flightService');
const env = require('../config/env');
const { ok, lagHeader } = require('../http/respond');

/**
 * One cabin counter, in the documented shape.
 *
 * `shardNo` is emitted only when there is exactly one counter row to name. In the
 * `single` strategy that row is shard 0 and saying so is exact. In the `sharded`
 * strategy the counter returned here is already an aggregate across shards, so there
 * is no such thing as *the* shard number — omitting the key is honest, and inventing
 * `0` would report a sharded cabin as unsharded. Per-shard detail is available from
 * the inventory shard functions for a caller that needs it.
 */
function toAvailability(counter, { currency = null } = {}) {
  const availability = {
    cabin: counter.cabin,
    capacity: counter.totalSeats,
    available: counter.availableSeats,
    held: counter.heldSeats,
    price: counter.price === undefined ? null : counter.price,
    currency: counter.currency || currency,
    // The write model calls this `version` and the projection calls it
    // `sourceVersion`; the API calls it `version` either way, because from a client's
    // point of view it is the same number serving the same purpose — the value it
    // passes back as `expectedVersion`. The two differ only in *what* it versions
    // (the counter vs the projected snapshot), which is not the client's concern.
    version: counter.version === undefined ? counter.sourceVersion : counter.version
  };

  if (env.INVENTORY_STRATEGY === 'single') availability.shardNo = 0;

  return availability;
}

/** A flight with its cabin counters, in the documented `Flight` shape. */
function toFlight(flight) {
  return {
    flightId: flight.flightId,
    flightNumber: flight.flightNumber,
    airlineCode: flight.airlineCode,
    origin: flight.origin,
    destination: flight.destination,
    departureDate: flight.departureDate,
    departureTime: flight.departureTime,
    arrivalTime: flight.arrivalTime,
    aircraftType: flight.aircraftType,
    basePrice: flight.basePrice,
    currency: flight.currency,
    status: flight.status,
    cabins: (flight.cabins || []).map((counter) => toAvailability(counter, { currency: flight.currency }))
  };
}

/**
 * Search, with the read model's lag made machine-readable.
 *
 * The lag is both a body field and a header. The body field is for a client that wants
 * to display "results as of 2s ago"; the header is for one that wants to decide
 * *whether to trust the results at all* without parsing the body — and a proxy or a
 * service mesh can read a header.
 */
async function search(req, res) {
  const result = await flightService.searchFlights({
    origin: String(req.query.origin).toUpperCase(),
    destination: String(req.query.destination).toUpperCase(),
    departureDate: req.query.departureDate,
    cabin: req.query.cabin || null,
    passengers: req.query.passengers === undefined ? 1 : req.query.passengers,
    limit: req.query.limit === undefined ? 20 : req.query.limit,
    offset: req.query.offset === undefined ? 0 : req.query.offset
  });

  const lagMs = result.freshness.lagSeconds === null ? 0 : Math.round(result.freshness.lagSeconds * 1000);
  lagHeader(res, result.freshness.lagSeconds);

  return ok(res, {
    flights: result.flights.map((flight) => ({
      ...toFlight(flight),
      lowestPrice: flight.lowestPrice,
      sourceVersion: flight.sourceVersion,
      updatedAt: flight.updatedAt,
      // Kept alongside `lowestPrice` because it answers a different question: what the
      // whole party pays, which is what the caller is actually shopping for. The
      // contract does not name it, but omitting it would force every client to know
      // the cabin multipliers that the server already applied.
      totalPrice: flight.totalPrice,
      seatsSufficient: flight.seatsSufficient
    })),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    readModelLagMs: lagMs
  });
}

async function getFlight(req, res) {
  const flight = await flightService.getFlight({ flightId: req.params.flightId });
  return ok(res, toFlight(flight));
}

async function getAvailability(req, res) {
  const availability = await flightService.getAvailability({
    flightId: req.params.flightId,
    cabin: req.query.cabin || null
  });

  return ok(res, {
    flightId: availability.flightId,
    departureDate: availability.departureDate,
    status: availability.status,
    departureTime: availability.departureTime,
    // Named explicitly rather than implied: a caller comparing this with a search
    // result needs to know which of the two answers is the one the write model will
    // honour when the booking is attempted.
    authoritative: availability.authoritative,
    versionPinningAvailable: availability.versionPinningAvailable,
    cabins: availability.cabins.map((counter) => toAvailability(counter))
  });
}

/**
 * The seat map, flattened to the documented single-cabin shape.
 *
 * The service returns a map per cabin (a seat map is genuinely per cabin — the row
 * layout, the exit rows and the seat letters are all cabin-specific), while the
 * contract describes one cabin's map with its columns and rows pulled out. When the
 * caller names a cabin that is the obvious answer; when they do not, the widest cabin
 * is returned, because a UI opening a seat picker without a cabin is showing the
 * main deck and would otherwise have to guess which of the returned maps to render.
 */
async function getSeatMap(req, res) {
  const seatMap = await flightService.getSeatMap({
    flightId: req.params.flightId,
    cabin: req.query.cabin || null
  });

  const requestedCabin = req.query.cabin ? String(req.query.cabin).toUpperCase() : null;
  const cabin = requestedCabin
    ? seatMap.cabins.find((entry) => entry.cabin === requestedCabin)
    : widestCabin(seatMap.cabins);

  if (!cabin) {
    // The flight exists and has a template, but nothing for the requested cabin — an
    // aircraft that flies a two-class layout being asked for FIRST. An empty map would
    // read as "every seat is taken"; naming the cabins that do exist is actionable.
    return ok(res, {
      flightId: seatMap.flightId,
      cabin: requestedCabin,
      aircraftType: seatMap.aircraftType,
      columns: [],
      rows: [],
      seats: [],
      availableCabins: seatMap.cabins.map((entry) => entry.cabin),
      note: 'No seat map exists for the requested cabin on this aircraft type.'
    });
  }

  const rows = [...new Set(cabin.seats.map((seat) => seat.row).filter((row) => row !== null))].sort(
    (a, b) => a - b
  );

  return ok(res, {
    flightId: seatMap.flightId,
    cabin: cabin.cabin,
    aircraftType: seatMap.aircraftType,
    columns: cabin.columns,
    rows,
    seats: cabin.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      // The map's own vocabulary (FREE/HELD/OCCUPIED) distinguishes a live hold from a
      // sold seat, which the contract's SEAT_STATUS enum (AVAILABLE/BOOKED) does not.
      // Explaining the mapping would be better than collapsing it, but collapsing it is
      // what the contract asks for; a HELD seat must not read as sellable, and
      // BOOKED is the value that says so.
      status: seat.status === 'FREE' ? 'AVAILABLE' : 'BOOKED',
      cabin: cabin.cabin,
      isExitRow: seat.isExitRow,
      bookable: seat.bookable,
      position: seat.position
    })),
    availableSeats: cabin.availableSeats,
    totalSeats: cabin.totalSeats,
    price: cabin.price,
    currency: cabin.currency,
    note: seatMap.note
  });
}

/** The cabin with the most seats — the main deck of a two-class aircraft. */
function widestCabin(cabins) {
  return cabins.reduce((widest, entry) => {
    if (!widest) return entry;
    return entry.totalSeats > widest.totalSeats ? entry : widest;
  }, null);
}

module.exports = { search, getFlight, getAvailability, getSeatMap, toAvailability, toFlight };
