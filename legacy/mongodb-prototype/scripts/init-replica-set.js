const { MongoClient } = require('mongodb');
const seedData = require('./seed');
const logger = require('../src/utils/logger');

const MONGO_HOST = process.env.MONGO_HOST || 'mongo:27017';
const REPLSET_NAME = process.env.REPLSET_NAME || 'rs0';

async function initReplicaSet() {
  const directUri = `mongodb://${MONGO_HOST}/?directConnection=true`;
  logger.info(`Connecting directly to MongoDB at ${directUri} to initialize replica set...`);

  let client;
  let retries = 30;

  while (retries > 0) {
    try {
      client = new MongoClient(directUri, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      break;
    } catch (err) {
      retries--;
      logger.info(`Waiting for MongoDB to be ready... (${retries} retries remaining)`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!client) {
    logger.error('Could not connect to MongoDB after multiple attempts.');
    process.exit(1);
  }

  const adminDb = client.db('admin');

  try {
    // Check if replica set is already initialized
    try {
      const status = await adminDb.command({ replSetGetStatus: 1 });
      if (status.ok === 1) {
        logger.info('Replica set is already initialized.');
      }
    } catch (err) {
      // If replSetGetStatus fails with code 94 (NotYetInitialized), initialize it
      logger.info(`Initiating replica set '${REPLSET_NAME}'...`);
      await adminDb.command({
        replSetInitiate: {
          _id: REPLSET_NAME,
          members: [{ _id: 0, host: MONGO_HOST }]
        }
      });
      logger.info('Replica set initiation command sent.');
    }

    // Wait until this member is primary
    logger.info('Waiting for replica set primary election...');
    let isPrimary = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const helloResult = await adminDb.command({ hello: 1 });
      if (helloResult.isWritablePrimary || helloResult.ismaster) {
        isPrimary = true;
        logger.info('Replica set primary is ready!');
        break;
      }
    }

    if (!isPrimary) {
      logger.error('Replica set failed to elect a primary in time.');
      process.exit(1);
    }

    await client.close();

    // Now seed the database using the replica set connection URI
    const replicaSetUri = `mongodb://${MONGO_HOST}/airline_inventory?replicaSet=${REPLSET_NAME}`;
    logger.info(`Seeding initial data using replica set connection: ${replicaSetUri}`);
    await seedData(replicaSetUri);
    logger.info('Replica set initialization and data seeding finished successfully!');
    process.exit(0);
  } catch (err) {
    logger.error('Error during replica set initiation:', { error: err.message });
    if (client) await client.close();
    process.exit(1);
  }
}

if (require.main === module) {
  initReplicaSet();
}

module.exports = initReplicaSet;
