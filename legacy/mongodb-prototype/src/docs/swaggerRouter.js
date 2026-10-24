const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swaggerSpec');

const router = express.Router();

const swaggerOptions = {
  customSiteTitle: 'Distributed Airline Seat Inventory - API Documentation',
  customCss: `
    .swagger-ui .topbar { background-color: #1a202c; }
    .swagger-ui .topbar .topbar-wrapper img { content: url('https://img.icons8.com/color/48/airplane-take-off.png'); }
    .swagger-ui .info { margin: 20px 0; }
  `,
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: 'list',
    filter: true,
    showExtensions: true,
    showCommonExtensions: true
  }
};

// Serve raw OpenAPI JSON specification for developer tooling / Postman imports
router.get('/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(swaggerSpec);
});

// Serve Swagger UI
router.use('/', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerOptions));

module.exports = {
  swaggerRouter: router,
  swaggerSpec
};
