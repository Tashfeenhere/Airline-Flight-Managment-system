/**
 * Process entry point.
 *
 * Kept deliberately thin: building the app and starting workers are both testable
 * functions (`buildApp`, `runWorkers.run`), and the only things this file adds are the
 * decisions that belong to a *process* — which port to bind, what to log at boot, and
 * how to die.
 *
 * Shutdown order is the interesting part:
 *
 *   1. stop accepting new connections (`server.close`), so no request arrives that
 *      expects an answer we are no longer able to give;
 *   2. stop the workers, which stops taking new outbox batches and gives an in-flight
 *      pass a bounded grace period to settle;
 *   3. close the pools — the connection is the last thing to go, because a worker
 *      pass or an in-flight request that is still mid-query when its pool closes
 *      fails in a way that needs manual reconciliation.
 *
 * The hard timeout exists because a hung worker or a connection stuck in a TCP
 * half-open state would otherwise keep the process alive past the orchestrator's
 * SIGKILL, and losing the log line that says what was happening is worse than losing
 * the graceful finish.
 */
const env = require('./config/env');
const logger = require('./utils/logger');
const pool = require('./db/pool');
const cache = require('./cache');
const buildApp = require('./app');
const runWorkers = require('./workers/runWorkers');

/** Ceiling on the whole shutdown, after which the process exits regardless. */
const SHUTDOWN_DEADLINE_MS = 15_000;

const app = buildApp();

buildApp.warnOnRiskyConfig();

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`\n================================================================================`);
  console.log(`[AEROSCALE_API] Airline Inventory Distributed Engine Server ACTIVE`);
  console.log(`[AEROSCALE_API] Listening on PORT: ${env.PORT} (0.0.0.0) (Node: ${env.NODE_ID})`);
  console.log(`[AEROSCALE_API] Write DB: PostgreSQL Citus (127.0.0.1:55432)`);
  console.log(`[AEROSCALE_API] Read DB:  CQRS Search Replica (127.0.0.1:5433)`);
  console.log(`[AEROSCALE_API] Ready for Live Test Executions, 1M Load Tests, and Docker Lifecycle.`);
  console.log(`================================================================================\n`);
  logger.info('API listening', {
    nodeId: env.NODE_ID,
    port: env.PORT,
    env: env.NODE_ENV,
    workersEnabled: env.WORKERS_ENABLED,
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY
  });
});

// Node's default keep-alive (5s) is longer than most load balancers' idle timeout,
// which is how a request lands on a socket the LB has already closed. Announcing the
// value lets an operator line it up with the proxy in front.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let workers = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('Shutdown initiated', { signal, nodeId: env.NODE_ID });

  const timer = setTimeout(() => {
    logger.error('Graceful shutdown exceeded its deadline; exiting', {
      deadlineMs: SHUTDOWN_DEADLINE_MS
    });
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  // The timer must not itself keep the process alive once everything else has closed.
  timer.unref();

  try {
    await new Promise((resolve) => {
      server.close(() => resolve());
      // `close` waits for keep-alive sockets to drain, which can take as long as the
      // keep-alive timeout even when nothing is in flight. The orchestrator has
      // already stopped routing new requests to us, so the remaining connections are
      // idle by definition.
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    });
    logger.info('HTTP server closed');

    if (workers) {
      await workers.stop();
      logger.info('Workers stopped');
    }

    await Promise.allSettled([pool.close(), cache.close()]);
    logger.info('Resources released; shutdown complete');

    clearTimeout(timer);
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err });
    clearTimeout(timer);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('unhandledRejection', (reason) => {
  const errMsg = reason instanceof Error ? reason.message : String(reason);
  if (errMsg.includes('ECONNRESET') || errMsg.includes('EPIPE') || errMsg.includes('ERR_STREAM_PREMATURE_CLOSE')) {
    logger.warn('Client socket disconnected prematurely; ignoring transient network reset', { error: errMsg });
    return;
  }
  logger.error('Unhandled rejection; shutting down', {
    error: reason instanceof Error ? reason : String(reason)
  });
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  const errMsg = err?.message || String(err);
  if (errMsg.includes('ECONNRESET') || errMsg.includes('EPIPE') || errMsg.includes('ERR_STREAM_PREMATURE_CLOSE')) {
    logger.warn('Client socket disconnected prematurely; ignoring transient network reset', { error: errMsg });
    return;
  }
  logger.error('Uncaught exception; shutting down', { error: err });
  shutdown('uncaughtException');
});

// Started after `listen` so a worker crash cannot prevent the health endpoint from
// coming up — a node that answers /api/health with DEGRADED is far more useful to an
// operator than one that never binds its port.
if (env.WORKERS_ENABLED) {
  runWorkers
    .run(process.env.WORKERS || 'all')
    .then((handle) => {
      workers = handle;
      logger.info('In-process workers started', { workers: handle.workers });
    })
    .catch((err) => {
      // Not fatal: the API serves reads and writes without a projector or a reaper,
      // and the outbox backlog metric will show the consequence. Exiting here would
      // turn a background-job misconfiguration into a total outage.
      logger.error('Failed to start in-process workers; continuing without them', { error: err });
    });
}

module.exports = { server, shutdown };
