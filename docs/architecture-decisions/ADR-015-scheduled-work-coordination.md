# ADR-015: Scheduled Work Coordination

Status: Proposed

Date: 2026-07-31

Governed by ADR-012.

## Context

`backend/src` contains six `setInterval` timers and no `@nestjs/schedule` dependency, no distributed lock, and no leader election. A repository-wide search for `setnx`, `redlock`, `advisory_lock` and `leaderElection` returns nothing.

Three of the six are already replica-safe, by accident or by design:

- `backend/src/websocket/websocket.gateway.ts:256` heartbeats only the sockets this replica terminates. Replica-local by nature.
- `backend/src/assistant/scheduled-device-action-executor.service.ts` claims work with a conditional `updateMany` and skips when `claimResult.count === 0`. Correct optimistic claim.
- `backend/src/integration/agent-dispatcher.service.ts:23` dispatches through the outbox, and `backend/src/outbox/outbox.service.ts:46-54` uses `FOR UPDATE SKIP LOCKED`. Correct pessimistic claim.

Three are not:

- `backend/src/device/device-status.service.ts:42-53` loads every device row into an in-process `deviceStatusCache` at boot, and `:67-82` scans that cache each tick to drive offline transitions. Each replica holds a private copy of global state and reaches its own conclusions from it.
- `backend/src/mqtt/device-status-sync.service.ts:53` runs a second offline-detection loop over its own separate in-memory map.
- `backend/src/mqtt/cloud-message-publisher.service.ts:61-66` polls an in-process `messageQueue` array every 100 ms. Anything queued when the pod is rescheduled is gone, and the caller was already told the message was accepted.

The device-status pair is the more interesting failure. It is not primarily a concurrency defect — it is a modelling defect that concurrency exposed. Device liveness has two owners inside a single service, each with its own state, its own timeout constant and its own tick. At one replica they merely disagree with each other. At three replicas there are six authorities for one fact, and the offline event a user receives depends on which pod happened to notice first.

The `deviceStatusCache` also makes replica memory a function of device count. At the 10,000-device target, against the `1Gi` limit in `platform/k8s/base/backend-deployment.yaml:50-56`, the pod's memory ceiling becomes an undeclared device-count ceiling.

## Decision

### Classify every timer before writing one

**Class A — replica-local.** The body touches only resources this replica owns. No coordination. Requires a comment stating why it is local; the WebSocket heartbeat is the reference.

**Class C — claim-based.** Work items live in a durable store. Every replica polls, each claims a disjoint batch, and unclaimed work is picked up by whoever is available. No leader, no failover gap, and throughput rises with replica count.

**Class B — cluster singleton.** The work genuinely cannot be partitioned and must run once per tick globally. Requires a Redis lease with a fencing token, a lease duration longer than the worst-case body execution, and an explicit statement of what happens during the failover gap.

The selection rule is Class C first, Class A when genuinely local, Class B only with a written argument for why the work cannot be partitioned. Class B is a last resort: it idles `N-1` replicas and converts every lease handover into a period where the work does not run.

No new Class B work is authorised by this ADR. The repository currently needs none.

### Device liveness has one owner, and it is not a cache scan

`device-status.service.ts` and `device-status-sync.service.ts` merge into a single owner. Liveness stops being a scan over in-process state and becomes a Class C sweep over the durable record:

```
select devices where last_seen < now() - timeout and status = 'online'
for each: update ... set status = 'offline' where id = ? and status = 'online'
emit the offline event only when the update affected one row
```

The conditional update is the claim. Whichever replica wins performs exactly one transition and emits exactly one event; the losers observe zero affected rows and do nothing. This is the same pattern already working in `scheduled-device-action-executor.service.ts`, so it introduces no new mechanism into the codebase.

The current-status read path serves from the durable record, with a short bounded TTL cache in front if measurement shows it is needed. Under ADR-013 the incoming `device/+/status` handler updates `last_seen` as last-write-wins on the source timestamp, which is what makes the sweep correct without ordering guarantees.

### Durable queues replace in-process queues

`cloud-message-publisher.service.ts` routes through the existing outbox rather than an array. The table, the claim query and the worker loop already exist in `backend/src/outbox/`. Building a second queueing mechanism when a working one is in the repository would be new surface for no new capability.

Poll cadence uses jittered adaptive backoff: tighten toward the floor while work is found, widen toward the ceiling while idle, with per-replica jitter to prevent twenty replicas from issuing synchronised claim queries. A fixed 100 ms poll multiplied by twenty replicas is 200 claim queries per second against PostgreSQL at zero load, which under the connection budget in ADR-016 is a real cost paid to do nothing.

### Shutdown is part of the contract

On `SIGTERM` a replica stops claiming new work, finishes or explicitly releases what it holds, and only then exits. Work claimed by a pod that vanishes must become reclaimable through a visibility timeout rather than waiting for human intervention. Without this, every rolling deploy strands whatever was in flight — and rolling deploys are routine, not exceptional.

## Consequences

### Easier

- Background throughput scales with replica count instead of being duplicated or lost.
- Device liveness has one authority, so the offline event a user receives is deterministic.
- Replica memory stops tracking device count, removing an undeclared capacity ceiling.
- Accepted messages survive pod rescheduling, so the acknowledgement the caller already receives becomes true.

### Harder

- Claim-based work costs a database round trip per poll per replica. At twenty replicas this is a standing load that did not exist before and must be included in the connection budget in ADR-016.
- Merging the two device-status services is a behavioural merge, not a refactor. They use different timeout constants and different event shapes; consumers of both must be inventoried first, and one of the two behaviours will change.
- Adaptive backoff makes latency variable. Work arriving just after a poll waits up to the current interval, so the ceiling must be chosen against a stated latency objective rather than picked for tidiness.
- Reclaim-after-timeout means a slow worker can have its item taken by a peer. Every claim-based handler must therefore be idempotent, which is a requirement on handler authors that reviewers have to enforce.

## Rejected alternatives

- **A Redis leader lease across all six timers.** The smallest diff and superficially attractive. Rejected because it makes nineteen of twenty replicas idle for background work, adds a failover gap to work that has no reason to stop, and hides the underlying modelling defect — two owners for device liveness would survive, merely serialised.
- **Adopt `@nestjs/schedule` with a lock decorator.** Rejected as insufficient on its own: it tidies declaration but leaves the state itself in process memory, which is the actual defect. It becomes reasonable once state is externalised, and is then a cosmetic choice.
- **PostgreSQL advisory locks for singleton work.** Reasonable and dependency-free. Not selected because Class B work is not currently needed, and choosing a singleton mechanism before having singleton work invites its use.
- **Redis Streams for the publisher queue.** Better throughput than a database-backed outbox. Rejected because the outbox already exists, is already tested, and shares a transaction with the business write — a property Redis Streams would give up. Revisit if outbox claim contention becomes measurable.
- **Leave the timers and pin `replicas: 1`.** Rejected under ADR-012 for the same reasons stated there.

## Verification status

Not verified. Timer inventory, claim patterns and cache behaviour were read at revision of 2026-07-31. Acceptance requires a two-replica test asserting exactly one offline event per device transition, an outbox test asserting no message loss across a pod restart with in-flight work, and a measured claim-query rate at the target replica count. None exist.
