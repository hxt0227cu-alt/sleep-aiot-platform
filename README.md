# Sleep AIoT Platform

An end-to-end **smart sleep monitoring lamp** reference implementation: an ESP32‑S3 edge device (mmWave radar, audio, lighting, alarm) connected over MQTT to a multi‑tenant cloud platform that combines a NestJS control plane, a Kafka/Flink/ClickHouse streaming data plane, a RAG‑backed sleep assistant, and a WeChat mini‑program / web client.

> This repository is a **reference / portfolio-grade implementation**. It demonstrates how a complete IoT health product can be built with production-oriented engineering practices — event contracts, idempotency, multi-tenant isolation, security guardrails, observability, IaC and CI — rather than a throwaway prototype. Hardware evidence is not included: the device firmware is source-only and validated by simulation/compile (see [ADR-005](docs/architecture-decisions/ADR-005-no-hardware-validation.md)).

---

## Architecture

```text
┌─────────────────────────────   Device edge  ─────────────────────────────┐
│  ESP32-S3  (firmware/)                                                   │
│  mmWave radar · audio · LED · touch · white noise · OTA · secure boot    │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ MQTT (EMQX)
                                     ▼
┌─────────────────────────────  Cloud platform  ───────────────────────────┐
│  Control plane                        Streaming data plane               │
│  ┌────────────────────────┐           ┌──────────────────────────────┐   │
│  │ NestJS backend (backend/)│   ───►  │ telemetry-ingest ─► Kafka ─►  │   │
│  │ TimescaleDB · Redis · EMQX│          │ realtime-worker ─► ClickHouse │   │
│  │ multi-tenant · audit ·    │          │ Flink job · dbt · feature-svc │   │
│  │ idempotency · security    │          └──────────────────────────────┘   │
│  └────────────┬───────────┘                                              │
│               │                                                          │
│  AI plane:  agent-service ─► model-gateway ─► vLLM / external LLM        │
│  RAG over sleep-knowledge base · tool calling · sleep explanations       │
│                                                                          │
│  Clients: WeChat mini-program (miniprogram/) · Web (src/) · Capacitor    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key design decisions

- **Control / data plane separation** ([ADR-002](docs/architecture-decisions/ADR-002-control-data-plane.md)) — the stateless control plane can scale horizontally while the streaming data plane is owned by independent services.
- **Reliable ingestion** ([ADR-006](docs/architecture-decisions/ADR-006-reliable-telemetry-ingestion.md)) — schema validation, idempotent device payloads, DLQ and poison-event handling.
- **Multi-tenant isolation** ([ADR-017](docs/architecture-decisions/ADR-017-multitenant-enforcement.md)) — platform tables enforced at the ORM layer, health models carry `tenant_id`, fail-closed on ambiguous context.
- **Prompt-injection & content safety** ([input-security](backend/src/input-security/)) — rule + keyword + multi-turn detection for the assistant's LLM inputs.
- **Security guardrails** ([device-control-guard](backend/src/device-control-guard/)) — command whitelisting, risk-level confirmation, rate limits, full audit trail.
- **Provisioning & PKI** ([pki-cert](backend/src/pki-cert/)) — device identity, certificate signing, CRL, hardware key storage.

A full list of architecture decision records lives in [`docs/architecture-decisions/`](docs/architecture-decisions/).

---

## Repository layout

| Path | What it is |
| --- | --- |
| [`backend/`](backend/) | NestJS control-plane API (auth, tenants, devices, alarms, algorithm proposals, audit, PKI, security guardrails) |
| [`services/telemetry-ingest/`](services/telemetry-ingest/) | MQTT → Kafka ingestion (schema validation, device auth) |
| [`services/realtime-worker/`](services/realtime-worker/) | Kafka → ClickHouse consumer (dedup, DLQ, realtime fan-out) |
| [`services/flink-telemetry-job/`](services/flink-telemetry-job/) | Flink job (event time, late data, windowed aggregation) |
| [`services/feature-service/`](services/feature-service/) | Tenant-scoped feature queries over the warehouse |
| [`services/agent-service/`](services/agent-service/) | LLM assistant runtime (RAG, tool calling, Temporal workflows, workspace/memory) |
| [`firmware/`](firmware/) | ESP32-S3 firmware (radar, audio, MQTT, OTA, secure boot) — source only |
| [`miniprogram/`](miniprogram/) | WeChat mini-program client |
| [`src/`](src/) | React (Vite) web client |
| [`platform/`](platform/) | IaC & data platform: k8s manifests, dbt warehouse, ClickHouse schema, load tests, observability, disaster recovery |
| [`security/`](security/) `compliance/` `production/` | Security test tooling, compliance standards, production device-key tooling |
| [`docs/`](docs/) | Product & technical documentation, ADRs |

---

## Quickstart (local, control plane)

Requirements: Node.js ≥ 20, pnpm ≥ 9, Docker.

```bash
# 1. Start the infrastructure (TimescaleDB, Redis, EMQX)
docker compose up -d

# 2. Configure the backend
cp backend/.env.example backend/.env
#    edit backend/.env with local values (JWT secrets, etc.)

# 3. Install and start the API
cd backend
pnpm install
pnpm exec prisma generate
pnpm exec prisma db push
pnpm run start:dev
```

The API is then reachable at `http://localhost:3000` with health at `/api/health`.

A lighter single-container option is available via `docker-compose.lite.yml`.

### Verification

```bash
cd backend
pnpm run type-check   # TypeScript, zero errors
pnpm run test         # Jest unit tests
pnpm run build        # nest build
```

### Mini-program

```bash
cd miniprogram
pnpm install
pnpm run dev:weapp    # open in WeChat DevTools
```

### Firmware

The firmware targets the **ESP32-S3** (Espressif IDF 5.x). It is source-only; build with the standard ESP-IDF toolchain:

```bash
cd firmware
idf.py set-target esp32s3
idf.py build
```

---

## CI/CD

GitHub Actions workflows are included:

- `backend-ci.yml` — backend type-check, unit tests, build, image sign (cosign), platform manifest validation (kustomize + promtool).
- `miniprogram-ci.yml` — mini-program lint / type-check / test / build.
- `enterprise-platform-ci.yml` — data-platform & agent regression checks.

## Status & known limits

- **Verified in CI**: backend type-check (0 errors), 180+ Jest tests, builds.
- **Not yet production-proven**: real hardware (firmware is source-only, no board-level evidence), managed MQTT rebalancing, backup/PITR drills on real staging, end-to-end device certification. These are tracked in the ADRs.

## Documentation

- [Architecture overview](docs/architecture.md) (Chinese)
- [Product requirements](docs/product-requirements.md) (Chinese)
- [API & database design](backend/docs/API_Design.md), [database design](backend/docs/Database_Design.md), [MQTT protocol](backend/docs/MQTT_Protocol.md)
- [Hardware: radar protocol](docs/hardware/r60abd1-protocol.md) · [GSM](docs/hardware/sim800c-gsm.md) · [audio](docs/hardware/max98357-audio.md) · [microphone](docs/hardware/ics-43434-microphone.md)
- [Sleep domain notes](docs/sleep-domain/sleep-tech-basis.md)
- [Deployment](docs/deployment.md) · [Development guide](docs/development.md)
- [User manual](docs/user-manual.md)

## License

[MIT](LICENSE) © 2026 sleep-aiot-platform contributors.
