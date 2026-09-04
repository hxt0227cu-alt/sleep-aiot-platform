# ADR-011: dbt warehouse layering and duplicate ownership

- Status: Accepted for local validation
- Date: 2026-07-30

## Context

Raw telemetry is at-least-once and therefore may contain repeated event IDs. A first dbt build applied a uniqueness test to the ODS projection and failed with 65 duplicate groups at that point in time. Treating this as an ingestion defect would erase the distinction between immutable evidence and governed business detail.

## Decision

- ODS remains a duplicate-preserving view over validated raw telemetry.
- DWD owns event-ID deduplication and measurement normalization. The earliest `received_at` record wins deterministically.
- DWS uses tenant and event-time hour as its compound grain and incrementally recomputes the recent two-hour window.
- ADS exposes only bounded, aggregated Agent features; Agents do not scan raw telemetry.
- Quality tests enforce DWD uniqueness and ODS-unique-to-DWD row reconciliation rather than ODS uniqueness.
- Full refresh and incremental execution are separate release gates.

## Consequences

The raw layer remains auditable and replayable, while downstream consumers receive stable grains. Duplicate-rate monitoring stays possible. Incremental DWD currently uses a maximum `received_at` watermark, so production backfill must be a partition-aware workflow rather than relying on ordinary incremental execution.

## Alternatives rejected

- Deduplicate before ODS: hides transport/replay behavior and weakens reconciliation.
- Keep duplicates through DWD: pushes inconsistent grains into every downstream metric and Agent feature.
- Scan raw data directly from Agent tools: violates the metric-service boundary and creates unpredictable cost and latency.

## Evidence

One full refresh and three incremental runs passed 4 models and 17 tests each. The formal local source had 56,289 rows and 56,218 unique events; DWD contained exactly 56,218 rows and IDs. See `../data-platform/DBT_WAREHOUSE_VALIDATION.md`.
