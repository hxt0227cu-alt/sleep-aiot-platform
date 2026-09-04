# ADR-007: Poison Event DLQ and Processing-Aware Readiness

Status: Accepted and locally fault-tested

Date: 2026-07-24

## Context

A Kafka record can bypass MQTT validation through replay, migration, operator injection, or a producer defect. Skipping an invalid record loses forensic evidence. Committing it before durable dead-letter publication also makes recovery impossible. Conversely, treating transient ClickHouse or Kafka failures as poison would hide infrastructure incidents and silently divert valid data.

The first missing-DLQ fault experiment also showed that KafkaJS automatically rejoins the consumer group after an `eachBatch` crash. A readiness check based only on group membership returned healthy while the same uncommitted poison record was still failing.

## Decision

- Validate the internal `device-telemetry-received.v1` contract again at the Worker boundary.
- Classify only null values, invalid JSON, and deterministic schema violations as poison events.
- Write valid rows to ClickHouse, then publish poison records to `telemetry.device.v1.dlq`, then resolve and explicitly commit the source batch offset.
- Do not resolve or commit the source offset when either ClickHouse or DLQ publication fails.
- Give every DLQ record a deterministic SHA-256 ID derived from source topic, partition, and offset.
- Preserve tenant, trace, source coordinates, headers, payload hash, byte length, error class, and validation details.
- Retain at most 256 KiB of payload in Kafka DLQ while hashing the full payload; larger forensic payload storage will move to restricted OSS in production.
- Declare readiness only when the consumer has joined its group and no batch failure remains unresolved. A successful complete batch clears the processing block; a group rejoin alone does not.
- Stop accepting readiness before graceful shutdown, stop the consumer, then disconnect Kafka, close ClickHouse, and close HTTP within the container termination grace period.

## Evidence

Three repeated local integration runs each inserted one valid row, dead-lettered three poison records, produced zero DLQ publication failures, and passed all ten assertions.

In the missing-DLQ experiment, the source group stayed uninitialized with log end offset 1 and readiness returned 503. After creating the DLQ topic without restarting the Worker, exactly one DLQ record was published, the source group advanced to offset 1 with lag 0, and readiness recovered to 200.

During SIGTERM testing, readiness was 200 before termination, shutdown completed in approximately 5.6 seconds, both lifecycle log markers were emitted, and the container exited with code 0. After restart, the source group retained lag 0 and no event counters increased, showing no replay.

## Consequences

Poison data is auditable and replayable, and a missing DLQ fails closed instead of losing the source record. A persistent poison record intentionally blocks its partition until the DLQ recovers; alerts and a runbook are therefore required. Stable IDs allow downstream deduplication if a process dies after DLQ acknowledgement but before source offset commit.

The local single-broker experiment does not prove multi-broker durability, cross-AZ behavior, or ACL correctness. Production DLQ access must be restricted, payload retention must follow data classification policy, and Kafka/Schema Registry compatibility enforcement remains pending.

## Rejected alternatives

- Skip and commit invalid events: rejected because it destroys evidence.
- Commit before DLQ publication: rejected because a DLQ outage would permanently lose the record.
- Send all processing failures to DLQ: rejected because transient infrastructure failures are not data defects.
- Use random DLQ IDs: rejected because crash-window duplicates could not be deterministically reconciled.
- Readiness based only on group join: rejected by the missing-DLQ fault experiment.
