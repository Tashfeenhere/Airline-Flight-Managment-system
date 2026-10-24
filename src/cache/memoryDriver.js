/**
 * In-process cache driver.
 *
 * This is the fallback used when REDIS_URL is unset, and the driver the test suite
 * always runs against (no external service, no flakiness).
 *
 * It is deliberately NOT presented as an equivalent of Redis: it is per-process, so
 * two API instances do not share it. That is acceptable here because nothing in this
 * system is *made correct* by the cache — idempotency is ultimately guaranteed by the
 * partial unique index `uq_booking_idempotency` in PostgreSQL, and the cache only
 * spares the database a duplicate attempt. Code that would be wrong without a shared
 * cache does not belong behind this interface.
 *
 * Entries expire lazily on read plus on a coarse sweep timer, and the timer is
 * unref'd so it can never hold the process open (a leaked interval would hang Jest
 * and delay SIGTERM shutdown).
 */
const SWEEP_INTERVAL_MS = 30000;

class MemoryDriver {
  constructor() {
    this.kind = 'memory';
    this.isDistributed = false;
    this.store = new Map();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
  }

  /** Drops every expired entry. O(n) but n is bounded by the in-flight working set. */
  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.store.delete(key);
    }
  }

  readEntry(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key) {
    const entry = this.readEntry(key);
    return entry ? entry.value : null;
  }

  async set(key, value, ttlSeconds = null) {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null
    });
    return true;
  }

  /**
   * Set-if-absent. Atomic with respect to the event loop: there is no await between
   * the read and the write, so no two callers can both observe an absent key.
   */
  async setNx(key, value, ttlSeconds = null) {
    if (this.readEntry(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key) {
    return this.store.delete(key);
  }

  /**
   * Compare-and-delete, used to release an idempotency lock we own without deleting
   * a lock another request has since taken.
   */
  async delIfValue(key, expectedValue) {
    const entry = this.readEntry(key);
    if (!entry || entry.value !== expectedValue) return false;
    this.store.delete(key);
    return true;
  }

  /** Fixed-window counter: the TTL is set on the first increment only. */
  async incr(key, ttlSeconds = null) {
    const entry = this.readEntry(key);
    const next = (entry ? Number.parseInt(entry.value, 10) || 0 : 0) + 1;
    this.store.set(key, {
      value: String(next),
      expiresAt: entry ? entry.expiresAt : ttlSeconds ? Date.now() + ttlSeconds * 1000 : null
    });
    return next;
  }

  async ttl(key) {
    const entry = this.readEntry(key);
    if (!entry || entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async ping() {
    return 'PONG';
  }

  async close() {
    clearInterval(this.sweeper);
    this.store.clear();
  }
}

module.exports = { MemoryDriver };
