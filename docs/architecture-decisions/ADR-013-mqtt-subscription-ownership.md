# ADR-013: MQTT Topic Ownership and Shared Subscriptions

Status: Proposed

Date: 2026-07-31

Governed by ADR-012. Depends on ADR-014 for replica fan-out. Extends ADR-006.

## Context

At the 2026-07-31 decision snapshot, two independent consumers subscribed to the same device uplink topics with different semantics. The implementation has since moved partially; see “Verification status” for the current static inspection.

`services/telemetry-ingest/src/index.ts` subscribes through the telemetry-ingest shared group:

```
$share/telemetry-ingest/device/+/telemetry
```

At that snapshot, `MqttService` subscribed to the backend wildcard set without a shared group and included `device/+/telemetry`; `VoiceQueryMqttService` added `device/+/voice/query` from a separate module.

Three distinct defects follow.

**Cross-service duplication.** Every `device/+/telemetry` message is consumed twice: once by `telemetry-ingest`, which validates it and produces to Kafka, and once by `backend`, which writes it to PostgreSQL. Two storage paths diverge with no reconciliation, and the event contract in `platform/data-contracts/` governs only one of them.

**Intra-service duplication.** Without a shared-subscription group, MQTT delivers each message to every subscribed client. At `replicas: 3` the backend handler runs three times per message. `backend/src/mqtt/device-message-handler.service.ts` has no idempotency key, so this is three inserts, not one insert and two no-ops.

**Self-echo on downlink topics.** At that snapshot, `DeviceService` published commands to `device/{deviceId}/command` and `CloudMessagePublisherService` published OTA commands to `device/{deviceId}/ota/command`, while the backend wildcard set also subscribed to those downlink families. This was pure waste and a loop hazard if a handler published in response.

The client identity still compounds it: `MqttService` uses `clientId: nestjs-backend-${Date.now()}` with `clean: true`, so replicas are unidentifiable in broker telemetry and every restart appears as a new client.

## Decision

### Topic ownership is explicit and single-owner

Each uplink topic has exactly one consuming service. Ownership is recorded here and mirrored into `docs/current-architecture.md`.

| Topic | Direction | Owner | Backend action |
| --- | --- | --- | --- |
| `device/+/telemetry` | uplink | `telemetry-ingest` | unsubscribe |
| `device/+/status` | uplink | `backend` | `$share/sleep-backend/` |
| `device/+/alarm` | uplink | `backend` | `$share/sleep-backend/` |
| `device/+/log` | uplink | `backend` | `$share/sleep-backend/` |
| `device/+/command/response` | uplink | `backend` | `$share/sleep-backend/` |
| `device/+/ota/progress` | uplink | `backend` | `$share/sleep-backend/` |
| `device/+/voice/query` | uplink | `backend` | open item: not yet in central registry |
| `sleep/+/data` | uplink | undecided | freeze, see below |
| `sleep/+/state` | uplink | undecided | freeze, see below |
| `sleep/+/report` | uplink | undecided | freeze, see below |
| `device/+/command` | downlink | `backend` publishes | unsubscribe |
| `device/+/ota/command` | downlink | `backend` publishes | unsubscribe |
| `device/+/config` | downlink | `backend` publishes | no subscription |
| `device/+/notification` | downlink | `backend` publishes | no subscription |
| `device/+/voice/response` | downlink | `backend` publishes | no subscription |

The `sleep/+/*` family is frozen rather than migrated: no new producers, no new handlers, and a follow-up task to determine whether it overlaps `device/+/telemetry` or carries a distinct grain. Deciding its ownership without knowing whether firmware still publishes to it would be guessing, and this repository has no device to ask.

### Target subscription rules

- All centrally registered backend subscriptions use the single group `$share/sleep-backend/`, so one message reaches exactly one replica within that group.
- All subscriptions are registered through `MqttService`. Modules must not open their own subscriptions; `voice-query-mqtt.service.ts` moves to the central registry.
- A topic the service publishes to must not also be subscribed to unless a documented reason exists in this table.
- `clientId` derives from the pod identity (`HOSTNAME` under Kubernetes) with a random suffix only as a local-development fallback. `clean: true` is retained per ADR-006.

### Shared subscription changes ordering, so state updates must be order-independent

Under `$share`, two consecutive messages for the same device may land on different replicas, and no replica sees a device's full history. Any handler that currently performs read-modify-write against per-device state is incorrect after this change.

Handlers therefore write device-derived state as last-write-wins keyed on a monotonic source timestamp, discarding messages older than the stored value. Handlers that cannot be expressed this way must move to the data plane, where `deviceId` partitioning in ADR-006 already provides per-device ordering. Ordering is bought with partitioning, not with subscriptions.

### Downlink commands accept a caller-supplied idempotency key

`DeviceService` in `backend/src/device/device.service.ts` generates `cmd_${Date.now()}_${randomBytes(4)}` server-side, so a client retry after a timeout produces a second distinct command and the device executes twice. The command API accepts an optional caller-supplied idempotency key; when present it becomes the `commandId`, and the existing unique constraint on `DeviceCommandRecord.commandId` turns a retry into a lookup of the original command's state. When absent, current behaviour is preserved and the response is marked non-idempotent.

## Consequences

### Easier

- Telemetry has one owner, one contract and one storage path. `platform/data-contracts/` becomes authoritative instead of describing one of two pipelines.
- Backend message-handling cost stops scaling with replica count. Handler throughput becomes a real capacity number.
- Broker dashboards can attribute load to a named replica.
- Client retries stop creating duplicate device actions.

### Harder

- Removing the backend telemetry path removes whatever reads depend on the PostgreSQL copy. Every consumer of that table must be identified and repointed at the ClickHouse or DWD path before the subscription is dropped, or this becomes a silent data outage. This is the single highest-risk step in the plan and requires its own migration record.
- Shared subscriptions make no replica able to observe global message flow, so any debugging or metric that relied on one process seeing everything must move to aggregated metrics.
- Last-write-wins discards concurrent updates by design. Where a device legitimately emits two state changes within clock resolution, one is lost. The source timestamp must come from the device or the broker, never from `Date.now()` on the consumer.
- EMQX shared-subscription behaviour under replica churn is not identical across brokers. The production reference targets ApsaraMQ; the local stack runs EMQX. Any rebalance evidence gathered locally is protocol evidence, not managed-service evidence.

## Rejected alternatives

- **Keep both consumers and deduplicate downstream.** Rejected because it pays twice for ingestion and then pays a third time to reconcile, while leaving two schemas that can drift.
- **Give backend its own shared group on `device/+/telemetry` and keep the PostgreSQL write.** Rejected because it fixes replica duplication but preserves two owners for one event, which is the more expensive defect.
- **Route all uplink traffic through `telemetry-ingest` and have it call backend.** Rejected for now: it makes the ingest path a dependency of control-plane availability and inverts the plane separation in ADR-002. Worth revisiting only if the topic table grows past what one broker group can cleanly express.
- **Per-topic shared groups (`$share/backend-status/`, `$share/backend-alarm/`).** Rejected as premature. It buys independent scaling per topic that no measurement currently justifies, at the cost of more broker objects to operate. Revisit when one topic's handler is measurably the bottleneck.

## Verification status

Implementation and local protocol evidence verified 2026-08-04:

- Backend owns only the central shared subscriptions; downlink command topics are no longer consumed by backend.
- Client identity derives from pod/host identity, and the real EMQX two-client shared-subscription test passed.

Managed MQTT rebalance behavior and production broker configuration remain unverified.
