# ADR-012: Stateless Control Plane Contract

Status: Proposed

Date: 2026-07-31

Supersedes nothing. Governs ADR-013, ADR-014, ADR-015 and ADR-016.

## Context

At the 2026-07-31 decision snapshot, the deployment topology already asserted that `backend` was horizontally scalable: `backend-deployment.yaml` declared three replicas, `backend-autoscaling.yaml` allowed three to twenty replicas, and `backend-pdb.yaml` required at least two available replicas. The declared capacity model targets 99.95% core API availability, which is not reachable on a single replica.

At that snapshot, the running code did not satisfy that assertion. Relevant implementation sites were:

- `WebSocketGateway` in `backend/src/websocket/websocket.gateway.ts` owns local socket maps; ADR-014 governs cross-replica fan-out.
- `DeviceStatusService` in `backend/src/device/device-status.service.ts` maintains `deviceStatusCache` and an offline sweep.
- `DeviceStatusSyncService` in `backend/src/mqtt/device-status-sync.service.ts` runs another status-check interval.
- `CloudMessagePublisherService` in `backend/src/mqtt/cloud-message-publisher.service.ts` owns an in-process `messageQueue`.
- `MqttService` in `backend/src/mqtt/mqtt.service.ts` owns the central subscription registry. Its current implementation status is tracked by ADR-013 rather than by these historical line numbers.

The consequence was not "reduced throughput under scale-out". It was inverted scaling: adding a replica multiplied duplicate database writes, added a second conflicting device-liveness authority, and increased the probability that a realtime event was delivered by a replica that did not hold the target socket. The validation overlay therefore pinned `replicas: 1` in `platform/k8s/overlays/validation/replicas-patch.yaml`. Later implementation status must be read from the governed ADRs and change records, not inferred from this context snapshot.

This ADR exists because the individual fixes in ADR-013 through ADR-016 are symptoms of one missing rule: nobody wrote down what a replica is allowed to remember.

## Decision

A control-plane replica is a fungible, disposable unit. Any state whose loss, duplication or divergence changes externally observable behaviour must live outside the process.

### Prohibited in-process state

1. **Connection registries used as a routing target.** A replica may hold the sockets it terminates. It may not assume it holds all sockets for a subject. Addressed by ADR-014.
2. **Authoritative entity state derived across requests.** Device liveness, command state and quota counters are authority, not cache. Two replicas must never be able to disagree.
3. **Non-durable work queues.** Anything accepted from a caller and acknowledged before it is durably recorded.
4. **Cluster-singleton timer work.** Any `setInterval` whose body has side effects that must happen once per cluster per tick. Addressed by ADR-015.
5. **Unbounded caches keyed by tenant, user or device.** These make memory a function of business growth, so the pod's memory limit becomes an undeclared capacity ceiling. `deviceStatusCache` at the 10,000-device target is the current example.

### Permitted in-process state

- Request-scoped values.
- Bounded, TTL-governed read caches where the value is re-derivable and staleness is explicitly tolerated by the consumer.
- Idempotency caches owned by the single consumer of a partition, as already permitted for the data plane by ADR-006.
- Socket handles for connections this replica terminates.
- Configuration and compiled artefacts loaded at boot.

The distinction that matters is not "memory versus Redis". It is whether correctness depends on a second replica seeing the same value. A WebSocket handle may live in process memory; the belief that it is the only handle may not.

### Admission checks

Every change touching `backend/src` that introduces module-level mutable state, a timer, or a subscription must answer three questions in its pull request. A "no" answer requires a linked ADR or an explicit exemption in the change record.

1. If two replicas execute this concurrently, does any side effect happen twice?
2. If this replica receives `SIGTERM` mid-operation, what is lost, and who observes the loss?
3. Does correctness depend on a client reconnecting to the same replica?

### Scope boundary

This contract governs `backend/` only. `services/telemetry-ingest/` and `services/realtime-worker/` already satisfy it through shared subscriptions and Kafka consumer groups, and their existing patterns — `OutboxService.claimBatch()` in `backend/src/integration/outbox.service.ts`, the optimistic claim in `backend/src/assistant/scheduled-device-action-executor.service.ts`, and the DLQ and deduplication modules under `services/realtime-worker/src/` — are the reference implementations to copy rather than reinvent.

## Consequences

### Easier

- The declared HPA range becomes meaningful. Scale-out increases capacity instead of amplifying faults.
- The `maxUnavailable: 0` rolling strategy stops silently dropping realtime events during deploys.
- `replicas: 1` in the validation overlay becomes a cost decision rather than a correctness crutch, so validation results start predicting production behaviour.
- New code has a checkable rule instead of relying on a reviewer noticing a `Map`.

### Harder

- Every realtime delivery gains a Redis hop. This adds latency to a path currently measured in microseconds and must be budgeted against the "first progress event below 1 second" objective in the capacity model.
- Redis becomes a control-plane availability dependency. Under the 99.95% objective, a single-node Redis is now a correlated failure. Redis HA, its own SLO and a defined degraded mode are prerequisites, not follow-ups.
- Local development requires Redis. `platform/local/` must start it by default or the developer experience regresses.
- Externalising `deviceStatusCache` converts a memory read into a network read on a path that runs per device per check interval. ADR-015 must bound that cost or the fix trades a correctness bug for a load problem.

### Neutral but explicit

This contract does not make `backend` a microservice fleet and does not authorise extracting modules. The modular monolith decision in ADR-001 and the declared enterprise architecture stands. Statelessness is a property of the process, not an argument for splitting it.

## Rejected alternatives

- **Sticky sessions at the load balancer.** Would let the WebSocket maps keep working. Rejected because it fixes one of five symptoms, makes scale-in and rolling deploys lossy by construction, and moves a correctness invariant into load-balancer configuration where no test can observe it.
- **Pin `backend` to a single replica and scale vertically.** Rejected because it makes `minAvailable: 2` unsatisfiable, removes zone redundancy that `backend-deployment.yaml:27-33` already configures, and forfeits the availability objective.
- **Whole-process leader election.** Rejected because it idles `N-1` replicas for API traffic that is already safe to parallelise, and converts every leader failure into a service-wide event.
- **Declare the problem theoretical because no production traffic exists.** Rejected under the repository evidence policy: the manifests already claim the property, so either the claim or the code must change. Leaving both in place is the one option that is definitely wrong.

## Verification status

Implementation verified locally on 2026-08-04: two backend-like realtime instances shared Redis fan-out successfully, and the related MQTT/Redis protocol tests passed. Managed-broker rebalance, Redis disruption reconciliation, and real staging remain unverified.
