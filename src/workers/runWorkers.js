/**
 * Worker supervisor.
 *
 * Starts the three background workers in one process: the outbox consumer, the hold
 * reaper, and the saga reconciler. Each is also runnable alone (`npm run outbox:run`
 * and friends) because they have different scaling characteristics — the outbox consumer
 * is the one that needs more instances under load, while the reaper tolerates being
 * single because its claims make double-expiry impossible anyway.
 *
 * Shutdown is a first-class concern, not an afterthought. In-flight work must be
 * allowed to finish before the process exits, because every worker here does
 * read-then-write sequences whose intermediates are *designed* to be recoverable but
 * are cheaper to finish than to recover. So: stop accepting new ticks, wait for the
 * current pass to settle, then close the pools. Exiting mid-pass would be safe — the
 * claims make it safe — but "safe" is not the same as "free".
 */
const env = require('../config/env');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const cache = require('../cache');
const metrics = require('../observability/metrics');
const http = require('http');

const outboxConsumer = require('./outboxConsumer');
const holdReaper = require('./holdReaper');
const sagaWorker = require('./sagaWorker');

/** Which workers to run: 'all' (default), or a comma-separated subset. */
const KNOWN = ['outbox', 'reaper', 'saga'];

function parseSelection(selection) {
  if (!selection || selection === 'all') return KNOWN.slice();
  const requested = String(selection)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter((entry) => !KNOWN.includes(entry));
  if (unknown.length > 0) {
    throw new Error(`Unknown worker(s): ${unknown.join(', ')}. Known: ${KNOWN.join(', ')}, all`);
  }
  return requested;
}

/**
 * Optional HTTP listener for a worker-only process.
 *
 * A separately deployed worker is invisible to Prometheus otherwise: the outbox gauges
 * are set inside this process, and the API process has no way to read them. The listener
 * is off unless `WORKER_METRICS_PORT` is set, and a bind failure is logged rather than
 * thrown — losing telemetry must not stop the projector from running.
 *
 * `/api/health/live` mirrors the API's liveness endpoint so a Kubernetes probe can use
 * the same path for both workload types. It intentionally touches nothing.
 */
function startMetricsServer() {
  if (!env.WORKER_METRICS_PORT || !metrics.metricsEnabled) return null;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/metrics') {
        const body = await metrics.renderMetrics();
        res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
        res.end(body);
        return;
      }
      if (req.url === '/api/health/live') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { status: 'ALIVE', nodeId: env.NODE_ID } }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      logger.warn('Worker metrics request failed', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('metrics unavailable');
    }
  });

  server.on('error', (err) => {
    logger.error('Worker metrics listener failed; continuing without it', {
      port: env.WORKER_METRICS_PORT,
      error: err.message
    });
  });

  server.listen(env.WORKER_METRICS_PORT, () => {
    logger.info('Worker metrics listening', { port: env.WORKER_METRICS_PORT, nodeId: env.NODE_ID });
  });

  return server;
}

/**
 * Runs the selected workers until a signal arrives.
 *
 * On concurrency between nodes: several API nodes each running an outbox consumer is
 * the intended topology, and it is safe because every projection write is a guarded
 * upsert. Several *reapers* are wasteful rather than wrong — the conditional claims
 * mean two reapers can never both return the same seats — so they are left unguarded
 * rather than gated behind a lock whose holder dying would silently stop all expiry.
 * Correctness comes from the claims; the lock would only have bought tidiness, at the
 * cost of a liveness failure mode.
 */
async function run(selection = process.env.WORKERS || 'all') {
  const chosen = parseSelection(selection);
  const started = [];

  logger.info('Starting workers', {
    nodeId: env.NODE_ID,
    workers: chosen,
    outboxPollMs: env.OUTBOX_POLL_INTERVAL_MS,
    reaperIntervalMs: env.REAPER_INTERVAL_MS,
    sagaIntervalMs: env.SAGA_INTERVAL_MS,
    sagaInline: env.BOOKING_SAGA_INLINE
  });

  // Configuration warnings that would otherwise be discovered as missing bookings.
  if (!env.BOOKING_SAGA_INLINE && !chosen.includes('saga')) {
    logger.error(
      'BOOKING_SAGA_INLINE=false but the saga reconciler is not selected: bookings will hold seats ' +
        'until their hold expires and then be released. Run the saga worker.'
    );
  }

  if (chosen.includes('outbox')) started.push({ name: 'outbox', handle: outboxConsumer.start() });
  if (chosen.includes('reaper')) started.push({ name: 'reaper', handle: holdReaper.start() });
  if (chosen.includes('saga')) started.push({ name: 'saga', handle: sagaWorker.start() });

  const metricsServer = startMetricsServer();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Worker shutdown initiated', { signal, workers: started.map((entry) => entry.name) });

    for (const worker of started) {
      try {
        worker.handle.stop();
      } catch (err) {
        logger.warn('Worker stop threw', { worker: worker.name, error: err.message });
      }
    }

    // Give an in-flight pass a moment to settle. The alternative — exiting immediately —
    // is safe by design, but finishing is free and leaves less for the recovery paths.
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_SHUTDOWN_GRACE_MS));

    if (metricsServer) {
      await new Promise((resolve) => metricsServer.close(() => resolve()));
    }

    await Promise.allSettled([pool.close(), cache.close()]);
    logger.info('Worker shutdown complete');
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').then(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').then(() => process.exit(0));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in worker process', {
      error: reason instanceof Error ? reason.message : String(reason)
    });
  });

  // Kept referenced so the process stays alive; the individual worker timers are unref'd
  // precisely so this heartbeat is the single thing deciding liveness.
  const heartbeat = setInterval(() => {
    logger.debug('Worker heartbeat', { workers: started.map((entry) => entry.name) });
  }, 60_000);

  return {
    workers: started.map((entry) => entry.name),
    metrics,
    async stop() {
      clearInterval(heartbeat);
      await shutdown('manual');
    }
  };
}

module.exports = { run, parseSelection, KNOWN };
