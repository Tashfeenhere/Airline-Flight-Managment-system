/**
 * Dependency-free request validator.
 *
 * A schema-driven whitelist for `body`, `query` and `params`. Three properties are
 * non-negotiable and drive the whole design:
 *
 *   1. Whitelisting. Only declared fields survive into the cleaned object. This is
 *      the primary defence against mass-assignment: a client cannot smuggle
 *      `{ role: 'ADMIN' }` past the schema into an `INSERT ... SET`.
 *   2. Coercion. Query string and path parameters arrive as strings; `?page=2` must
 *      become the number 2 before it reaches SQL. Body values arrive already typed
 *      and are validated, not re-parsed from text.
 *   3. Total failure reporting. The first bad field is not thrown on — every field
 *      is checked and all failures are returned together, so a client fixes their
 *      request in one round trip instead of one field at a time.
 *
 * The pure helpers (isUuid, parseDateOnly, coerce) are exported for direct testing.
 */
const { ValidationError } = require('../utils/errors');

// 8-4-4-4-12 hex. Deliberately a shape check, not a version check: the database
// generates UUIDv7 primary keys while existing rows may hold v4, and both are valid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A calendar date with no time component. Anything looser lets '2026-2-3' through,
// which the `date` column would reject with an opaque SQLSTATE.
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Decimal/exponent numbers only. Rejects '', 'NaN', 'Infinity', '0x10', '1px' —
// Number() would happily turn several of those into a number we never wanted.
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1];
}

/**
 * Validates 'YYYY-MM-DD' and returns that exact string, or null.
 *
 * It returns the STRING, never a JS Date: the target column is `date` (no time, no
 * zone), and a Date object would drag the server's local zone back in — parsing
 * '2026-03-01' as UTC then formatting in local time can silently shift the day.
 * Keeping the string is the only representation with no timezone to get wrong.
 *
 * The day-count check is manual (rather than `new Date(...)`) so years 0-99 are not
 * remapped by the Date constructor's two-digit-year behaviour.
 */
function parseDateOnly(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  const match = DATE_ONLY_RE.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return trimmed;
}

/**
 * Coerces a raw value to the declared type.
 *
 * @returns {{ ok: true, value: any } | { ok: false }} — a result object rather than
 * a thrown error, so the caller can attach a field-specific message and keep going.
 */
function coerce(value, type) {
  switch (type) {
    case undefined:
    case null:
    case 'any':
      // No declared type: pass the value through (still whitelisted by the schema).
      return { ok: true, value };

    case 'string':
      // Strict: a number is not silently stringified into an ID field.
      return typeof value === 'string' ? { ok: true, value } : { ok: false };

    case 'number':
      return coerceNumber(value, false);

    case 'integer':
      return coerceNumber(value, true);

    case 'boolean':
      return coerceBoolean(value);

    case 'uuid':
      return isUuid(value) ? { ok: true, value: value.trim().toLowerCase() } : { ok: false };

    case 'date': {
      const parsed = parseDateOnly(value);
      return parsed === null ? { ok: false } : { ok: true, value: parsed };
    }

    case 'array':
      return Array.isArray(value) ? { ok: true, value: value.slice() } : { ok: false };

    case 'object':
      return isRecord(value) ? { ok: true, value: { ...value } } : { ok: false };

    default:
      return { ok: false };
  }
}

function coerceNumber(value, integerOnly) {
  let num;

  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!NUMERIC_RE.test(trimmed)) return { ok: false };
    num = Number(trimmed);
  } else {
    return { ok: false };
  }

  // Number.isFinite rejects NaN and +/-Infinity in one check.
  if (!Number.isFinite(num)) return { ok: false };
  if (integerOnly && !Number.isInteger(num)) return { ok: false };

  return { ok: true, value: num };
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return { ok: true, value };

  if (typeof value === 'number') {
    if (value === 1) return { ok: true, value: true };
    if (value === 0) return { ok: true, value: false };
    return { ok: false };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true' || trimmed === '1') return { ok: true, value: true };
    if (trimmed === 'false' || trimmed === '0') return { ok: true, value: false };
  }

  return { ok: false };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeMessage(field, type) {
  switch (type) {
    case 'uuid':
      return `${field} must be a valid UUID`;
    case 'date':
      return `${field} must be a valid date in YYYY-MM-DD format`;
    case 'integer':
      return `${field} must be an integer`;
    case 'number':
      return `${field} must be a number`;
    case 'boolean':
      return `${field} must be a boolean`;
    case 'array':
      return `${field} must be an array`;
    case 'object':
      return `${field} must be an object`;
    default:
      return `${field} must be a ${type}`;
  }
}

function sizeOf(value) {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  return null;
}

function unitOf(value) {
  return Array.isArray(value) ? 'items' : 'characters';
}

/**
 * Applies one field rule. Pushes zero or more entries onto `errors` and returns
 * `{ include, value }` — `include:false` means the field is left out of the result
 * entirely (rather than set to `undefined`) so SQL column defaults still apply.
 *
 * `allValues` is the cleaned object built so far, handed to `transform` so a later
 * field can derive from an earlier one.
 */
function applyRule(field, rule, rawValue, allValues, errors) {
  const { type } = rule;
  const absent = rawValue === undefined || rawValue === null;
  let received = rawValue;
  let value;

  if (absent) {
    if (rule.default === undefined) {
      if (rule.required) {
        errors.push({ field, message: `${field} is required`, received: rawValue });
      }
      return { include: false };
    }
    // A default is only a default: an explicitly supplied value always wins.
    value = rule.default;
    received = rule.default;
  } else {
    value = rawValue;
  }

  const coerced = coerce(value, type);
  if (!coerced.ok) {
    errors.push({ field, message: typeMessage(field, type), received });
    return { include: false };
  }
  value = coerced.value;

  // Normalise strings before length/pattern checks so trimming is reflected.
  if (typeof value === 'string') {
    if (rule.trim) value = value.trim();
    if (rule.lowercase) value = value.toLowerCase();
  }

  if (type === 'number' || type === 'integer') {
    if (rule.min !== undefined && value < rule.min) {
      errors.push({ field, message: `${field} must be greater than or equal to ${rule.min}`, received });
      return { include: false };
    }
    if (rule.max !== undefined && value > rule.max) {
      errors.push({ field, message: `${field} must be less than or equal to ${rule.max}`, received });
      return { include: false };
    }
  }

  if (rule.minLength !== undefined || rule.maxLength !== undefined) {
    const length = sizeOf(value);
    if (length === null) {
      errors.push({ field, message: `${field} must be a string or array`, received });
      return { include: false };
    }
    if (rule.minLength !== undefined && length < rule.minLength) {
      errors.push({
        field,
        message: `${field} must have at least ${rule.minLength} ${unitOf(value)}`,
        received
      });
      return { include: false };
    }
    if (rule.maxLength !== undefined && length > rule.maxLength) {
      errors.push({
        field,
        message: `${field} must have at most ${rule.maxLength} ${unitOf(value)}`,
        received
      });
      return { include: false };
    }
  }

  if (rule.pattern instanceof RegExp && typeof value === 'string' && !rule.pattern.test(value)) {
    // The pattern is echoed so the caller can see the constraint they violated.
    errors.push({ field, message: `${field} must match pattern ${rule.pattern}`, received });
    return { include: false };
  }

  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
    errors.push({ field, message: `${field} must be one of: ${rule.enum.join(', ')}`, received });
    return { include: false };
  }

  if (type === 'array' && rule.items) {
    const out = [];
    let itemFailed = false;

    value.forEach((entry, index) => {
      // `required:true` for elements: a null slot inside an array is a value the
      // caller sent, not an omission, so it must be validated, not dropped.
      const itemResult = applyRule(`${field}[${index}]`, { ...rule.items, required: true }, entry, allValues, errors);
      if (itemResult.include) out.push(itemResult.value);
      else itemFailed = true;
    });

    if (itemFailed) return { include: false };
    value = out;
  }

  if (typeof rule.transform === 'function') {
    value = rule.transform(value, allValues);
  }

  if (value === undefined) return { include: false };
  return { include: true, value };
}

/**
 * Builds the cleaned object for one source, throwing a single ValidationError that
 * carries every field failure when the source is invalid.
 */
function validateSource(source, schema, raw) {
  const input = isRecord(raw) ? raw : {};
  const cleaned = {};
  const errors = [];

  for (const field of Object.keys(schema)) {
    const rule = schema[field] || {};
    // `cleaned` is passed by reference and grows as fields resolve, so a transform
    // can depend on fields declared earlier in the schema.
    const result = applyRule(field, rule, input[field], cleaned, errors);
    if (result.include) cleaned[field] = result.value;
  }

  if (errors.length > 0) {
    // The collected failures are reported as `fields`, each naming its `path`. That is
    // the shape the OpenAPI document and docs/API.md both publish, so a client can
    // implement one parser for validation errors across every endpoint. The internal
    // name for the same thing is `field`, and the rename happens exactly here rather
    // than at a dozen push sites.
    throw new ValidationError('Request validation failed', {
      source,
      fields: errors.map(({ field, message, received }) => ({ path: field, message, received }))
    });
  }

  return cleaned;
}

/**
 * Installs the cleaned object as an own, writable data property on the request.
 *
 * Express 4 happens to make `req.query`/`req.params` writable own properties today,
 * but the accessor-based definitions other versions use have no setter, so a plain
 * `req.query = cleaned` would be silently ignored. defineProperty is correct either
 * way and guarantees downstream handlers see the whitelisted object.
 */
function setSource(req, source, cleaned) {
  Object.defineProperty(req, source, {
    value: cleaned,
    writable: true,
    enumerable: true,
    configurable: true
  });
}

/**
 * @param {{ body?: object, query?: object, params?: object }} schemas
 * @returns {import('express').RequestHandler}
 */
function validate(schemas = {}) {
  const sources = ['body', 'query', 'params'];

  return function validateRequest(req, res, next) {
    try {
      for (const source of sources) {
        const schema = schemas[source];
        if (!schema) continue;
        setSource(req, source, validateSource(source, schema, req[source]));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = validate;
module.exports.validate = validate;
module.exports.isUuid = isUuid;
module.exports.parseDateOnly = parseDateOnly;
module.exports.coerce = coerce;
