# ADR-006: Reliable Telemetry Ingestion Boundary

Status: Accepted for local validation; production acknowledgement mechanism pending

Date: 2026-07-24

## Context

Telemetry must be horizontally consumable, partition ordered per device, replayable after Worker failure, and resistant to MQTT duplicates. Local experiments exposed stale persistent sessions, skipped initial Kafka offsets, ClickHouse initialization gaps, and a short deduplication visibility window.

## Decision

- Partition Kafka records by `deviceId` and retain `eventId` as the idempotency key.
- Connect the Kafka producer before the MQTT client subscribes.
- Use clean MQTT sessions for ephemeral local ingest containers. A persistent session is allowed only with stable workload identity.
- Start fresh Kafka consumer groups from earliest and commit offsets only after ClickHouse insertion or confirmed duplicate suppression.
- Gate Worker readiness on ClickHouse schema availability, Kafka group join, and the absence of an unresolved batch-processing failure.
- Suppress replays using ClickHouse event-ID lookup plus a bounded in-memory TTL cache owned by the single consumer of a device partition.
- Preserve invalid MQTT payload counts and schema rejection metrics at the ingestion boundary.

## Consequences

The local stack can demonstrate repeatable duplicate suppression and recovery from pre-existing Kafka backlog. The cache consumes bounded memory and depends on stable record keys; ClickHouse lookup remains the restart fallback.

Clean MQTT sessions do not buffer messages while all ingest replicas are unavailable. Production acknowledgement durability therefore belongs to an EMQX/Kafka integration or a separately validated stable-session topology. Until that mechanism passes broker and network-failure tests, the system cannot claim end-to-end zero loss.

## Rejected alternatives

- Unbounded in-memory event-ID sets: rejected because memory grows with traffic.
- `clean=false` with ephemeral container IDs: rejected because it creates orphan sessions and misroutes shared-subscription traffic.
- Starting a fresh group at latest: rejected because it can skip accepted backlog after first-start failure.
- Treating a process health check as schema readiness: rejected because ClickHouse was healthy while the required table was absent.
