# ADR-010: Flink event time, governed late data, and transactional Kafka output

Status: Accepted and locally correctness-tested

Date: 2026-07-30

## Context

The original realtime Worker validates canonical telemetry and writes raw ClickHouse rows, but it does not provide stateful event-time windows, watermark-driven late classification, or a governed separation between duplicate, invalid, late, and accepted records. Device clocks and intermittent networks guarantee out-of-order and delayed telemetry, so processing-time aggregation would silently move events into the wrong sleep-analysis window.

ClickHouse materialized views are useful for storage-local transformations but cannot own event-time watermarks, bounded keyed state, or checkpoint-coordinated Kafka transactions. The data platform also needs a replayable DWD/DWS boundary that Agent features can consume without scanning raw device records.

## Decision

- Use Apache Flink 1.20.1 for canonical telemetry event-time processing.
- Validate the canonical payload before timestamp assignment. Invalid data enters a dedicated audit Topic with error, byte length, SHA-256, run ID, and rejection time.
- Assign event time from `occurredAt` with five seconds bounded out-of-orderness and ten seconds source idleness.
- Deduplicate by `eventId` in keyed `ValueState` with a one-hour processing-time TTL. Duplicate events enter a dedicated audit Topic.
- Route events at or behind the current watermark to a late-data Topic. Preserve occurred time, received time, watermark, and measured lateness; do not silently add them to the live aggregate.
- Produce accepted DWD records and tenant minute aggregates through five Flink Kafka sinks using `EXACTLY_ONCE` and run-specific transactional ID prefixes.
- Use a configurable checkpoint interval with a ten-second default, one-second lower bound, sixty-second timeout, and retained externalized checkpoints on cancellation.
- Materialize fixed governance Topics into ClickHouse DWD, DWS, late, invalid, and duplicate tables. Every record carries `run_id` and `tenant_id` where the source identity is valid.
- Keep the original immutable/raw path for replay and reconciliation. Late corrections are handled by a reviewed backfill path; they do not mutate the live window invisibly.
- Expose Flink JobManager and TaskManager metrics through Prometheus. Production alerting must include checkpoint failure, checkpoint age, restart count, watermark lag, Kafka lag, and ClickHouse consumer errors.

## Evidence

Formal runs `20260730-flink-event-time-01` through `03` used one image:

`sha256:c49645fda7549515fb56cf33aedbd532473a8ad464b1b496f71fd5f3faf74b65`

Each run sent eight records in a controlled order: four accepted first-window inputs including one duplicate and one in-bound out-of-order event, one event advancing the watermark, one deliberately late event, one invalid measurement, and one second-window-closing event.

| Result across three runs | Value |
| --- | ---: |
| Input records | 24 |
| Unique DWD records | 15 |
| Late records | 3 |
| Invalid records | 3 |
| Duplicate audit records | 3 |
| Materialized aggregate windows | 6 |
| Completed / failed checkpoints | 19 / 0 |
| Latest checkpoint duration, median | 20 ms |
| Latest checkpoint state size | 14,535 bytes |

The first window contained exactly three events with average heart rate 70; the second contained one event with average 90. The in-bound out-of-order event was present in DWD. The late and invalid IDs were absent from DWD and present in their governance streams. Kafka evidence was read with `isolation.level=read_committed`, and ClickHouse counts matched the committed Kafka outputs in every run.

## Consequences

Event-time behavior is explicit, testable, and replayable. The separation of live, late, duplicate, and invalid streams supports independent retention, alerting, and backfill policy. Exactly-once Kafka output adds transaction-coordinator load and couples output visibility to checkpoint completion; a ten-second interval is a deliberate latency/overhead trade-off rather than an arbitrary default.

The one-hour deduplication TTL is not a permanent global uniqueness guarantee. Longer replay horizons must be deduplicated in immutable lake/DWD reconciliation. ClickHouse Kafka Engine materialization is outside the Flink transaction, so production tables require idempotent keys or replacing semantics plus reconciliation before claiming end-to-end exactly once.

The local experiment used one Kafka broker, one TaskManager with parallelism one, local checkpoint storage, and one ClickHouse node. It does not prove Flink HA, distributed checkpoint durability, broker failover, multi-AZ recovery, or the 5,000 messages/second target.

## Rejected alternatives

- Processing-time windows: rejected because network delay changes business-window assignment.
- Drop late records: rejected because it destroys evidence and prevents controlled correction.
- Write every side output directly to ClickHouse from Flink: rejected because independent external writes cannot share the Kafka checkpoint transaction and complicate replay.
- Use only ClickHouse materialized views: rejected because storage views do not provide watermark/state/checkpoint semantics.
- Infinite event-ID state: rejected because state growth would be unbounded; immutable storage reconciliation owns long-horizon uniqueness.
