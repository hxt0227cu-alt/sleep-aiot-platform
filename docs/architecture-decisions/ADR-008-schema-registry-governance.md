# ADR-008: Schema Registry Governance and Runtime Resolution

Status: Accepted and locally fault-tested

Date: 2026-07-24

## Context

Git-tracked JSON Schema files alone cannot prevent an incompatible producer from publishing or prove which contract validated a Kafka record. Calling Schema Registry for every message would add latency and make Registry availability part of the hot path. Trusting only a global schema ID would allow a valid ID from another subject to cross a service boundary.

The first integrated startup also exposed a race: the Worker queried the subject before ingest registered it, exited on 404, and succeeded only after Docker restarted it. Event contract provisioning must therefore be an explicit deployment phase rather than an ordering accident between application replicas.

## Decision

- Run Confluent-compatible Schema Registry backed by Kafka's compacted `_schemas` topic. Production uses multiple stateless Registry replicas and replicated Kafka storage.
- Keep `device-telemetry-received.v1.schema.json` as the reviewed Git source, but make Registry the runtime identity authority.
- Use a `schema-contract-init` deployment Job to set `BACKWARD` compatibility and idempotently register the contract before producers and consumers start.
- Let ingest repeat the exact registration during startup as an ownership/identity check, then attach `schemaSubject`, Registry `schemaVersion`, `schemaId`, and payload `contractVersion` headers without calling Registry in the message hot path.
- Require the Worker to bind all three Registry coordinates to its configured subject. It fetches subject/version, verifies the returned global ID and `schemaType=JSON`, compiles AJV, and stores validators in a bounded LRU cache.
- Preload latest at Worker startup. Cached versions continue during a Registry outage; a new uncached version fails closed and keeps the source offset uncommitted.
- Treat missing/malformed headers, cross-subject coordinates, 404, and ID/version mismatch as deterministic governance violations eligible for DLQ. Treat timeout, connection failure, HTTP 408/429, 5xx, malformed Registry response, and uncompileable Registry state as infrastructure failures that must retry from Kafka.
- Enforce compatibility in CI with the same Compose Registry topology and an executable experiment, not only static JSON parsing.

## Evidence

Three compatibility runs each passed 7/7 assertions. Adding an optional field was compatible and registered as v2; adding a required field returned `is_compatible=false`, the real registration returned HTTP 409, and no v3 was created.

Three end-to-end Registry pipeline runs each passed 14/14 assertions. Every run recorded subject `telemetry.device.v1-value`, ID 1, version 1; all four Kafka records hit the preloaded validator cache with zero cache miss, header rejection, identity rejection, or Registry failure.

Three identity-enforcement runs each passed 11/11 assertions. Valid JSON with missing headers, a mismatched ID, or a forbidden subject never reached ClickHouse and was dead-lettered with the original source coordinates.

In the isolated outage experiment, cached v1 processed while Registry was stopped and advanced the group to offset 1. An uncached v2 then held the group at current offset 1/log end 2 with readiness 503. Restoring Registry without restarting the Worker produced one cache miss, grew the cache from one to two entries, inserted v2, and advanced the group to offset 2 with lag 0. ClickHouse contained two unique test events.

## Consequences

Normal telemetry does not pay a Registry network round trip, while every record remains traceable to an immutable subject version. Registry outages have a bounded blast radius determined by cache contents and new-schema traffic. The deliberate fail-closed behavior can block a device partition, so alerts and a tested Runbook are required.

The local Registry is a single process and `_schemas` has replication factor one. This does not prove production HA, TLS/mTLS, RBAC/ACL, backup, multi-AZ leader recovery, or cross-region restoration. Those remain cloud fault-test requirements.

## Rejected alternatives

- Static files only: rejected because runtime records have no authoritative identity and compatibility cannot be centrally enforced.
- Registry lookup per message: rejected because it adds latency and unnecessarily expands the outage blast radius.
- Global ID without subject/version binding: rejected because IDs are global across unrelated subjects.
- Treat every Registry error as poison: rejected because infrastructure outages would cause irreversible source commits.
- Start applications before provisioning subjects: rejected after the observed first-start 404 race.
