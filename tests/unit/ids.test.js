/**
 * Unit tests for `src/utils/ids.js`.
 *
 * These pin the properties the schema depends on, not the implementation: ids must be
 * genuine UUIDv7 (version 7, RFC 4122 variant, time-ordered) because `PK`s are UUIDv7 for
 * B-tree locality at billions of rows; references must fit the documented alphabets and
 * widths; and `toUuidOrNull` must return null rather than a string PostgreSQL will reject
 * with `22P02`.
 */
const ids = require('../../src/utils/ids');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('ids.newUuid — UUIDv7', () => {
  test('produces the 8-4-4-4-12 lower-case shape', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(ids.newUuid()).toMatch(UUID_RE);
    }
  });

  test('sets the version nibble to 7 and the RFC 4122 variant', () => {
    for (let i = 0; i < 50; i += 1) {
      const value = ids.newUuid();
      // Third group's first hex digit is the version.
      expect(value[14]).toBe('7');
      // Fourth group's first hex digit encodes the variant: 8, 9, a or b.
      expect(['8', '9', 'a', 'b']).toContain(value[19]);
    }
  });

  test('is time-ordered: a later id sorts after an earlier one', () => {
    const first = ids.newUuid();
    const second = ids.newUuid();
    // UUIDv7 puts a 48-bit millisecond timestamp first, so byte order is time order.
    expect(second > first).toBe(true);
  });

  test('pads the 48-bit timestamp correctly across a small gap', async () => {
    const before = ids.newUuid();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = ids.newUuid();
    // The first 12 hex chars are the timestamp; compare them as integers.
    const left = Number.parseInt(before.replace(/-/g, '').slice(0, 12), 16);
    const right = Number.parseInt(after.replace(/-/g, '').slice(0, 12), 16);
    expect(right).toBeGreaterThanOrEqual(left);
  });

  test('is unique across a burst', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(ids.newUuid());
    expect(seen.size).toBe(5000);
  });
});

describe('ids.isValidUuid / toUuidOrNull', () => {
  test('accepts v4 and v7, upper and lower case', () => {
    expect(ids.isValidUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    expect(ids.isValidUuid('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(true);
    expect(ids.isValidUuid(ids.newUuid())).toBe(true);
  });

  test('rejects non-UUID shapes without throwing', () => {
    for (const bad of ['', 'not-a-uuid', '018f0a1e7c0070008000000000000000', null, undefined, 42, {}]) {
      expect(ids.isValidUuid(bad)).toBe(false);
    }
  });

  test('toUuidOrNull normalises case and returns null for garbage', () => {
    expect(ids.toUuidOrNull('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(
      'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    );
    expect(ids.toUuidOrNull('  f47ac10b-58cc-4372-a567-0e02b2c3d479  ')).toBe(
      'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    );
    expect(ids.toUuidOrNull('nope')).toBeNull();
    expect(ids.toUuidOrNull(null)).toBeNull();
    expect(ids.toUuidOrNull(undefined)).toBeNull();
  });
});

describe('ids.generateBookingReference', () => {
  test('is BK- plus 10 Crockford base32 characters', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(ids.generateBookingReference()).toMatch(/^BK-[0-9A-HJKMNP-TV-Z]{10}$/);
    }
  });

  test('does not collide across a realistic burst', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(ids.generateBookingReference());
    expect(seen.size).toBe(5000);
  });
});

describe('ids.randomToken / safeEqual', () => {
  test('randomToken is URL-safe base64 of the requested length', () => {
    expect(ids.randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ids.randomToken(8)).toMatch(/^[A-Za-z0-9_-]{11}$/); // 8 bytes -> 11 chars unpadded
  });

  test('safeEqual compares by value and never throws on length mismatch', () => {
    expect(ids.safeEqual('abc', 'abc')).toBe(true);
    expect(ids.safeEqual('abc', 'abd')).toBe(false);
    expect(ids.safeEqual('abc', 'abcd')).toBe(false);
    expect(ids.safeEqual('', '')).toBe(true);
  });
});
