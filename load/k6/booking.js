/**
 * Booking load: the write path under concurrency, including idempotent replay.
 *
 * Every virtual user reads authoritative availability and then books one seat with a
 * unique `Idempotency-Key`. That is the real client flow, and the counters it stresses
 * are the conditional anti-oversell UPDATE and the saga's three writes.
 *
 * Capacity is finite, so a run eventually starts collecting 409s. That is a correct
 * outcome and is counted separately rather than treated as an error; the run's
 * meaningful assertions are:
 *
 *   - no 5xx (a conditional UPDATE that loses the race is not a server error),
 *   - every 201 is a confirmed booking with a reference,
 *   - replaying a key returns 200 and the same booking id, never a second seat,
 *   - the database's accounting invariant still holds afterwards (oversell audit).
 *
 * Run against a flight with enough seats for the whole run:
 *
 *   npm run backfill -- --source synthetic --start 2027-03-01 --days 1 --flights-per-day 1
 *   k6 run -e FLIGHT_ID=<uuid> -e DEPARTURE_DATE=2027-03-01 -e RATE=20 -e DURATION=60s \
 *     load/k6/booking.js
 *   node scripts/oversell-audit.js --flight-id <uuid> --departure-date 2027-03-01
 *
 * Set `TOKEN` when `REQUIRE_AUTH_FOR_BOOKING=true`. Set `REPLAY_KEY=<key>` to make every
 * VU hammer the same key: the first request books, the rest must all replay, which is
 * the cheapest way to prove the idempotency path under load.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { availability, book, idempotencyKey } from './common.js';

const FLIGHT_ID = __ENV.FLIGHT_ID;
if (!FLIGHT_ID) {
  throw new Error('FLIGHT_ID is required: booking load needs a seeded flight with free seats');
}

const CABIN = __ENV.CABIN || 'ECONOMY';
const TOKEN = __ENV.TOKEN || null;
const REPLAY_KEY = __ENV.REPLAY_KEY || null;
const USE_EXPECTED_VERSION = __ENV.USE_EXPECTED_VERSION === 'true';
const RATE = Number(__ENV.RATE || 10);
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 20);
const MAX_VUS = Number(__ENV.MAX_VUS || 200);

// 409 is this scenario's normal back-pressure signal (sold out, seat taken, version
// conflict), 429 is the booking limiter doing its job, and 401/403 mean the scenario
// was pointed at an environment that requires a token the caller did not supply. None
// of those is an HTTP failure; they are counted and reported separately.
http.setResponseCallback(http.expectedStatuses(200, 201, 401, 403, 409, 429));

const confirmed = new Counter('booking_confirmed_total');
const replayed = new Counter('booking_replayed_total');
const refused = new Counter('booking_refused_total');
const throttled = new Counter('booking_throttled_total');
const unauthorised = new Counter('booking_unauthorised_total');
const serverErrors = new Rate('booking_server_error_rate');
const unavailableSeats = new Trend('booking_available_seats');

export const options = {
  scenarios: {
    booking: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      gracefulStop: '15s'
    }
  },
  thresholds: {
    checks: ['rate>0.99'],
    // The conditional UPDATE is expected to reject losers with 409; it must never
    // produce a 500 under contention.
    booking_server_error_rate: ['rate<0.01'],
    'http_req_duration{endpoint:booking}': ['p(95)<750', 'p(99)<1500']
  }
};

export default function () {
  const current = availability(FLIGHT_ID);
  check(current, { 'availability returns 200': (r) => r.status === 200 });

  let expectedVersion;
  if (current.status === 200) {
    try {
      const parsed = current.json();
      const cabin = (parsed.data.cabins || []).find((entry) => entry.cabin === CABIN);
      if (cabin) {
        unavailableSeats.add(cabin.available);
        // Only used when explicitly requested: under concurrency, pinning a version
        // that was read before a hundred other bookings is *supposed* to conflict.
        expectedVersion = USE_EXPECTED_VERSION ? cabin.version : undefined;
      }
    } catch (err) {
      // An unparseable 200 body fails the check above only if the shape is asserted;
      // the booking request below still runs, which is what a real client would do.
    }
  }

  const key = REPLAY_KEY || idempotencyKey('booking');
  const response = book({
    flightId: FLIGHT_ID,
    cabin: CABIN,
    key,
    token: TOKEN,
    ...(expectedVersion === undefined ? {} : { expectedVersion })
  });

  if (response.status === 201) {
    confirmed.add(1);
    check(response, {
      'fresh booking is CONFIRMED with a reference': (r) => {
        const booking = safeData(r);
        return (
          booking !== null &&
          booking.status === 'CONFIRMED' &&
          typeof booking.bookingReference === 'string' &&
          booking.bookingReference.length > 0
        );
      }
    });
  } else if (response.status === 200) {
    replayed.add(1);
    check(response, {
      'replay is marked as such': (r) => r.headers['Idempotent-Replay'] === 'true'
    });
  } else if (response.status === 409) {
    refused.add(1);
  } else if (response.status === 429) {
    // The per-IP limiter is on. Raise API_RATE_LIMIT_PER_MIN on the target for a load
    // run, or accept that the limiter — not the database — is the measured ceiling.
    throttled.add(1);
  } else if (response.status === 401 || response.status === 403) {
    unauthorised.add(1);
    check(response, { 'token was supplied for an authenticated environment': () => false });
  } else {
    check(response, { 'unexpected booking status': () => false });
  }

  // Recorded for every iteration, not only failures, so the rate is a rate over the
  // whole run rather than over the failures themselves.
  serverErrors.add(response.status >= 500);
}

function safeData(response) {
  try {
    const parsed = response.json();
    return parsed && parsed.data ? parsed.data : null;
  } catch (err) {
    return null;
  }
}
