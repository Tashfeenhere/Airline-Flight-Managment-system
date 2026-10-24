# =============================================================================
# Runtime image for the Distributed Airline Inventory API and workers.
#
# Multi-stage: dependencies are installed once in `deps` (production-only), and
# the smaller `runtime` stage copies the resulting node_modules. There is no
# build/compile step — the project is CommonJS with no bundler — so the "build"
# stage exists purely to keep npm's cache and dev dependencies out of the final
# image.
#
# The FULL source tree is copied, not a bundle: the migration runner
# (scripts/migrate.js) and the background workers (scripts/run-workers.js) are
# part of the runtime image's job, and they resolve `db/migrations` and `scripts`
# by relative path. A single-file bundle would break both. Copies are therefore
# scoped to exactly the directories the runtime needs (see .dockerignore for what
# stays out).
#
# Signal handling: the reaper and outbox pollers must receive SIGTERM to stop
# between batches. Node is not a good PID 1, so run the container with an init
# (`init: true` in docker-compose, or `docker run --init`) — see the compose file.
# =============================================================================

# ---- Stage 1: dependencies ---------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Copy manifests first so this layer is cached unless dependencies change.
COPY package.json package-lock.json ./

# --omit=dev: the runtime never needs jest/supertest. npm ci honours the lockfile
# exactly, which is what makes builds reproducible.
RUN npm ci --omit=dev

# ---- Stage 2: runtime --------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Runtime dependencies from the build stage.
COPY --from=deps /app/node_modules ./node_modules

# Manifests stay for `npm ls` / diagnostics.
COPY package.json package-lock.json ./

# Application code the process actually needs at runtime.
COPY src ./src
COPY scripts ./scripts
COPY db ./db

# The official node image ships an unprivileged `node` user (uid 1000). Run as it
# so a compromised process has no root. Own the app dir so nothing needs to be
# writable by root later.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# bookworm-slim has neither curl nor wget, but Node 20 has a global fetch. Probe
# the liveness endpoint only (no DB round trip), so a transient database blip
# does not mark the container unhealthy and trigger a restart loop.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
