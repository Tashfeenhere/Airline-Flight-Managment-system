# Docker Deployment & Orchestration Guide

This project includes a multi-service distributed architecture running on Docker and Docker Compose.

---

## 1. System Services in Docker Compose

The stack is defined in [`docker-compose.yml`](file:///c:/Users/all%20okkkk/Downloads/distributed-airline-inventory-main/distributed-airline-inventory-main/docker-compose.yml):

| Service | Image / Build | Port | Purpose |
| :--- | :--- | :--- | :--- |
| **`coordinator`** | `citusdata/citus:14.2.0-pg17` | `5432` | Citus Distributed Coordinator (SQL router, distributed query planner) |
| **`worker1`** | `citusdata/citus:14.2.0-pg17` | *Internal* | Citus Shard Storage Worker 1 |
| **`worker2`** | `citusdata/citus:14.2.0-pg17` | *Internal* | Citus Shard Storage Worker 2 |
| **`readmodel`** | `postgres:17` | `5433` | CQRS Read-Model Database (`flight_availability` and projections) |
| **`redis`** | `redis:7-alpine` | `6379` | Idempotency records (`SET NX`), booking locks, rate limit counters |
| **`pgbouncer`** | `edoburu/pgbouncer:latest` | `6432` | Transaction-pooling connection pooler |
| **`api`** | `./Dockerfile` | `3000` | Express API tier (stateless, horizontally scalable) |
| **`frontend`** | `./frontend/Dockerfile` | `80`, `5173` | Nginx production server delivering React/Vite UI with SSE reverse proxy |
| **`migrate`** | `./Dockerfile` (`--profile tools`) | *One-shot* | Database migration runner (`scripts/migrate.js`) |
| **`workers`** | `./Dockerfile` (`--profile workers`) | `9464` | Background hold reaper, outbox publisher, and saga reconciler |
| **`prometheus`** | `prom/prometheus:v3.1.0` (`--profile observability`) | `9090` | Metrics scraper & alerting rules |

---

## 2. Windows Docker Installation Instructions

Docker requires Windows Hyper-V / WSL2 virtualization capabilities. To install on Windows:

1. Open **PowerShell as Administrator** and run:
   ```powershell
   winget install Docker.DockerDesktop
   ```
2. Restart your computer when prompted by Windows to activate virtualization.
3. Open **Docker Desktop** from the Start Menu and verify it is running in the system tray.

---

## 3. Launching the Docker Stack

You can start the entire stack in one command using the automated script:
```powershell
.\docker-start.bat
```

Or via direct Docker Compose commands:

### A. Start Core Datastores, API, and Frontend:
```bash
docker compose up -d coordinator worker1 worker2 readmodel redis pgbouncer api frontend
```

### B. Run Database Migrations:
```bash
docker compose --profile tools run --rm migrate
```

### C. Start Background Workers:
```bash
docker compose --profile workers up -d workers
```

### D. Optional Observability (Prometheus):
```bash
docker compose --profile observability up -d prometheus
```

---

## 4. Endpoints & URLs

- **Frontend Application**: [http://localhost:5173](http://localhost:5173) or [http://localhost](http://localhost)
- **Control Room & Test Lab**: [http://localhost:5173/admin/lab](http://localhost:5173/admin/lab)
- **API Swagger Documentation**: [http://localhost:3000/api-docs](http://localhost:3000/api-docs)
- **API Health Check**: [http://localhost:3000/api/health/live](http://localhost:3000/api/health/live)
- **Citus Coordinator DB**: `localhost:5432` (User: `airline`, Password: `airline`, DB: `airline_inventory`)
- **PgBouncer Connection**: `localhost:6432`
- **Read-Model DB**: `localhost:5433` (User: `airline`, Password: `airline`, DB: `airline_read`)
- **Prometheus Dashboard**: [http://localhost:9090](http://localhost:9090)
