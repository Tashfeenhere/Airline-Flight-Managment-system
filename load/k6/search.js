/**
 * Search load: constant arrival rate against the CQRS read model.
 *
 * Search never touches the write model, so this scenario answers a different question
 * from the booking one: can the read side serve the target rate while the outbox
 * projector keeps the read model fresh? `airline_read_model_lag_seconds` on /metrics is
 * the metric to watch alongside the k6 summary.
 *
 * The route and date must exist in `flight_availability`. Create them first:
 *
 *   npm run backfill -- --source synthetic --start 2027-03-01 --days 1 --flights-per-day 50
 *   k6 run -e ORIGIN=ISB -e DESTINATION=DXB -e DEPARTURE_DATE=2027-03-01 load/k6/search.js
 *
 * Defaults are deliberately conservative; CI's smoke job runs a 10s version.
 */
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { search, utcDatePlus } from './common.js';

const ORIGIN = __ENV.ORIGIN || 'ISB';
const DESTINATION = __ENV.DESTINATION || 'DXB';
const DEPARTURE_DATE = __ENV.DEPARTURE_DATE || utcDatePlus(30);
const RATE = Number(__ENV.RATE || 25);
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 25);
const MAX_VUS = Number(__ENV.MAX_VUS || 150);

const resultCount = new Trend('search_result_count');
const readModelLag = new Trend('search_read_model_lag_ms', true);
const emptyResults = new Rate('search_empty_results');

export const options = {
  scenarios: {
    search: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      gracefulStop: '10s'
    }
  },
  thresholds: {
    // A 5xx means the read path is broken; a 4xx on this request would mean the
    // scenario itself is wrong, so both fail.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:search}': ['p(95)<400', 'p(99)<900'],
    checks: ['rate>0.99'],
    // Lag is observed, not asserted: a projector restart legitimately spikes it, and a
    // threshold here would page on deploys rather than on regressions.
    search_empty_results: ['rate<0.05']
  }
};

export default function () {
  const response = search(ORIGIN, DESTINATION, DEPARTURE_DATE);

  check(response, {
    'search returns 200': (r) => r.status === 200,
    'search envelope is valid': (r) => {
      let parsed;
      try {
        parsed = r.json();
      } catch (err) {
        return false;
      }
      return parsed.success === true && parsed.data && Array.isArray(parsed.data.flights);
    }
  });

  if (response.status !== 200) return;

  let parsed;
  try {
    parsed = response.json();
  } catch (err) {
    return;
  }

  const flights = parsed.data.flights || [];
  resultCount.add(flights.length);
  emptyResults.add(flights.length === 0);
  if (typeof parsed.data.readModelLagMs === 'number') {
    readModelLag.add(parsed.data.readModelLagMs);
  }
}
