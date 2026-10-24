const express = require('express');
const healthRoutes = require('./healthRoutes');
const flightRoutes = require('./flightRoutes');
const bookingRoutes = require('./bookingRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/flights', flightRoutes);
router.use('/bookings', bookingRoutes);

module.exports = router;
