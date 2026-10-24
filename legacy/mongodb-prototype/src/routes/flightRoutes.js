const express = require('express');
const flightController = require('../controllers/flightController');
const {
  validateFlightIdParam,
  validateFlightSeatsQuery,
  validateFlightSearchQuery
} = require('../middleware/validator');

const router = express.Router();

router.get('/', validateFlightSearchQuery, flightController.getAllFlights);
router.get('/:flightId', validateFlightIdParam, flightController.getFlightById);
router.get('/:flightId/seats', validateFlightIdParam, validateFlightSeatsQuery, flightController.getFlightSeats);

module.exports = router;
