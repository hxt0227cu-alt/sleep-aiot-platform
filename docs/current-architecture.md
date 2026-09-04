# 当前架构（Current Architecture）

> 本文件是**当前真实架构**的权威概览，随代码演进维护。早期的产品规划与设计推演保留在
> [`docs/architecture.md`](architecture.md)（已标注为历史规划文档，不代表当前实现）。
> 全部架构决策记录见 [`docs/architecture-decisions/`](architecture-decisions/)。

## 1. 系统总览

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

## 2. 分层说明

### 2.1 设备边缘层（`firmware/`）

- ESP32-S3 + ESP-IDF（FreeRTOS），C/C++ 源码，仅作源码级交付。
- 能力：毫米波雷达（心率/呼吸/体动）、I2S 音频（功放 MAX98357A + 麦克风 ICS-43434）、
  PWM 双色温 LED、触摸、白噪音、GSM 报警（SIM800C）、OTA、安全启动与 flash 加密。
- 与云端通过 MQTT（EMQX）双向通信；设备身份与证书由控制面 PKI 体系签发。
- **诚实边界**：当前无硬件在环证据，固件通过仿真/编译验证；见
  [ADR-005](architecture-decisions/ADR-005-no-hardware-validation.md)。

### 2.2 控制面（`backend/`）

- NestJS + Express + Prisma + TypeScript，无状态、可横向扩展（
  [ADR-012](architecture-decisions/ADR-012-stateless-control-plane.md)）。
- 核心模块：认证与多租户、设备生命周期、告警、算法提案（审批/金丝雀/提升/回滚）、
  统一审计、设备 PKI 与 CRL、安全指令护栏（device-control-guard）、
  LLM 输入安全（input-security）、Vault 密钥访问审计。
- 存储：TimescaleDB（PostgreSQL 扩展，关系 + 时序）、Redis 7（会话/热点/推送）。
- 多租户隔离在 ORM 层强制（[ADR-017](architecture-decisions/ADR-017-multitenant-enforcement.md)）。

### 2.3 流式数据面（`services/`）

| 服务 | 职责 | 技术栈 |
| --- | --- | --- |
| `telemetry-ingest` | MQTT → Kafka 接入：Schema 校验、设备认证、幂等 | TypeScript / Node |
| `realtime-worker` | Kafka → ClickHouse 消费者：去重、DLQ、实时扇出 | TypeScript / Node |
| `flink-telemetry-job` | 事件时间窗口聚合、迟到数据治理 | Java / Flink |
| `feature-service` | 面向租户的特征查询 | Python / FastAPI（dbt 数仓之上） |
| `dbt`（`platform/data/`） | 数仓分层与指标定义 | dbt |

可靠性设计：事件契约（schema-registry）、DLQ 与毒事件处理
（[ADR-007](architecture-decisions/ADR-007-poison-event-dlq-and-readiness.md)）、
分区归属与重平衡幂等（[ADR-009](architecture-decisions/ADR-009-partition-ownership-and-rebalance-idempotency.md)）、
Flink 事件时间与受管迟到数据（[ADR-010](architecture-decisions/ADR-010-flink-event-time-and-governed-late-data.md)）。

### 2.4 AI 面（`services/agent-service/` + `platform/model-gateway/`）

- `agent-service`：LLM 助手运行时，RAG over 睡眠知识库、工具调用、Temporal 工作流、
  Workspace/记忆（[ADR-003](architecture-decisions/ADR-003-agent-runtime.md)）。
- `platform/model-gateway/litellm-config.yaml`：统一模型网关（vLLM / 外部大模型）。
- 输入侧安全：提示词注入与内容安全检测（backend `input-security`）。

### 2.5 客户端

- `miniprogram/`：Taro + React 微信小程序（睡眠曲线、设备控制、白噪音、用户中心）。
- `src/`：Vite + React Web 管理控制台（Capacitor 可打包移动端）。
- `components/`：跨端共享组件。

### 2.6 平台与可观测性（`platform/`）

- `k8s/`：清单基线与 overlay（`base/` + `validation/` + `alicloud-validation/`），
  含状态型 workload 加固（只读根文件系统、非 root、emptyDir、NetworkPolicy）。
- `observability/`：Prometheus 指标、Grafana 告警规则、Loki 日志、Jaeger 链路。
- `data/`：ClickHouse Schema、dbt 数仓、数据契约（`data-contracts/`）。
- `disaster-recovery/`：容灾与备份恢复 runbook。
- `load-tests/`：k6 压测（[ADR-004](architecture-decisions/ADR-004-synthetic-load-evidence.md)）。
- `operations/`、`security/`、`ci-cd/`、`local/`：运维、安全测试、CI/CD 与本地工具。

## 3. 数据流

1. **遥测上行**：设备（MQTT QoS 1）→ `telemetry-ingest`（校验/幂等）→ Kafka →
   `realtime-worker`（实时 → ClickHouse + Redis 实时态）→ `flink-telemetry-job`
   （窗口聚合）→ ClickHouse 物化/聚合表 → dbt 数仓 → `feature-service` 查询。
2. **控制下行**：客户端 → 控制面（鉴权/护栏/审计）→ MQTT 指令下发 → 设备执行。
3. **AI 对话**：客户端 → `agent-service`（检索 + 工具调用）→ `model-gateway` → 模型 →
   睡眠解释与建议返回；全程输入侧安全检测与审计。

## 4. 部署形态

- **Kubernetes（生产形态）**：`platform/k8s/` base + overlay 渲染部署，
  加固与不可变镜像由 CI 强制校验。
- **本地开发**：`docker-compose.yml`（TimescaleDB/Redis/EMQX 等基础设施）+
  `docker-compose.lite.yml`（单容器轻量选项）。

## 5. 验证与 CI

三套 GitHub Actions 工作流（push / PR 触发）：

| 工作流 | 覆盖 |
| --- | --- |
| `backend-ci.yml` | 后端 type-check、单测、构建、镜像签名；平台清单 kustomize 渲染、不可变镜像标签、promtool 告警规则 |
| `enterprise-platform-ci.yml` | 数据面与 AI 面回归、schema 契约、deployment-contracts、安全硬闸（Trivy 漏洞/密钥/misconfig 白名单）、K8s 运行时冒烟（workflow_dispatch） |
| `miniprogram-ci.yml` | 小程序 lint、type-check、单测、构建、可审预览 |

安全硬闸：依赖漏洞（HIGH/CRITICAL 阻断）、密钥泄露阻断、
K8s misconfig（仅放行 4 个 by-design 白名单，防回归）——详见
[`security.md`](security.md)。

## 6. 已知边界与诚实声明

- 固件为源码级交付，无硬件在环证据（[ADR-005](architecture-decisions/ADR-005-no-hardware-validation.md)）。
- 真实集群冒烟套件已就绪（`platform/k8s/scripts/smoke/`）但尚未在真实集群执行，
  需 `KUBE_CONFIG` 与 `workflow_dispatch` 触发——见 [`k8s-runtime-smoke.md`](k8s-runtime-smoke.md)。
- 性能容量模型为内部工作记录，公开仓库不包含原始性能证据。
