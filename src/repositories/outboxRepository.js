/**
 * Transactional outbox repository (write model).
 *
 * Every state change that other systems must learn about writes a row here *in the
 * same transaction* as the change itself. That is the entire point: a dual write
 * (commit the booking, then publish to a queue) has a window where the process dies
 * between the two and the event is lost forever, with no way to notice. Writing the
 * event inside the transaction makes "the booking exists" and "the event exists"
 * the same atomic fact; delivery becomes a separate, retryable concern.
 *
 * The projector is therefore at-least-once, and every consumer of these events is
 * written to be idempotent (see projectionService). The delivery protocol is
 * deliberately *project first, mark published second*:
 *
 *   1. apply the projection (idempotent upsert, guarded by event time)
 *   2. UPDATE … SET published = true
 *
 * A crash between 1 and 2 replays the event, and the replay is a no-op because the
 * upsert guard rejects it. Marking first and projecting second would instead lose
 * the projection permanently on a crash — the failure mode that actually matters.
 *
 * Shipping the denormalized flight snapshot inside the payload is what keeps the
 * projector free of joins against the write model, so it can run against a lagging
 * replica or on a different host entirely.
 */
const { normaliseOutboxEvent } = require('./mappers');

const COLUMNS = `
  event_id, flight_id, departure_date, event_type, aggregate_id, user_id, payload,
  published, attempts, last_error, created_at, published_at`;

async function insert(client, event) {
  const { rows } = await client.query(
    `INSERT INTO booking_outbox (
       event_id, flight_id, departure_date, event_type, aggregate_id, user_id, payload
     ) VALUES (
       COALESCE($1::uuid, app_uuidv7()), $2, $3, $4, $5, $6, $7::jsonb
     )
     RETURNING ${COLUMNS}`,
    [
      event.eventId || null,
      event.flightId,
      event.departureDate,
      event.eventType,
      event.aggregateId,
      event.userId || null,
      JSON.stringify(event.payload || {})
    ]
  );
  return normaliseOutboxEvent(rows[0]);
}

/**
 * Events awaiting projection, oldest first.
 *
 * This is a scatter read (`ORDER BY` + `LIMIT` merged by the coordinator), which is
 * fine: the partial index on `published = false` makes each shard's contribution
 * cheap, and the writes that follow are per-event single-shard statements.
 */
async function listPending(client, { limit = 200, eventTypes = null }) {
  const params = [limit];
  let predicate = '';
  if (eventTypes && eventTypes.length > 0) {
    predicate = ' AND event_type = ANY($2::text[])';
    params.push(eventTypes);
  }
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM booking_outbox
      WHERE published = false${predicate}
      ORDER BY created_at
      LIMIT $1`,
    params
  );
  return rows.map(normaliseOutboxEvent);
}

/** Marks an event delivered. Scoped by flight and date so it stays single-shard. */
async function markPublished(client, { flightId, departureDate, eventId }) {
  const { rows } = await client.query(
    `UPDATE booking_outbox
        SET published = true, published_at = now(), last_error = NULL
      WHERE flight_id = $1 AND departure_date = $2 AND event_id = $3
        AND published = false
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, eventId]
  );
  return rows[0] ? normaliseOutboxEvent(rows[0]) : null;
}

/**
 * Records a failed delivery attempt. The event stays unpublished so the next tick
 * retries it; `attempts` keeps climbing so a permanently poisonous event is visible
 * in stats instead of spinning forever in silence.
 */
async function markFailed(client, { flightId, departureDate, eventId, error }) {
  const { rows } = await client.query(
    `UPDATE booking_outbox
        SET attempts   = attempts + 1,
            last_error = $4
      WHERE flight_id = $1 AND departure_date = $2 AND event_id = $3
      RETURNING ${COLUMNS}`,
    [flightId, departureDate, eventId, String(error).slice(0, 1000)]
  );
  return rows[0] ? normaliseOutboxEvent(rows[0]) : null;
}

/**
 * Events for the reprojection job, which rebuilds the read models from scratch after
 * a bad deploy or a schema change. Walks by insertion order so the projections are
 * replayed in the order the business events happened.
 *
 * `flightIds` narrows the replay to a set of flights, which is what turns "rebuild
 * the read model" from a cluster-wide operation into a targeted repair for one route
 * that projected incorrectly. Parameters are collected positionally as each filter is
 * added rather than hard-coding $5/$6: a hand-numbered parameter list is exactly how
 * a filter gets wired to the wrong column when someone adds the next one.
 */
async function listForReprojection(client, { since, until, limit = 1000, offset = 0, eventTypes = null, flightIds = null }) {
  const params = [since, until];
  const filters = [];

  if (eventTypes && eventTypes.length > 0) {
    params.push(eventTypes);
    filters.push(`event_type = ANY($${params.length}::text[])`);
  }

  if (flightIds && flightIds.length > 0) {
    params.push(flightIds);
    filters.push(`flight_id = ANY($${params.length}::uuid[])`);
  }

  params.push(limit, offset);

  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM booking_outbox
      WHERE created_at >= $1 AND created_at <= $2
        ${filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY created_at, event_id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(normaliseOutboxEvent);
}

/**
 * Delivery backlog: how many events are pending and how old the oldest one is. That
 * age is the honest answer to "how stale is the read model", and it is what the
 * outbox-lag gauge reports.
 *
 * `failed` counts unpublished events that have already been retried at least once,
 * and `oldestEventAgeMs` is computed in SQL rather than as `now() - oldest` in Node:
 * the application clock and the database clock are two different clocks, and the age
 * of a row written by the database should be measured against the database.
 */
async function stats(client) {
  const { rows } = await client.query(
    `SELECT
       count(*) FILTER (WHERE published = false)::int AS pending,
       count(*) FILTER (WHERE published = true)::int  AS published,
       count(*) FILTER (WHERE published = false AND attempts > 0)::int AS failed,
       count(*)::int                                  AS total,
       max(attempts)::int                             AS max_attempts,
       min(created_at) FILTER (WHERE published = false) AS oldest_pending_at,
       max(published_at) FILTER (WHERE published = true) AS last_published_at,
       EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE published = false)))::float AS lag_seconds,
       (EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE published = false))) * 1000)::bigint AS lag_ms
     FROM booking_outbox`
  );
  const backlog = await pendingCountsByEventType(client);
  const row = rows[0] || {};
  return {
    pending: Number(row.pending || 0),
    published: Number(row.published || 0),
    failed: Number(row.failed || 0),
    total: Number(row.total || 0),
    maxAttempts: Number(row.max_attempts || 0),
    oldestPendingAt: row.oldest_pending_at || null,
    oldestEventAgeMs: row.lag_ms === null || row.lag_ms === undefined ? null : Number(row.lag_ms),
    lastPublishedAt: row.last_published_at || null,
    byEventType: backlog,
    lagSeconds: row.lag_seconds === null || row.lag_seconds === undefined ? 0 : Number(row.lag_seconds)
  };
}

/**
 * Pending events per event type. The event type is a bounded enum, so this is safe to
 * use as a label — and it is the first question after "the read model is behind":
 * *which* projection is behind.
 */
async function pendingCountsByEventType(client) {
  const { rows } = await client.query(
    `SELECT event_type, count(*)::int AS n
       FROM booking_outbox
      WHERE published = false
      GROUP BY event_type
      ORDER BY event_type`
  );

  const byEventType = {};
  for (const row of rows) byEventType[row.event_type] = Number(row.n);
  return byEventType;
}

/** Events that keep failing — surfaced so a poisonous payload is not invisible. */
async function listPoisoned(client, { minAttempts = 5, limit = 50 }) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM booking_outbox
      WHERE published = false AND attempts >= $1
      ORDER BY attempts DESC, created_at
      LIMIT $2`,
    [minAttempts, limit]
  );
  return rows.map(normaliseOutboxEvent);
}

module.exports = {
  insert,
  listPending,
  markPublished,
  markFailed,
  listForReprojection,
  listPoisoned,
  pendingCountsByEventType,
  stats
};
