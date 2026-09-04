# Alibaba Cloud validation deployment

This overlay is a short-lived, low-capacity ACK validation topology. It proves
the application deployment path, not production high availability. In
particular, `temporalio/auto-setup` runs as two discovery-connected pods for a
recovery demonstration and must be replaced by a supported, independently
scaled Temporal deployment before a production SLO is claimed.

Backend, Agent Service, Feature Service, and the validation Temporal topology
enforce required hostname anti-affinity for their two replicas. The application
deployments also retain `DoNotSchedule` hostname topology spread for explicit
skew control. The ACK cluster must therefore provide at least two schedulable
worker nodes. During a two-node drain, the expected safe state is one available
replica and one Pending replacement; the second replica must become Ready only
after a replacement node is available.

## Required cloud resources

- An ACK cluster and an ACR namespace in the same region. The GitHub-hosted
  promotion job uses the public `registry.<region>.aliyuncs.com` endpoint;
  workloads pull the identical digests through
  `registry-vpc.<region>.aliyuncs.com`.
- PostgreSQL 17/RDS standard edition reachable from ACK. PostgreSQL 17 is the
  newest documented major version that exposes both TimescaleDB and pgvector;
  PostgreSQL 18 exposes pgvector but not TimescaleDB. Create the application
  database plus the pre-created `temporal` and `temporal_visibility` databases;
  the Temporal user needs schema migration privileges on both Temporal databases.
- The validation overlay runs one disposable Redis Pod and one disposable
  ClickHouse Pod inside ACK. Both use `emptyDir`, contain synthetic data only,
  and are not evidence of Redis or ClickHouse high availability. ClickHouse
  initializes `ads.ads_agent_device_sleep_features` before Feature Service is
  accepted as ready for E3a smoke tests.
- Three ACR images built from `backend`, `services/agent-service`, and
  `services/feature-service`, addressed by immutable `sha256` digest.

Ten CNY is not sufficient for a persistent ACK + RDS + Redis + SLB stack. Use
a tightly timed validation window, confirm the live Alibaba Cloud quote before
creation, and delete billable resources after evidence capture.

## Required secrets

Create these Secrets outside Git, preferably through Alibaba Cloud KMS and an
External Secrets controller:

| Secret | Required keys |
| --- | --- |
| `backend-api-secrets` | Application `DATABASE_URL`, `REDIS_HOST=redis`, `REDIS_PORT=6379`, `REDIS_PASSWORD`, JWT and MQTT settings, plus `KNOWLEDGE_SERVICE_TOKEN` |
| `agent-service-secrets` | `database-url`, `model-api-key`, `model-base-url`, `feature-service-token`, `knowledge-service-token` |
| `feature-service-secrets` | `service-token`, `clickhouse-url=http://clickhouse:8123`, `clickhouse-user`, `clickhouse-password` |
| `temporal-secrets` | `database-host`, `database-user`, `database-password` |
| `postgres-backup-secret` | Backup database and object-storage credentials used by the existing CronJob |
| `acr-pull-secret` | Docker registry authentication for the private ACR namespace |

`agent-service-secrets/feature-service-token` and
`feature-service-secrets/service-token` must contain the same random value.
`agent-service-secrets/knowledge-service-token` and
`backend-api-secrets/KNOWLEDGE_SERVICE_TOKEN` must contain the same independent
random value.
Never commit generated Secret YAML or plaintext credentials.

## Build the immutable bundle

The `E3a ACK Deploy` workflow promotes the exact candidate archives through the
public ACR endpoint, verifies their registry digests and signatures, and renders
the deployment bundle with the same-region private pull endpoint. For a manual
bundle, first push all three images to ACR and retrieve their registry digests.
CIDRs should be the smallest routable ranges; use `/32` when a stable private
endpoint address is available.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File platform/k8s/scripts/New-DeploymentBundle.ps1 `
  -AcrPullRegistry <registry-vpc.region.aliyuncs.com> `
  -AcrNamespace <acr-namespace> `
  -SlbCertificateId <alibaba-slb-certificate-id> `
  -BackendDigest sha256:<64-hex> `
  -AgentDigest sha256:<64-hex> `
  -FeatureDigest sha256:<64-hex> `
  -BackendDatabaseCidr <rds-cidr> `
  -AgentDatabaseCidr <rds-cidr> `
  -TemporalDatabaseCidr <rds-cidr>
```

The generator renders Kustomize and rejects placeholder images, zero digests,
documentation CIDRs, missing dependencies, missing Secret references, or a
missing `LoadBalancer` entry. The generated file is intentionally ignored by
the design and must not be committed if it contains environment addresses.

## Database migration gate

Before applying the workload bundle, choose and record exactly one database
path from `backend/docs/MIGRATION_BASELINE_RUNBOOK.md`:

- a new empty RDS database initialized by the `backend-db-migrate` job; or
- an existing schema that has passed the baseline adoption dry run and explicit
  `--apply` step with verified backup evidence.

The migration stack must start with `20260000000000_baseline`. The migration
Job runs `prisma migrate deploy` and then the governed
`prisma/setup-timescaledb.sql` setup before workloads roll forward. A schema
diff, missing backup evidence, target identity mismatch, use of `prisma db
push`, or manual `prisma migrate resolve` blocks deployment. Preserve migration
job output, Prisma status, RDS backup ID, Git SHA, and image digest as E3
evidence.

Before the migration Job, set `shared_preload_libraries=timescaledb`, restart
the RDS instance if the parameter change requires it, and verify that
`pg_available_extensions` contains both `timescaledb` and `vector`. Preserve
the queried versions as E3 evidence; documentation compatibility alone does
not replace this instance-level check.

Record `SHOW timescaledb.license` and the JSON emitted by
`prisma/verify-timescaledb.sql`. A managed instance reporting `apache` is
accepted only in the explicit `apache-core` mode: both hypertables and indexes
must exist, and continuous aggregates, retention, compression, and refresh
policies must be reported as zero because that license does not expose those
automation features. Full/community mode retains the stricter 2/3/5/2/3
object gate. Do not claim policy deployment when the recorded mode is
`apache-core`.

## Apply and collect evidence

1. Apply all six runtime Secrets, then the generated bundle. The deploy gate
   refuses to continue if `postgres-backup-secret` is missing.
2. Wait for `backend-db-migrate` to complete before accepting API traffic.
3. Confirm Temporal, Feature Service, Agent Service, and Backend readiness.
4. Confirm the two replicas of each deployment are placed on distinct nodes.
5. Record the SLB address and run authenticated health and four-Agent smoke
   tests. Confirm Algorithm Agent remains approval-gated.
6. Exercise rollback to the previous three image digests.
7. Run an RDS backup restore and interrupt the Temporal pod during a waiting
   approval workflow; record successful recovery.
8. Drain one worker node, confirm one replica remains available, add or restore
   a second node, and confirm hard-separated replicas return to Ready.
9. Export logs/screenshots with timestamps and Git SHA, then remove short-lived
   resources according to the validation budget window.

Do not label the result production-ready until steps 4-8 have real ACK/RDS
evidence and the release is tied to a clean, committed Git SHA.
