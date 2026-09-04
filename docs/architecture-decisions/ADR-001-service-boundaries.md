# ADR-001: Keep the business backend modular and extract scale-specific services

Status: Accepted

## Context

The existing NestJS backend owns tightly related authentication, device, sleep, alarm, OTA, MQTT, WebSocket, and AI modules. Splitting every module would add network failure modes and deployment overhead before a measured scaling need exists.

## Decision

Keep business domains in a modular monolith. Extract Agent runtime, telemetry ingestion, real-time workers, model serving, data jobs, and device simulation because they use different runtimes, scale signals, or failure boundaries.

## Consequences

- Business transactions remain straightforward.
- Telemetry and GPU saturation cannot starve authentication or device commands.
- Independent services require versioned contracts, tracing, deployment, and ownership.
- Further extraction requires measured contention or a clear ownership boundary.

