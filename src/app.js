const express = require('express');
const env = require('./config/env');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');
const { swaggerRouter, swaggerSpec } = require('./docs/swaggerRouter');
const { NotFoundError } = require('./utils/errors');
const { HTTP_STATUS } = require('./config/constants');

const app = express();

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Attach request tracking and logging headers
app.use(requestLogger);

// Mount OpenAPI / Swagger UI documentation
if (env.SWAGGER_ENABLED) {
  app.use('/api-docs', swaggerRouter);
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.status(HTTP_STATUS.OK).send(swaggerSpec);
  });
}

// Mount REST API endpoints
app.use('/api', routes);

// Root route
app.get('/', (req, res) => {
  res.status(HTTP_STATUS.OK).json({
    name: 'Distributed Airline Seat Inventory System',
    nodeId: env.NODE_ID,
    status: 'ONLINE',
    docs: '/api-docs',
    health: '/api/health'
  });
});

// 404 handler for undefined routes
app.use((req, res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));
});

// Centralized error handler
app.use(errorHandler);

module.exports = app;
