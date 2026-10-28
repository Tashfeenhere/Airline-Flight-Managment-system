/**
 * The HTTP surface, assembled in one place.
 *
 * Every router module exports `{ router, path }` rather than hard-coding its own mount
 * point. That is what lets this file be the single description of the API's shape — the
 * list below *is* the route table — and it is what lets the OpenAPI document's paths
 * (`/api/flights/{flightId}`) be checked against real mounts instead of hoped for.
 *
 * Order matters twice here:
 *
 *   - `/metrics` is not under `/api`, so it is mounted before the routers whose paths
 *     all begin with `/api`. It would still match either way, but keeping the odd one
 *     out first makes the exception visible.
 *   - `notFound` is last, and only last. Any handler registered after it would be
 *     unreachable, since it answers every request that fell through.
 */
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const spec = require('../openapi/swaggerSpec');
const notFound = require('../middleware/notFound');

const authRoutes = require('./authRoutes');
const flightRoutes = require('./flightRoutes');
const bookingRoutes = require('./bookingRoutes');
const userRoutes = require('./userRoutes');
const healthRoutes = require('./healthRoutes');
const adminRoutes = require('./adminRoutes');
const metricsRoutes = require('./metricsRoutes');

/** Mounted in this order; the array is the API's table of contents. */
const routers = [
  metricsRoutes,
  authRoutes,
  flightRoutes,
  bookingRoutes,
  userRoutes,
  healthRoutes,
  adminRoutes
];

function buildRouter() {
  const router = express.Router();

  for (const { router: child, path } of routers) {
    router.use(path, child);
  }

  // Real-time Event Backbone Server-Sent Events (SSE) stream for Control Room UI
  const { sseStreamHandler, getRecentEvents } = require('../services/eventStreamService');
  const { TEST_REGISTRY, executeScenario, getLiveDockerContainers, stopDockerContainer, startDockerContainer } = require('../services/testRunnerService');
  const path = require('path');
  const fs = require('fs');
  const { spawn } = require('child_process');

  router.get('/api/stream', sseStreamHandler);
  router.get('/api/stream/recent', (req, res) => res.json({ ok: true, events: getRecentEvents() }));
  router.get('/api/lab/tests', (req, res) => res.json({ ok: true, tests: Object.values(TEST_REGISTRY) }));
  

  router.get('/api/lab/docker/containers', (req, res) => {
    try {
      const containers = getLiveDockerContainers();
      res.json({ ok: true, containers });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/api/lab/docker/stop', (req, res) => {
    const containerName = req.body?.containerName || 'airline_worker2';
    console.log(`\n================================================================================`);
    console.log(`[DOCKER_CONTROL] >>> MANUAL STOP TRIGGERED ON CONTAINER [${containerName}] <<<`);
    try {
      const result = stopDockerContainer(containerName);
      console.log(`[DOCKER_CONTROL] Container [${containerName}] marked STOPPED!`);
      console.log(`================================================================================\n`);
      res.json({ ok: true, status: 'STOPPED', containerName, message: `Container ${containerName} stopped successfully.` });
    } catch (err) {
      console.error(`[DOCKER_CONTROL] Error stopping container [${containerName}]:`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/api/lab/docker/start', async (req, res) => {
    const containerName = req.body?.containerName || 'airline_worker2';
    console.log(`\n================================================================================`);
    console.log(`[DOCKER_CONTROL] >>> MANUAL START TRIGGERED ON CONTAINER [${containerName}] <<<`);
    try {
      startDockerContainer(containerName);
      console.log(`[DOCKER_CONTROL] Container [${containerName}] marked RUNNING!`);
      
      const projectionService = require('../services/projectionService');
      const drainRes = await projectionService.runOnce({ limit: 50 }).catch(() => ({ projected: 0 }));
      console.log(`[DOCKER_CONTROL] Drained ${drainRes.projected || 0} pending outbox events into search read replica.`);
      console.log(`================================================================================\n`);
      res.json({ ok: true, status: 'RUNNING', containerName, projected: drainRes.projected || 0, message: `Container ${containerName} restarted and projections drained.` });
    } catch (err) {
      console.error(`[DOCKER_CONTROL] Error starting container [${containerName}]:`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/api/lab/launch-cmd', (req, res) => {
    const testId = req.body?.testId || 'LOAD_TEST_BURST';
    console.log(`\n[API_LAB] >>> RECEIVED CMD LAUNCH REQUEST FOR [${testId}] <<<`);
    try {
      const { exec } = require('child_process');
      const projectRoot = path.resolve(__dirname, '../../');
      
      let cmdToRun;
      if (testId === 'LOAD_TEST_BURST') {
        cmdToRun = `start "AeroScale 1M Load Test Console" cmd.exe /c "call scripts\\run-load-test-cmd.bat ${testId}"`;
      } else if (testId === 'AUDIT_INVARIANTS' || testId === 'audit') {
        cmdToRun = `start "AeroScale System Audit Console" cmd.exe /c "call audit.bat"`;
      } else {
        cmdToRun = `start "AeroScale Live Test Console - [${testId}]" cmd.exe /c "call scripts\\run-test-cmd.bat ${testId}"`;
      }

      console.log(`[API_LAB] Spawning CMD window: ${cmdToRun} in ${projectRoot}`);
      exec(cmdToRun, { cwd: projectRoot }, (err) => {
        if (err) {
          console.error(`[API_LAB] Error spawning CMD for [${testId}]:`, err.message);
        }
      });
      
      console.log(`[API_LAB] Successfully launched Windows CMD terminal for [${testId}]`);
      res.json({ ok: true, message: `Spawned CMD console window for ${testId} successfully` });
    } catch (err) {
      console.error(`[API_LAB] Failed to launch CMD for [${testId}]:`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/api/lab/run/:testId', async (req, res) => {
    console.log(`\n[API_LAB] >>> RECEIVED TEST EXECUTION REQUEST: [${req.params.testId}] <<<`);
    try {
      const result = await executeScenario(req.params.testId);
      res.json({ ok: true, result });
    } catch (err) {
      console.error(`[API_LAB] Error executing scenario [${req.params.testId}]:`, err.message);
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // The document itself, and the browsable UI. Served from the same object the app
  // routes were written against, so what a client reads cannot drift from what the
  // handlers do without the diff being visible.
  router.get('/api-docs.json', (req, res) => res.json(spec));
  router.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Airline Inventory API',
      // The raw document is one link away, which is what a client generator wants;
      // burying it under the UI's own JS is how teams end up scraping the HTML.
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true }
    })
  );

  router.use(notFound);

  return router;
}

module.exports = buildRouter;
module.exports.routers = routers;
