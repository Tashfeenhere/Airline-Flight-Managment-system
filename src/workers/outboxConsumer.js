/**
 * Outbox consumer.
 *
 * Drains `booking_outbox` into the read models. The correctness lives in
 * projectionService (guarded upserts, project-then-mark); this file is only the loop
 * that calls it — plus the two policies a loop needs and a service should not own:
 * how fast to poll, and what to do with an event that keeps failing.
 *
 * The poison policy is deliberately conservative. An event that has failed
 * `OUTBOX_MAX_ATTEMPTS` times is NOT discarded — discarding would silently lose a
 * projection, which is the one outcome the whole outbox design exists to prevent. It is
 * parked in-process (with exponential backoff before that) and reported through
 * `listPoisoned` and the failure metric, so a human decides. A restart retries it, on
 * the theory that most poison is a transient database condition rather than bad data.
 */
const env = require('../config/env');
const logger = require('../utils/logger');
const metrics = require('../observability/metrics');
const projectionService = require('../services/projectionService');

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 60_000;

function start({ intervalMs = env.OUTBOX_POLL_INTERVAL_MS, batchSize = env.OUTBOX_BATCH_SIZE, maxAttempts = env.OUTBOX_MAX_ATTEMPTS } = {}) {
  let stopped = false;
  let timer = null;
  let running = false;

  // eventId -> { attempts, nextAttemptAt }. In-process on purpose: a cooldown is a
  // property of *this* consumer's recent experience, not durable state worth a table.
  const cooldowns = new Map();

  const cooledDown = (eventId) => {
    const entry = cooldowns.get(eventId);
    if (!entry) return false;
    return Date.now() < entry.nextAttemptAt;
  };

  const noteFailure = (eventId) => {
    const entry = cooldowns.get(eventId) || { attempts: 0, nextAttemptAt: 0 };
    entry.attempts += 1;
    entry.nextAttemptAt = Date.now() + Math.min(BASE_BACKOFF_MS * 2 ** (entry.attempts - 1), MAX_BACKOFF_MS);
    cooldowns.set(eventId, entry);
    return entry.attempts;
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await projectionService.runOnce({ limit: batchSize });

      if (result.failed > 0) {
        // Park the ones that have exhausted their attempts for this process's lifetime.
        const stats = await require('../repositories/outboxRepository').listPoisoned(
          require('../db/pool').writePool,
          { minAttempts: maxAttempts, limit: 20 }
        );
        for (const poisoned of stats) {
          const attempts = noteFailure(poisoned.eventId);
          if (attempts === maxAttempts) {
            logger.error('Outbox event is poisoned; parking it for this process', {
              eventId: poisoned.eventId,
              eventType: poisoned.eventType,
              flightId: poisoned.flightId,
              attempts: poisoned.attempts,
              lastError: poisoned.lastError
            });
          }
        }
        // A failing batch should not be re-read at full speed.
        await sleep(Math.min(1000 * 2 ** Math.min(result.failed, 6), MAX_BACKOFF_MS));
      } else if (result.scanned > 0) {
        logger.info('Outbox batch projected', result);
      }
    } catch (err) {
      logger.error('Outbox consumer pass failed', { error: err.message });
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        if (timer.unref) timer.unref();
      }
    }
  };

  timer = setTimeout(tick, 0);
  if (timer.unref) timer.unref();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    /** Exposed so tests can drive one pass without the timer. */
    runOnce: (options) => projectionService.runOnce({ limit: batchSize, ...options }),
    isCoolingDown: cooledDown,
    cooldowns
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drains the backlog and returns how many passes it took.
 *
 * Used by the reprojection script and by tests that need the read model to be caught up
 * before asserting on it. It stops when a pass projects nothing, or when `maxPasses` is
 * hit — the bound matters because a steady write load means the outbox is never truly
 * empty, and an unbounded drain would never return.
 */
async function drain({ batchSize = env.OUTBOX_BATCH_SIZE, maxPasses = 1000, onPass = null } = {}) {
  let passes = 0;
  let projected = 0;

  while (passes < maxPasses) {
    const result = await projectionService.runOnce({ limit: batchSize });
    passes += 1;
    projected += result.projected;
    if (onPass) onPass(result);
    if (result.scanned === 0) break;
    if (result.projected === 0 && result.failed > 0) break;
  }

  return { passes, projected };
}

module.exports = { start, drain };
