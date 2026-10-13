const express = require('express');
const bookingController = require('../controllers/bookingController');
const {
  validateCreateBooking,
  validateBookingIdentifierParam
} = require('../middleware/validator');

const router = express.Router();

router.post('/', validateCreateBooking, bookingController.createBooking);
router.get('/:bookingId', validateBookingIdentifierParam, bookingController.getBooking);
router.post('/:bookingId/cancel', validateBookingIdentifierParam, bookingController.cancelBooking);
router.delete('/:bookingId', validateBookingIdentifierParam, bookingController.cancelBooking);

module.exports = router;
