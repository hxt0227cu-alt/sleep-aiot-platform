# Sleep AIoT Platform（睡眠智能监测平台）

一套**端到端的智能睡眠监测灯**参考实现：ESP32‑S3 边缘设备（毫米波雷达、音频、灯光、闹钟）通过 MQTT 接入多租户云平台，云平台由 NestJS 控制面、Kafka/Flink/ClickHouse 流式数据面、基于 RAG 的睡眠助手，以及微信小程序 / Web 客户端构成。

> 本仓库定位为**参考级 / 作品集级实现**。它展示了如何用生产导向的工程实践（事件契约、幂等、多租户隔离、安全护栏、可观测性、IaC 与 CI）构建完整的 IoT 健康产品，而不是一次性原型。硬件证据不在仓库内：固件仅提供源码，通过编译/模拟验证（见 [ADR-005](docs/architecture-decisions/ADR-005-no-hardware-validation.md)）。

---

## 架构

```text
┌─────────────────────────────  设备边缘  ─────────────────────────────┐
│  ESP32-S3（firmware/）                                                │
│  毫米波雷达 · 音频 · LED · 触摸 · 白噪音 · OTA · 安全启动              │
└────────────────────────────────────┬─────────────────────────────────┘
                                     │ MQTT（EMQX）
                                     ▼
┌─────────────────────────────  云平台  ───────────────────────────────┐
│  控制面                            流式数据面                         │
│  ┌────────────────────────┐        ┌──────────────────────────────┐  │
│  │ NestJS 后端（backend/）  │ ───►  │ telemetry-ingest ─► Kafka ─►  │  │
│  │ TimescaleDB · Redis · EMQX│      │ realtime-worker ─► ClickHouse │  │
│  │ 多租户 · 审计 · 幂等 · 安全│      │ Flink 作业 · dbt · feature-svc │  │
│  └────────────┬───────────┘        └──────────────────────────────┘  │
│               │                                                     │
│  AI 平面：agent-service ─► model-gateway ─► vLLM / 外部大模型          │
│  睡眠知识库 RAG · 工具调用 · 睡眠解释                                   │
│                                                                      │
│  客户端：微信小程序（miniprogram/）· Web（src/）· Capacitor             │
└──────────────────────────────────────────────────────────────────────┘
```

### 关键设计决策

- **控制面 / 数据面分离**（[ADR-002](docs/architecture-decisions/ADR-002-control-data-plane.md)）——无状态控制面可横向扩展，流式数据面由独立服务负责。
- **可靠遥测接入**（[ADR-006](docs/architecture-decisions/ADR-006-reliable-telemetry-ingestion.md)）——Schema 校验、设备载荷幂等、DLQ 与毒事件处理。
- **多租户隔离**（[ADR-017](docs/architecture-decisions/ADR-017-multitenant-enforcement.md)）——平台表在 ORM 层强制，健康模型携带 `tenant_id`，上下文不明时 fail-closed。
- **提示词注入与内容安全**（[input-security](backend/src/input-security/)）——对助手 LLM 输入做规则 + 关键词 + 多轮检测。
- **安全指令护栏**（[device-control-guard](backend/src/device-control-guard/)）——指令白名单、风险分级二次确认、频控、全量审计。
- **设备身份与 PKI**（[pki-cert](backend/src/pki-cert/)）——设备身份、证书签发、CRL、硬件密钥存储。

全部架构决策记录见 [`docs/architecture-decisions/`](docs/architecture-decisions/)。

---

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| [`backend/`](backend/) | NestJS 控制面 API（认证、租户、设备、告警、算法提案、审计、PKI、安全护栏） |
| [`services/telemetry-ingest/`](services/telemetry-ingest/) | MQTT → Kafka 接入（Schema 校验、设备认证） |
| [`services/realtime-worker/`](services/realtime-worker/) | Kafka → ClickHouse 消费者（去重、DLQ、实时扇出） |
| [`services/flink-telemetry-job/`](services/flink-telemetry-job/) | Flink 作业（事件时间、迟到数据、窗口聚合） |
| [`services/feature-service/`](services/feature-service/) | 面向租户的特征查询 |
| [`services/agent-service/`](services/agent-service/) | LLM 助手运行时（RAG、工具调用、Temporal 工作流、Workspace/Memory） |
| [`firmware/`](firmware/) | ESP32-S3 固件（雷达、音频、MQTT、OTA、安全启动）——仅源码 |
| [`miniprogram/`](miniprogram/) | 微信小程序客户端 |
| [`src/`](src/) | React（Vite）Web 客户端 |
| [`platform/`](platform/) | IaC 与数据平台：k8s 清单、dbt 数仓、ClickHouse Schema、压测、可观测性、容灾 |
| [`security/`](security/) `compliance/` `production/` | 安全测试工具、合规标准、生产设备密钥工具 |
| [`docs/`](docs/) | 产品与技术文档、ADR |

---

## 本地快速开始（控制面）

依赖：Node.js ≥ 20、pnpm ≥ 9、Docker。

```bash
# 1. 启动基础设施（TimescaleDB、Redis、EMQX）
docker compose up -d

# 2. 配置后端
cp backend/.env.example backend/.env
#    编辑 backend/.env 中的本地值（JWT 密钥等）

# 3. 安装并启动 API
cd backend
pnpm install
pnpm exec prisma generate
pnpm exec prisma db push
pnpm run start:dev
```

API 启动后位于 `http://localhost:3000`，健康检查为 `/api/health`。

轻量单容器方案见 `docker-compose.lite.yml`。

### 验证

```bash
cd backend
pnpm run type-check   # TypeScript，零错误
pnpm run test         # Jest 单元测试
pnpm run build        # nest build
```

### 小程序

```bash
cd miniprogram
pnpm install
pnpm run dev:weapp    # 在微信开发者工具中打开
```

### 固件

固件目标为 **ESP32-S3**（Espressif IDF 5.x），仅源码，使用标准 ESP-IDF 工具链构建：

```bash
cd firmware
idf.py set-target esp32s3
idf.py build
```

---

## CI/CD

包含 GitHub Actions 工作流：

- `backend-ci.yml` —— 后端类型检查、单元测试、构建、镜像签名（cosign）、平台清单校验（kustomize + promtool）。
- `miniprogram-ci.yml` —— 小程序 lint / 类型检查 / 测试 / 构建。
- `enterprise-platform-ci.yml` —— 数据平台与 Agent 回归检查。

## 现状与已知限制

- **CI 已验证**：后端类型检查（0 错误）、180+ Jest 测试、构建通过。
- **尚未生产级验证**：真实硬件（固件仅源码，无板级证据）、托管 MQTT 重平衡、真实 staging 上的备份/PITR 演练、端到端设备认证。相关事项记录在各 ADR 中。

## 文档

- [架构总览](docs/architecture.md)
- [产品需求文档](docs/product-requirements.md)
- [API 设计](backend/docs/API_Design.md) · [数据库设计](backend/docs/Database_Design.md) · [MQTT 协议](backend/docs/MQTT_Protocol.md)
- [硬件：雷达协议](docs/hardware/r60abd1-protocol.md) · [GSM](docs/hardware/sim800c-gsm.md) · [音频](docs/hardware/max98357-audio.md) · [麦克风](docs/hardware/ics-43434-microphone.md)
- [睡眠领域知识](docs/sleep-domain/sleep-tech-basis.md)
- [部署](docs/deployment.md) · [开发指南](docs/development.md)
- [用户手册](docs/user-manual.md)

## 开源协议

[MIT](LICENSE) © 2026 sleep-aiot-platform contributors。
