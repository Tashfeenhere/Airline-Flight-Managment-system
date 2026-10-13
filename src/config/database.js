const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

let isConnected = false;

async function connectDB(customUri = null) {
  const uri = customUri || env.MONGO_URI;

  if (isConnected && mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 50 // Accommodate high concurrent requests from multiple nodes
    });

    isConnected = true;
    logger.info(`Connected to MongoDB: ${conn.connection.host}/${conn.connection.name}`);

    // Ensure models are registered and indexes are created
    require('../models/flight.model');
    require('../models/seat.model');
    require('../models/booking.model');

    await Promise.all([
      mongoose.model('Flight').init(),
      mongoose.model('Seat').init(),
      mongoose.model('Booking').init()
    ]);

    logger.info('Database indexes synchronized successfully');

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', { error: err.message });
    });

    mongoose.connection.on('disconnected', () => {
      isConnected = false;
      logger.info('MongoDB disconnected');
    });

    return conn.connection;
  } catch (err) {
    logger.error('Failed to connect to MongoDB:', { error: err.message, uri });
    throw err;
  }
}

async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    isConnected = false;
    logger.info('Disconnected from MongoDB');
  }
}

module.exports = {
  connectDB,
  disconnectDB
};
