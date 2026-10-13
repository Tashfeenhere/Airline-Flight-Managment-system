const app = require('./app');
const env = require('./config/env');
const { connectDB, disconnectDB } = require('./config/database');
const logger = require('./utils/logger');

let server;

async function startServer() {
  try {
    await connectDB();

    server = app.listen(env.PORT, () => {
      logger.info(
        `Backend node instance started successfully: NODE_ID='${env.NODE_ID}', listening on port ${env.PORT}`
      );
    });

    const shutdown = async (signal) => {
      logger.info(`Received ${signal}. Gracefully shutting down node ${env.NODE_ID}...`);
      if (server) {
        server.close(async () => {
          logger.info('HTTP server closed.');
          await disconnectDB();
          process.exit(0);
        });
      } else {
        await disconnectDB();
        process.exit(0);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error('Fatal error during node bootstrap:', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, app };
