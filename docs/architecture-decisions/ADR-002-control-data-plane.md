# ADR-002: Isolate control and data planes

Status: Accepted

## Context

High-frequency telemetry is bursty and eventually consistent. Authentication, tenant membership, approvals, alarms, and device commands require reserved capacity and stronger consistency.

## Decision

Run control and data workloads in separate deployments, queues/topics, connection pools, and Kubernetes resource budgets. Kafka-compatible buffering absorbs telemetry bursts. Control-plane writes remain in PostgreSQL and publish domain events through a transactional outbox.

## Consequences

- Telemetry spikes do not consume all control-plane workers.
- Data becomes replayable and consumers become independently scalable.
- Consumers must be idempotent and support DLQ/replay.
- End-to-end freshness becomes an explicit SLI.

