/**
 * Cabin pricing.
 *
 * A flight carries one `base_price`; the price of a cabin is derived from it by a
 * rank multiplier. That keeps the write model small (no price row per flight per
 * cabin) and makes a fare change a single-column update rather than a fan-out.
 *
 * This is deliberately the simplest thing that is not wrong: a real revenue-management
 * system would price on demand, day-of-week, and booking curve, and would live behind
 * this same function signature. Keeping it in one module is what makes that swap a
 * one-file change, and what makes every price in the system derivable from the same
 * rule — a booking, a search result and a seat map must never quote three different
 * numbers for one seat.
 */
const { ValidationError } = require('../utils/errors');

/** Multiplier by cabin code. Unknown cabins fall back to economy rather than failing. */
const CABIN_MULTIPLIERS = Object.freeze({
  ECONOMY: 1.0,
  PREMIUM_ECONOMY: 1.6,
  BUSINESS: 3.2,
  FIRST: 5.5
});

/**
 * Rounds to cents with the half-up behaviour a fare table is expected to have.
 * Math.round on the cent value avoids the classic `0.1 + 0.2` binary-float artefact
 * appearing in a customer-visible amount.
 */
function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}

function multiplierFor(cabin) {
  return CABIN_MULTIPLIERS[cabin] || CABIN_MULTIPLIERS.ECONOMY;
}

/**
 * Price of one seat in `cabin` for a flight with `basePrice`.
 *
 * Throws on a non-finite base price instead of returning NaN: a NaN that reaches
 * PostgreSQL as a numeric insert fails deep in the driver with a confusing message,
 * and a NaN that reaches a JSON response is silently `null` to the client.
 */
function priceForCabin({ basePrice, cabin }) {
  const base = Number(basePrice);
  if (!Number.isFinite(base) || base < 0) {
    throw new ValidationError('Flight base price is not a valid amount', { basePrice, cabin });
  }
  return roundCents(base * multiplierFor(cabin));
}

/** Total for `passengers` seats, rounded once so it matches the sum of the lines. */
function totalPriceFor({ basePrice, cabin, passengers = 1 }) {
  return roundCents(priceForCabin({ basePrice, cabin }) * passengers);
}

module.exports = {
  CABIN_MULTIPLIERS,
  priceForCabin,
  totalPriceFor,
  multiplierFor,
  roundCents
};
