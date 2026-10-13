const env = require('../config/env');
const { HEADERS } = require('../config/constants');

function requestLogger(req, res, next) {
  res.setHeader(HEADERS.NODE_ID, env.NODE_ID);
  res.setHeader(HEADERS.REQUEST_START, Date.now());
  next();
}

module.exports = requestLogger;
