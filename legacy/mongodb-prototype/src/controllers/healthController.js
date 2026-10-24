const mongoose = require('mongoose');
const env = require('../config/env');
const { HTTP_STATUS } = require('../config/constants');

class HealthController {
  constructor() {
    this.getHealth = this.getHealth.bind(this);
  }

  async getHealth(req, res) {
    const isDbConnected = mongoose.connection.readyState === 1;

    res.status(isDbConnected ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      status: isDbConnected ? 'UP' : 'DEGRADED',
      nodeId: env.NODE_ID,
      port: env.PORT,
      database: isDbConnected ? 'CONNECTED' : 'DISCONNECTED',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  }
}

module.exports = new HealthController();
