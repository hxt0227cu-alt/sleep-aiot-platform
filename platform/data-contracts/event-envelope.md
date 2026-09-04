# Event envelope

Every internal event carries a globally unique event ID, event type, positive schema version, tenant boundary, aggregate ID, source event time, trusted ingress time, trace ID, and event-specific payload.

Kafka-compatible topics use aggregate/device ID as the partition key. Telemetry consumers enforce that the Kafka key equals payload `deviceId`; a missing or mismatched key is dead-lettered because it would break partition ordering and the single-owner idempotency invariant. Consumers are at-least-once and deduplicate by event ID. Breaking schema changes require a new major version and a dual-read migration window.

`device-telemetry.v1.schema.json` validates the device-originated payload before publication. `device-telemetry-received.v1.schema.json` validates the trusted internal event after ingest adds `eventType`, `receivedAt`, and `traceId`. Consumers validate the internal contract again because Kafka is a trust boundary and can receive replayed, migrated, or administratively injected records.

Deterministically invalid records are published to the versioned topic's DLQ before the source offset is committed. Transient storage or dependency errors are retried from the source topic and are not converted into poison records.

Kafka headers carry `schemaSubject`, Registry `schemaVersion`, global `schemaId`, and payload `contractVersion`. Consumers bind all Registry coordinates to an allowlisted subject. Schema Registry is not called for every event: consumers preload and cache compiled validators, fetching only unseen versions.
