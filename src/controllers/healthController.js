/**
 * Health endpoints.
 *
 * `/api/health` answers 200 with a report whenever the process can produce one, even
 * when a dependency is down, and 503 only when the write model is unreachable. The
 * distinction matters because the three probes have three different consumers:
 *
 *   /live   the orchestrator's restart decision. Never touches a dependency.
 *   /ready  the load balancer's routing decision. 503 means "take me out".
 *   /health a dashboard or a human. A report that says DEGRADED is *more* useful than
 *           a 503, and a proxy that scrapes /health would otherwise restart pods
 *           during a read-model outage that does not affect booking at all.
 */
const healthService = require('../services/healthService');
const errors = require('../utils/errors');
const { ok } = require('../http/respond');

async function health(req, res) {
  const report = await healthService.report();

  if (report.status === 'DOWN') {
    // The report is attached to the error so the 503 still carries the diagnosis
    // rather than a bare "unavailable".
    throw new errors.DatabaseUnavailableError('The write model is not reachable', {
      checks: report.checks,
      latencyMs: report.latencyMs,
      writeError: report.writeError
    });
  }

  return ok(res, report);
}

function live(req, res) {
  return ok(res, healthService.live());
}

async function ready(req, res) {
  return ok(res, await healthService.ready());
}

module.exports = { health, live, ready };
