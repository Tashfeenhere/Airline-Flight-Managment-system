#!/usr/bin/env node
/**
 * `npm run reaper:run` / `outbox:run` / `workers:run` — the CLI entry point for the
 * background workers.
 *
 * This file is a thin argv shim and deliberately nothing more. The supervisor in
 * `src/workers/runWorkers.js` owns the whole lifecycle — it starts the selected
 * workers, installs the SIGTERM/SIGINT handlers that let an in-flight pass settle
 * before the pools are closed, and holds the heartbeat that keeps the process alive.
 * Duplicating any of that here would mean two places that know how shutdown works, and
 * the one that is wrong would be discovered only during a deploy.
 *
 * Why the wrapper exists at all: package.json needs three npm scripts that differ only
 * by which workers they select, and every worker is otherwise identical at the process
 * level. Turning a selection name into a started worker set is the supervisor's job; this
 * file's only job is to turn argv into that name and to fail cleanly on a typo.
 *
 * Usage:
 *   node scripts/run-workers.js all        # outbox + reaper + saga (npm run workers:run)
 *   node scripts/run-workers.js reaper     # hold reaper only         (npm run reaper:run)
 *   node scripts/run-workers.js outbox     # outbox consumer only     (npm run outbox:run)
 *   node scripts/run-workers.js saga       # saga reconciler only
 *   node scripts/run-workers.js outbox,saga # any comma-separated subset
 *
 * Exit codes: 0 once the workers have started (the process then runs until a signal) /
 * 2 usage error — an unknown selection or option.
 */
'use strict';

const runner = require('../src/workers/runWorkers');

function usage(stream) {
  stream.write(
    `Usage: node scripts/run-workers.js [selection]\n\n` +
      `Starts background workers through src/workers/runWorkers.js and runs until SIGTERM/SIGINT.\n\n` +
      `Selection (default: WORKERS env or "all"):\n` +
      `  all       run every worker: outbox, reaper, saga\n` +
      `  outbox    outbox consumer — relays events into the read model\n` +
      `  reaper    hold reaper — expires PENDING holds and returns their seats\n` +
      `  saga      saga reconciler — drives unfinished bookings to a terminal state\n\n` +
      `Comma-separated subsets are accepted, e.g. "outbox,saga".\n\n` +
      `Options:\n` +
      `  --help, -h   Show this help.\n\n` +
      `Known workers: ${runner.KNOWN.join(', ')}, all\n`
  );
}

async function main() {
  const argv = process.argv.slice(2);

  // Help wins over everything else: asking how to run it must never start a worker.
  if (argv.includes('--help') || argv.includes('-h')) {
    usage(process.stdout);
    return 0;
  }

  const unknownFlags = argv.filter((arg) => arg.startsWith('-'));
  if (unknownFlags.length > 0) {
    console.error(`Error: unknown option(s): ${unknownFlags.join(', ')}`);
    usage(process.stderr);
    return 2;
  }

  // Positionals joined by comma so `run-workers.js outbox saga` means the same as
  // `run-workers.js outbox,saga` — and so a stray extra word is rejected as an unknown
  // worker instead of being silently ignored.
  const positionals = argv.filter((arg) => !arg.startsWith('-'));
  const selection = positionals.length > 0 ? positionals.join(',') : process.env.WORKERS || 'all';

  try {
    runner.parseSelection(selection);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    usage(process.stderr);
    return 2;
  }

  // `run` returns as soon as the workers are up; the heartbeat it holds is what keeps
  // the process alive, and its signal handlers are what bring it down cleanly. So there
  // is nothing to await past this point and nothing to close here.
  await runner.run(selection);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`Failed to start workers: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  });
