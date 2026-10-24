# Kubernetes deployment

These manifests run the same image as `docker-compose.yml` in three workload shapes:

| Workload | Command | Why separate |
| --- | --- | --- |
| `airline-api` (Deployment + HPA) | `node src/server.js` | Stateless HTTP; scales on request load |
| `airline-workers` (Deployment) | `node scripts/run-workers.js` | Outbox projection, reaper, saga reconciler; scaling is independent of HTTP |
| `airline-migrate` (Job) | `node scripts/migrate.js` | Must finish before new code serves traffic |
| `airline-partitions` (CronJob) | `node scripts/partition-maintenance.js` | A missing monthly partition makes those flights unbookable |

The managed datastores (Citus coordinator, read-model PostgreSQL, Redis) are *not*
included. Point `airline-secrets` at them; running stateful database pods in this
namespace would make upgrades and backups harder than the managed services almost
certainly already in use.

## Apply order

```bash
# 0. Put the real credentials in the cluster first. Never apply secret.example.yaml
#    as-is, and never commit a filled-in Secret.
kubectl -n airline create secret generic airline-secrets \
  --from-literal=CITUS_COORDINATOR_URL='postgres://...' \
  --from-literal=PGBOUNCER_URL='postgres://...' \
  --from-literal=READMODEL_URL='postgres://...' \
  --from-literal=REDIS_URL='rediss://...' \
  --from-literal=JWT_ACCESS_SECRET="$(openssl rand -base64 48)" \
  --from-literal=JWT_REFRESH_SECRET="$(openssl rand -base64 48)"

# 1. Namespace, config, API, workers, services, HPA, PDB, CronJob, policies.
kubectl apply -k deploy/k8s

# 2. Schema. Do this BEFORE rolling a new image (and after every release that adds a
#    migration). The Job is not part of kustomization because an already-complete Job
#    will not re-run on `apply`.
kubectl -n airline delete job airline-migrate --ignore-not-found
kubectl -n airline apply -f deploy/k8s/migrate-job.yaml
kubectl -n airline wait --for=condition=complete job/airline-migrate --timeout=10m

# 3. Seed or import if this is a fresh environment.
#    (Run as a one-off Job or from a bastion; the loader is not part of the manifests.)
node scripts/backfill.js --source synthetic --start 2027-01-01 --days 90 \
  --flights-per-day 50 --outbox --reproject
```

## Image

The manifests reference `ghcr.io/example/distributed-airline-inventory:2.0.0` as a
placeholder. Replace it with your registry path, preferably by digest:

```bash
kubectl -n airline set image deployment/airline-api \
  api=ghcr.io/acme/airline@sha256:...
kubectl -n airline set image deployment/airline-workers \
  workers=ghcr.io/acme/airline@sha256:...
```

The `Release` workflow publishes the image and prints these commands with the digest
already filled in.

## Probes

| Endpoint | Used for | Why |
| --- | --- | --- |
| `/api/health/live` | liveness, startup | Synchronous; touches no dependency. A database outage must not restart pods. |
| `/api/health/ready` | readiness | 503 when the write model is unreachable, which removes the pod from the Service. |
| `:9464/api/health/live` | worker liveness/readiness | Worker-only listener; the worker image does not bind `PORT`. |
| `:3000/metrics`, `:9464/metrics` | Prometheus | Bounded-label metrics; see `deploy/observability/alerts.yml`. |

`terminationGracePeriodSeconds: 30` matches the application's 15-second shutdown
deadline plus room for the preStop sleep. The API closes idle keep-alive connections
explicitly so a rollout does not wait out the 65-second keep-alive timeout.

## Scaling and availability

- API: HPA 2→10 on 70% CPU, scale-down stabilization 300s (a booking burst is followed
  by retries still draining). PDB `minAvailable: 1`.
- Workers: 2 replicas, PDB `minAvailable: 1`. Safe because projections are guarded
  upserts and outbox events are marked published only after projection; reaper claims
  make double expiry impossible. If outbox lag is the problem, scale workers before
  scaling API.
- `topologySpreadConstraints` keep replicas on different nodes where possible.

## Partition horizon

The CronJob runs daily at 02:17 UTC with `PARTITION_MONTHS_AHEAD=6` from the ConfigMap.
Confirm after the first run:

```bash
kubectl -n airline logs job/$(kubectl -n airline get jobs -o name | grep airline-partitions | tail -1 | cut -d/ -f2)
```

A partition gap is not a gradual degradation: bookings for the affected month fail
immediately with `no partition of relation ... found`. The alert for this does not
exist because it is not a metric — watch the CronJob's failure count.

## NetworkPolicy

`default-deny-ingress` plus explicit allows: ingress-controller → API:3000, monitoring →
API:3000 and workers:9464. Egress is unrestricted on purpose; a default-deny egress rule
must enumerate the coordinator, read database, Redis, DNS and the registry, and a wrong
list turns a security improvement into an outage. Add the commented egress rule once
those CIDRs are fixed, on a CNI that enforces policy (Calico/Cilium/Azure CNI — Kind's
default CNI does not).

## What is not here

- **Ingress/TLS**: platform-specific; create an Ingress pointing at `airline-api:80`.
- **Certificates/secrets rotation**: use External Secrets Operator or your secret
  manager. `secret.example.yaml` is a key inventory, not a deployment mechanism.
- **Alertmanager routing**: see `deploy/observability/prometheus.yml`; wire it to the
  on-call rotation in the platform's Alertmanager.
- **Backups**: managed by the database services; see `docs/RUNBOOK.md` §13.
