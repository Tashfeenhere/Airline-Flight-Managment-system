/**
 * Health routes.
 *
 * Deliberately unauthenticated and unrated: these are consumed by an orchestrator and a
 * load balancer, and a probe that can be rate limited is a probe that will one day
 * report a healthy service as unhealthy — or, worse, cause a restart loop by being
 * throttled precisely when traffic (and therefore probe frequency) is highest.
 *
 * `/live` is synchronous and touches nothing. That is the whole point of separating it
 * from `/ready`: a liveness probe that pings the database restarts the process when the
 * database is down, which fixes nothing and turns one outage into two.
 */
const express = require('express');
const controller = require('../controllers/healthController');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(controller.health));
router.get('/live', controller.live);
router.get('/ready', asyncHandler(controller.ready));

module.exports = { router, path: '/api/health' };
