/**
 * Redis-backed cache driver.
 *
 * Same interface as the in-process driver, but shared across API instances — which
 * is the whole point: an Idempotency-Key must be recognised by whichever node the
 * client's retry lands on, not just the node that saw the original request.
 *
 * Connection posture:
 *   - `lazyConnect` so constructing the driver never blocks startup or a test run.
 *   - `maxRetriesPerRequest: 1` and `enableOfflineQueue: false`: when Redis is down we
 *     want a fast, explicit failure that the caller can fall back from, not requests
 *     queueing behind a reconnect loop. A cache outage must never become an API
 *     outage.
 *   - `SET key value NX PX ttl` is used for locking: the atomicity is in Redis, so two
 *     concurrent requests cannot both win the key.
 */
const logger = require('../utils/logger');

class RedisDriver {
  constructor(connectionString, options = {}) {
    // Required lazily so the module can be loaded (and the dependency resolved) even
    // in deployments that never configure Redis.
    const Redis = require('ioredis');
    this.kind = 'redis';
    this.isDistributed = true;
    this.prefix = options.prefix ? `${options.prefix}:` : '';
    this.client = new Redis(connectionString, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: options.connectTimeoutMs || 2000,
      // Reconnect with a bounded backoff: a long Redis outage must not spin.
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000)
    });

    // Without a listener ioredis emits an unhandled 'error' event and kills the
    // process; a cache blip must never take the API down.
    this.client.on('error', (err) => {
      logger.warn('Redis error', { error: err.message });
    });
  }

  key(k) {
    return `${this.prefix}${k}`;
  }

  async ensureConnected() {
    if (this.client.status === 'wait') await this.client.connect();
    return this.client;
  }

  async get(k) {
    await this.ensureConnected();
    return this.client.get(this.key(k));
  }

  async set(k, value, ttlSeconds = null) {
    await this.ensureConnected();
    if (ttlSeconds) {
      await this.client.set(this.key(k), value, 'EX', ttlSeconds);
    } else {
      await this.client.set(this.key(k), value);
    }
    return true;
  }

  async setNx(k, value, ttlSeconds = null) {
    await this.ensureConnected();
    const args = [this.key(k), value];
    if (ttlSeconds) args.push('PX', String(ttlSeconds * 1000));
    args.push('NX');
    const result = await this.client.set(...args);
    return result === 'OK';
  }

  async del(k) {
    await this.ensureConnected();
    return (await this.client.del(this.key(k))) > 0;
  }

  /**
   * Release a lock only if we still hold it. Doing this as a Lua script keeps the
   * compare and the delete atomic — a GET-then-DEL pair could delete a lock that
   * another request acquired between the two calls.
   */
  async delIfValue(k, expectedValue) {
    await this.ensureConnected();
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      else
        return 0
      end`;
    const result = await this.client.eval(script, 1, this.key(k), expectedValue);
    return Number(result) === 1;
  }

  /** Fixed-window counter: EXPIRE is applied only when the key is created. */
  async incr(k, ttlSeconds = null) {
    await this.ensureConnected();
    const full = this.key(k);
    const count = await this.client.incr(full);
    if (count === 1 && ttlSeconds) await this.client.expire(full, ttlSeconds);
    return count;
  }

  async ttl(k) {
    await this.ensureConnected();
    return this.client.ttl(this.key(k));
  }

  async ping() {
    await this.ensureConnected();
    return this.client.ping();
  }

  async close() {
    try {
      await this.client.quit();
    } catch (err) {
      // quit() throws when the connection was never established or is already gone;
      // disconnect() is the only way to release the socket in that state.
      this.client.disconnect();
    }
  }
}

module.exports = { RedisDriver };
