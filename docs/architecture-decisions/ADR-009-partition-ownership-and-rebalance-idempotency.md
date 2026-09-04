# ADR-009: Kafka Partition Ownership and Rebalance Idempotency

Status: Accepted and locally fault-tested

Date: 2026-07-30

## Context

The telemetry Worker is an at-least-once Kafka consumer. A process can be terminated after ClickHouse accepts a batch but before Kafka receives the next offset, so the replacement owner must safely replay that batch. The original design combined a per-process TTL cache with a ClickHouse event-ID lookup, but it assumed every producer used `deviceId` as the Kafka key and had not been tested across a real two-member rebalance.

The first multi-replica experiment also found a silent client/database compatibility defect. With `@clickhouse/client` 1.23.1 and ClickHouse 24.8, an `Array(UUID)` query parameter returned no rows for an existing UUID without raising an error. After one Worker was killed, the surviving Worker's cache recognized the 49 replayed events from its original partitions, but persistent lookup missed 51 events from the killed Worker's six partitions. ClickHouse therefore contained 6,291 physical rows for 6,240 unique IDs.

## Decision

- Require every telemetry Kafka key to equal the validated payload `deviceId` byte-for-byte. A missing or different key is a deterministic `partition_key` governance violation and must enter DLQ before the source offset is committed.
- Preserve one partition owner per device. The query-before-insert check is safe only because equal device keys always map to the same partition and Kafka assigns a partition to one group member at a time.
- Use the bounded in-process event-ID cache for hot duplicates and a ClickHouse lookup for restart/rebalance duplicates.
- Pass event IDs as `Array(String)`, convert them to UUID inside a scalar subquery, and compare against the UUID column. Do not use the silently incorrect `Array(UUID)` parameter form in this tested client/server combination.
- Add a Bloom data-skipping index on `event_id` so persistent replay checks do not require a full raw-table scan as data grows.
- Expose assigned-partition count, group lifecycle counters, and group-join duration per Worker. Readiness still requires group membership and an unblocked processing loop.
- Make Kafka session and heartbeat intervals configurable. Production defaults remain 30 seconds and 3 seconds; the local fault experiment explicitly used 10 seconds and 2 seconds to keep a repeatable validation cycle.
- Scale Worker replicas only up to useful partition parallelism. With 12 partitions, more than 12 active consumers cannot increase this topic's throughput.

## Evidence

The optimized Worker image `sha256:7596bc1a55ef5143ce5b53459dcd0807d6c3c3b58390368e8e29ae04a528e6e6` was tested three times with two replicas, 12 partitions, 240 warm-up events, 6,000 load events, 100 explicit replays, and one invalid partition-key event. One Worker was killed abruptly after 1,000 load events had been published.

| Run | Peak observed lag | Rebalance recovery | Final lag | Rows / unique IDs | Explicit replays suppressed |
| --- | ---: | ---: | ---: | ---: | ---: |
| `rebalance-20260730-04` | 3,999 | 13.056 s | 0 | 6,240 / 6,240 | 100 |
| `rebalance-20260730-05` | 4,066 | 11.712 s | 0 | 6,240 / 6,240 | 100 |
| `rebalance-20260730-06` | 4,234 | 12.605 s | 0 | 6,240 / 6,240 | 100 |

Recovery median was 12.605 seconds with an 11.712-13.056 second range. In every run, the group changed from two members with six partitions each to one member with all 12 partitions. Every partition finished at log end, no unique event was lost, no duplicate row remained, and the invalid key produced exactly one DLQ record and no warehouse row.

## Consequences

The Worker now has an executable, evidence-backed idempotency boundary for process failure and consumer rebalance. Key enforcement converts an undocumented assumption into a trust-boundary rule. Persistent lookup adds ClickHouse read load, while the Bloom index adds storage and insert overhead; both costs must be measured at the 5,000 message/s cloud target.

This is not end-to-end exactly-once processing. The local test used one Kafka broker and one ClickHouse node, so it does not prove broker replication, ClickHouse replica consistency, multi-AZ recovery, or durability during storage failure. Production DWD models must still deduplicate by `eventId`, and the cloud experiment must repeat this fault while Kafka and ClickHouse use their production HA topology.

## Rejected alternatives

- Trust producer keying without consumer verification: rejected because an incorrect key breaks the single-owner invariant.
- Use Redis `SETNX` as the unique source of truth: rejected because a crash between reservation and ClickHouse insertion can lose an event, and Redis is not authoritative storage.
- Rely only on an in-memory cache: rejected because rebalances and restarts move partitions to a process without that cache.
- Claim Kafka exactly-once for an external ClickHouse side effect: rejected because Kafka transactions cannot atomically commit an independent ClickHouse insert.
- Hide duplicates with a reporting query only: rejected because the experiment demonstrated a correctable ingestion defect, not an acceptable reporting artifact.

