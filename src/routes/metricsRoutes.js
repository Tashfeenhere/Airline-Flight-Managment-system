/**
 * Metrics route.
 *
 * Public and unrated on purpose. A Prometheus scraper hits this every 15 seconds from
 * one address; putting it under the general API budget would make the monitoring system
 * the first casualty of a traffic spike — precisely when its data matters most — and
 * requiring a token would mean the scrape credential has to be distributed to every
 * monitoring host.
 *
 * What is exposed is deliberately bounded: counters and histograms labelled by route
 * *pattern*, method and status. Nothing here is per-flight or per-user.
 */
const express = require('express');
const metrics = require('../observability/metrics');

const router = express.Router();

router.get('/', metrics.metricsHandler);

module.exports = { router, path: '/metrics' };
