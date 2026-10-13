require('dotenv').config();

const env = {
  NODE_ID: process.env.NODE_ID || 'NODE_LOCAL',
  PORT: parseInt(process.env.PORT || '3000', 10),
  MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/airline_inventory?replicaSet=rs0',
  NODE_ENV: process.env.NODE_ENV || 'development',
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3', 10),
  RETRY_INITIAL_DELAY_MS: parseInt(process.env.RETRY_INITIAL_DELAY_MS || '15', 10),
  RETRY_MAX_DELAY_MS: parseInt(process.env.RETRY_MAX_DELAY_MS || '80', 10),
  SWAGGER_ENABLED: process.env.SWAGGER_ENABLED !== 'false'
};

module.exports = env;

