# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-09

Open-source release baseline.

### Added
- Public repository snapshot assembled from the working implementation.
- Multi-tenant control plane: auth, tenants, devices, alarms, algorithm proposal lifecycle (approve / canary / promote / rollback), unified audit, PKI & CRL, vault-backed secret access auditing.
- Streaming data plane: `telemetry-ingest` (MQTT → Kafka), `realtime-worker` (Kafka → ClickHouse), Flink telemetry job, dbt warehouse layers, feature service.
- AI plane: agent service with RAG over the sleep-knowledge base, tool calling, Temporal workflows, model gateway.
- Security guardrails: prompt-injection & content-safety detection, device command whitelisting with confirmation + rate limit + audit.
- Firmware (source): ESP32-S3 radar / audio / MQTT / OTA / secure boot / flash encryption.
- Clients: WeChat mini-program, React (Vite) web client.
- Platform assets: k8s manifests, observability (Prometheus/Grafana rules), load tests (k6), disaster-recovery runbooks, CI workflows.

### Fixed
- Backend type-check: resolved 100+ TypeScript errors across Redis wrappers, unified audit, outbox/saga, PKI/CRL, idempotency, rate limiting and scripts; `tsc --noEmit` now passes with zero errors.
- Backend tests: completed the prompt-injection guard's English-language attack coverage and tightened the risk-threshold logic; the full Jest suite passes (180+ tests).

### Security
- All private deployment context, evidence and credentials are excluded from the public snapshot; only `.env.example` placeholders are shipped.
