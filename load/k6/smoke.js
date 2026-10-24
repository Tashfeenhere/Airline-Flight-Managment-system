/**
 * Smoke test: one virtual user, one pass, over every path a release must not break.
 *
 * This is the test to run against a freshly migrated or freshly deployed environment.
 * It is intentionally small: search needs seeded flights for the route and date, so it
 * is skipped unless `ORIGIN`/`DESTINATION`/`DEPARTURE_DATE` are supplied, and the
 * booking check is skipped unless `FLIGHT_ID` names a flight with at least two free
 * seats.
 *
 *   k6 run load/k6/smoke.js
 *   k6 run -e FLIGHT_ID=<uuid> -e DEPARTURE_DATE=2027-03-05 load/k6/smoke.js
 *
 * Exit code is non-zero when any check or threshold fails, which is what makes this
 * usable as a deploy gate.
 */
import http from 'k6/http';
import { check, group } from 'k6';
import {
  BASE_URL,
  availability,
  book,
  idempotencyKey,
  search,
  utcDatePlus
} from './common.js';

const ORIGIN = __ENV.ORIGIN || null;
const DESTINATION = __ENV.DESTINATION || null;
const DEPARTURE_DATE = __ENV.DEPARTURE_DATE || utcDatePlus(30);
const FLIGHT_ID = __ENV.FLIGHT_ID || null;
const CABIN = __ENV.CABIN || 'ECONOMY';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<2000']
  }
};

function body(response) {
  try {
    return response.json();
  } catch (err) {
    return null;
  }
}

export default function () {
  group('liveness', () => {
    const response = http.get(`${BASE_URL}/api/health/live`, { tags: { endpoint: 'health-live' } });
    check(response, {
      'live returns 200': (r) => r.status === 200,
      'live reports success': (r) => body(r) !== null && body(r).success === true
    });
  });

  group('readiness', () => {
    const response = http.get(`${BASE_URL}/api/health/ready`, { tags: { endpoint: 'health-ready' } });
    check(response, {
      'ready returns 200': (r) => r.status === 200,
      'ready names a status': (r) => {
        const parsed = body(r);
        return parsed !== null && typeof parsed.data === 'object' && parsed.data !== null;
      }
    });
  });

  group('metrics', () => {
    const response = http.get(`${BASE_URL}/metrics`, { tags: { endpoint: 'metrics' } });
    // The endpoint is optional in local runs: enabling it is a deployment decision.
    check(response, {
      'metrics is exposed or deliberately absent': (r) => r.status === 200 || r.status === 404
    });
  });

  if (ORIGIN && DESTINATION) {
    group('search', () => {
      const response = search(ORIGIN, DESTINATION, DEPARTURE_DATE);
      check(response, {
        'search returns 200': (r) => r.status === 200,
        'search has a flights array': (r) => {
          const parsed = body(r);
          return parsed !== null && parsed.data && Array.isArray(parsed.data.flights);
        }
      });
    });
  }

  if (FLIGHT_ID) {
    group('availability', () => {
      const response = availability(FLIGHT_ID);
      check(response, {
        'availability returns 200': (r) => r.status === 200,
        'availability is authoritative': (r) => {
          const parsed = body(r);
          return parsed !== null && parsed.data && parsed.data.authoritative === true;
        }
      });
    });

    group('booking and idempotent replay', () => {
      const key = idempotencyKey('smoke');
      const first = book({ flightId: FLIGHT_ID, cabin: CABIN, key });
      check(first, {
        'booking succeeds': (r) =>
          (r.status === 201 && body(r) !== null && body(r).data.status === 'CONFIRMED') ||
          r.status === 409
      });

      if (first.status === 201) {
        // The same key must return the same booking (200), not consume a second seat.
        const replay = book({ flightId: FLIGHT_ID, cabin: CABIN, key });
        check(replay, {
          'replay returns 200': (r) => r.status === 200,
          'replay is marked': (r) => r.headers['Idempotent-Replay'] === 'true',
          'replay is the same booking': (r) =>
            body(r) !== null &&
            body(first) !== null &&
            body(r).data.bookingId === body(first).data.bookingId
        });
      }
    });
  }
}
