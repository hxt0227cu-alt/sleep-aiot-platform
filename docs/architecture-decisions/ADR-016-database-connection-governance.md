# ADR-016: Database Connection and Schema Change Governance

Status: Proposed

Date: 2026-07-31

Governed by ADR-012. Interacts with ADR-015.

## Context

Nothing in the repository bounds how many PostgreSQL connections the platform opens.

`backend/src/config/database.config.ts` is five lines and passes through `DATABASE_URL` unchanged. The DSN in `backend/.env.example:2` carries no `connection_limit` or `pool_timeout`. A repository-wide search for `pgbouncer` returns nothing. `PrismaService` (`backend/src/database/prisma.service.ts`) accepts the defaults.

Prisma's default pool size is `physical_cpu_count * 2 + 1`, evaluated against the machine Prisma observes rather than the cgroup CPU limit in `platform/k8s/base/backend-deployment.yaml:50-56`. On a 16-core node that is 33 connections per replica regardless of the `limits.cpu: 1` setting. At the `maxReplicas: 20` declared in `platform/k8s/base/backend-autoscaling.yaml:12`, backend alone reaches roughly 660 connections, before counting `feature-service`, `agent-service`, migration jobs and operator sessions.

Typical managed PostgreSQL instances in the size range this workload targets allow a few hundred connections. The autoscaler is therefore configured to scale the service into database connection exhaustion. The failure mode is the unpleasant kind: load rises, HPA adds replicas, new replicas cannot connect, health checks fail, the replicas are restarted, and the restart storm consumes the remaining connection headroom. Scaling out is the trigger, not the remedy.

Two adjacent defects surfaced while confirming this.

`backend/package.json` declares `@prisma/adapter-pg` at `^7.4.2` alongside `@prisma/client` at `^5.22.0`. The adapter is a major version ahead of the client and is not referenced anywhere in `src/`. It is an unused dependency that will not work as written if someone wires it up.

`backend/prisma/migrations/` holds six flat `.sql` files rather than Prisma's timestamped directory layout, with no `migration_lock.toml` and no `migrate` script in `package.json`. Schema changes are applied by a human running `psql`. This is survivable at one replica and one operator; it is not survivable alongside a `maxUnavailable: 0` rolling deploy, where old and new application versions run against one schema simultaneously.

## Decision

### The connection budget is declared, and per-replica limits are derived from it

`connection_limit` is set explicitly in every DSN. Defaults are not accepted, because the default is a function of the node the pod lands on, which makes total connection demand depend on cluster scheduling.

The budget is computed from the instance, not from what feels comfortable:

```
Σ over services ( maxReplicas × connection_limit )
  + migration_job_reserve
  + operator_reserve
  ≤ 0.8 × max_connections
```

The reserves are not optional. A platform that cannot open a session to run a migration or diagnose an incident while saturated has converted a load problem into an outage.

Every service with a pool gets a row in a connection budget table maintained alongside the declared capacity model. Raising `maxReplicas` requires updating that table in the same change. This is the point: the autoscaler ceiling and the database ceiling are one decision, and today they are made in two files by two people who never meet.

### PgBouncer is an admission requirement, not an optimisation

PgBouncer in transaction mode is required before any service is permitted a `maxReplicas` that would consume more than 70% of `max_connections` under the formula above. Below that threshold, direct connections with an explicit limit are simpler and preferred.

Transaction mode is not transparent, and the constraints are recorded now rather than discovered during an incident:

- Prisma uses prepared statements by default. Either the DSN carries `pgbouncer=true`, which disables the prepared statement cache and costs plan time on every query, or PgBouncer 1.21 or later is deployed with prepared statement support enabled. Choose deliberately and record the choice.
- Session-scoped state is unavailable: `SET`, `LISTEN`/`NOTIFY`, session-level advisory locks, temporary tables and cursors held outside a transaction. ADR-015 already declined session advisory locks, so there is no conflict to resolve — but that ADR's reasoning now has a second, independent justification.
- `FOR UPDATE SKIP LOCKED` in `backend/src/outbox/outbox.service.ts:46-54` is transaction-scoped and remains correct.
- Claim loops must keep transactions short. In transaction mode a long transaction pins a server connection for its full duration, so a slow handler inside a transaction consumes pool capacity that pooling was introduced to conserve.

### Schema changes are expand and contract, applied once

With `maxUnavailable: 0` and `maxSurge: 1`, the previous and next application versions are both live against a single schema during every deploy. Therefore each migration must be compatible with the application version preceding it:

- Expand: add nullable columns, add tables, add indexes concurrently. Deploy code that writes both shapes and reads the new one with a fallback.
- Contract: drop the old column or constraint in a **later** release, once no running version reads it.
- Never rename, never drop, and never add a `NOT NULL` column without a default in the same release as the code that depends on it.

Migrations run as a single Kubernetes job before the rollout, never from application pods at boot. Twenty pods racing to apply the same DDL is a distinct failure from the one this ADR is otherwise about, and it is worth not inventing.

At the time of this decision, the flat-SQL layout was left in place. Converting existing migrations to Prisma's timestamped directory format remains a separate, testable schema-tooling decision; this ADR governs connection and rollout safety rather than choosing the migration authority.

Update 2026-08-02: `backend/prisma/migrations/` now contains timestamped Prisma-style directories alongside the existing flat SQL files. The repository is therefore in a mixed migration-tooling state. This does not retroactively select either style as authoritative; the owner must define the forward strategy and deployment entry point before old files are consolidated.

### Query cost is part of the budget

Connection limits only hold if queries are short. Two known offenders are recorded here so the budget is not immediately invalidated:

- `backend/src/device/device.service.ts:484-506` issues three additional queries per device after `userDevice.findMany`, so a user with N devices costs `1 + 3N` round trips.
- `backend/prisma/migrations/init_timescaledb.sql:38-101` creates `vital_signs_1m`, `_5m` and `_1h` continuous aggregates that no application code queries. `backend/src/sleep/sleep.service.ts` reads raw `vitalSignsData`. The expensive part is built and paid for; the cheap read path is unused.

Neither is fixed by this ADR. Both are recorded because a connection budget derived from current query cost would be sized for avoidable load.

## Consequences

### Easier

- Total connection demand becomes a number that can be checked against the instance before deployment rather than discovered under load.
- HPA ceilings stop being independently settable from database capacity.
- Rolling deploys stop being able to break on schema changes, because compatibility is a stated rule with a review gate.

### Harder

- Explicit `connection_limit` means a replica can exhaust its own pool and queue requests where it previously opened more connections. Latency under burst becomes visible as pool wait time rather than as database contention. This is better, but it is a new signal that needs a dashboard and an alert before it is a diagnosis.
- PgBouncer adds a hop, a process to operate, and a second place where connections can be exhausted. Its own pool sizing becomes a capacity parameter.
- Disabling the prepared statement cache costs planning time on every query, and the size of that cost is workload-dependent and currently unmeasured.
- Expand and contract makes some schema changes take two releases. Small changes get slower in exchange for deploys that do not break.

## Rejected alternatives

- **Lower `maxReplicas` until connections fit.** Reduces the availability ceiling to work around a configuration default, and leaves the same trap for the next person who raises the number.
- **Deploy PgBouncer immediately for all services.** Rejected as premature: at current replica counts, an explicit `connection_limit` alone resolves the exhaustion risk, and PgBouncer's session-mode restrictions are a real constraint on future design. Introduce it against a measured threshold, not pre-emptively.
- **Use Prisma's `@prisma/adapter-pg` with an application-managed `pg` pool.** Attractive because it makes pooling explicit in code. Rejected for now because the installed adapter is a major version ahead of the client, so adopting it is a Prisma upgrade wearing a different hat. Track the version mismatch as its own cleanup.
- **Session-mode PgBouncer to preserve full PostgreSQL semantics.** Rejected because it holds one server connection per client connection, which does not reduce the count and therefore does not address the problem.
- **Adopt read replicas now.** Rejected: it adds connections rather than bounding them, and the declared capacity model already states that sharding and similar measures wait for measured saturation. The same discipline applies here.

## Verification status

Not verified. Configuration files, `package.json`, migration layout and query sites were read at revision of 2026-07-31. The 33-connections-per-replica figure is derived from Prisma's documented default formula against a 16-core node, not measured. Acceptance requires an observed connection count at the target replica count against a known `max_connections`, and a rolling-deploy test across a schema change with both versions live. Neither exists.
