const crypto = require('crypto');

/**
 * Generates a unique, alphanumeric booking reference code (e.g., BK-7F9A12)
 */
function generateBookingReference() {
  const randomBytes = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `BK-${randomBytes}`;
}

module.exports = {
  generateBookingReference
};
