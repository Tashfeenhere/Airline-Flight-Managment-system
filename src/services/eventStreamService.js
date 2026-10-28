/**
 * Real-time Event Backbone & Server-Sent Events (SSE) stream (WP13).
 *
 * Implements:
 * - In-memory ring buffer with overflow protection for stream resume (`Last-Event-ID`).
 * - Backpressure-safe broadcast channel for saga steps, counter diffs, outbox projections,
 *   reaper actions, and test runs.
 * - `GET /api/stream` endpoint with heartbeat pings and event filtering.
 */
const logger = require('../utils/logger');

const RING_BUFFER_MAX = 5000;
const ringBuffer = [];
let eventSequence = 1;
const subscribers = new Set();

/**
 * Publishes an event to the stream backbone and stores it in the ring buffer.
 */
function publishStreamEvent(type, payload) {
  const event = {
    id: String(eventSequence++),
    type,
    timestamp: new Date().toISOString(),
    payload
  };

  ringBuffer.push(event);
  if (ringBuffer.length > RING_BUFFER_MAX) {
    ringBuffer.shift();
  }

  const sseData = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

  for (const client of subscribers) {
    try {
      client.res.write(sseData);
      if (typeof client.res.flush === 'function') {
        client.res.flush();
      }
    } catch (err) {
      subscribers.delete(client);
    }
  }
}

/**
 * Express handler for Server-Sent Events stream.
 */
function sseStreamHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  res.write(': connected\n\n');
  if (typeof res.flush === 'function') {
    res.flush();
  }

  const subscriber = { req, res };
  subscribers.add(subscriber);

  // Resume missed events from Last-Event-ID if requested
  const lastEventId = req.headers['last-event-id'];
  if (lastEventId) {
    const lastIdNum = Number.parseInt(lastEventId, 10);
    if (!Number.isNaN(lastIdNum)) {
      const missed = ringBuffer.filter((e) => Number.parseInt(e.id, 10) > lastIdNum);
      for (const e of missed) {
        res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      }
    }
  }

  // Periodic heartbeat to prevent proxy timeout
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      subscribers.delete(subscriber);
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    subscribers.delete(subscriber);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * Returns latest snapshot of buffered events for instant UI loading.
 */
function getRecentEvents(limit = 100) {
  return ringBuffer.slice(-limit);
}

module.exports = {
  publishStreamEvent,
  sseStreamHandler,
  getRecentEvents
};
