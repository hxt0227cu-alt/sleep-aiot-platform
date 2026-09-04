# ADR-019: 可观测性 —— 指标采集接线与可执行告警

## Status
Accepted

## Context

生产就绪度评估（`05`）把可观测性列为「有骨架、无证据」：仓库里已有 `MetricsService`（prom-client Registry）与 `/api/metrics` 端点，`RequestMetricsInterceptor` 也确实挂在全局。但**没有任何东西证明这些指标会被采集到、更没有任何告警会因为它们而触发**。

排查后发现三处真实缺陷，任何一处都会让"有指标"变成"永远沉默"：

1. **Prometheus 抓不到。** `platform/k8s/base/network-policy.yaml` 是 default-deny，ingress 只放行了同命名空间与 ingress-nginx。`monitoring` 命名空间的 Prometheus 抓 3000 端口会被**静默丢弃**——表现为 target 永远 down，而应用侧没有任何报错。而且集群里根本没有 `ServiceMonitor`，连抓取意图都不存在。

2. **5xx 被记成 200。** `RequestMetricsInterceptor` 在 rxjs 的 `finalize` 里读 `response.statusCode`。异常路径下，`finalize` 早于 Nest 的异常过滤器写状态码执行，于是所有 5xx 都被记成 200。基于错误率的告警**永远不会触发**——这是最危险的一类缺陷：指标存在、数值稳定、且始终错误。

3. **扇出失败会打挂进程（P0）。** `WebSocketService` 有 10 处 `this.fanout.publishToX(...)` 既不 `await` 也不 `catch`。`RealtimeFanoutService.publish` 直接把 broker 的 rejection 外抛，Redis 一抖动就变成 unhandled rejection——Node 15+ 默认因此终止进程，三个副本会同时 crash-loop。一次"尽力而为的推送"故障被放大成全站不可用。

同时，ADR-012/014/015 引入的横向扩展设施（WS 连接预算、跨副本扇出、领导者锁）此前**完全没有指标**。这些恰恰是最容易静默失效的部分：锁一直抢不到，定时任务整体停摆，日志里不会有任何一行错误。

## Decision

### 1. 拉取式状态量，而非推送式（避免领域模块反向依赖监控）

`observability/scale-out-metrics.ts` 用 prom-client 的 `collect` 回调，在 `/metrics` 被抓取的**那一刻**去问 MqttService / WebSocketService 当前状态：

- `sleep_ws_connections{kind}`、`sleep_ws_connection_budget`、`sleep_ws_connection_budget_ratio`、`sleep_mqtt_connected`

方向是 observability → 领域服务，领域服务对监控**零感知**，既有单测一行不用改。每个 `collect` 回调各自用 guard 包裹：单个数据源抛错不能拖垮整个 `/metrics` 端点（否则一个次要指标的 bug 会让所有指标一起消失）。

`registerScaleOutGauges` 与 `resolveWsConnectionBudget` 拆成纯函数，可脱离 Nest 单测；非法预算值回落到默认 5000 而不是产生 `NaN` 比率。

### 2. 计数器走依赖倒置端口（基础设施不依赖监控实现）

扇出与抢锁是**行为事件**，拉不到，必须推。为了不让 `redis` 模块 import `observability`，在 `redis/contracts.ts` 定义 `InfraMetricsSink` 接口 + `INFRA_METRICS_SINK` 令牌，由 observability 模块提供 `PrometheusInfraMetricsSink` 适配器。注入是 `@Optional()`——既有单测里不给 sink 也能跑。

契约要求所有方法**不得抛异常**，适配器内部逐个 try/catch 包裹：指标记录失败绝不能影响业务路径。

- `sleep_fanout_published_total{kind}` / `sleep_fanout_publish_failures_total{kind}` / `sleep_fanout_received_total{kind}`
- `sleep_leader_lock_runs_total{lock_key,outcome}`，outcome ∈ acquired / skipped / failed

关于 `skipped` 的语义：N-1 个副本每轮都会 skip，这是**正常态**，不能拿它告警。真正的故障信号是"持续有尝试但长期没有 acquired"，对应 `BackendApiLeaderLockStarved`。

### 3. 修复三处真实缺陷

- **NetworkPolicy**：ingress 增加 `namespaceSelector: kubernetes.io/metadata.name: monitoring` 对 3000 端口放行。
- **拦截器时序**：改为监听 `response.once('finish')` / `once('close')`，用幂等的 `record` 函数，确保读到的是最终状态码。这个 bug 是被本轮新写的端到端测试（`metrics-endpoint.spec.ts` 打 `/probe/boom`）抓出来的，不是靠肉眼 review。
- **扇出韧性**：`publish` 统一改为吞异常 + 计数 + 记日志，不再外抛。取舍写在代码注释里：本服务投放语义本就是 at-most-once，丢一条消息在契约之内，崩掉进程不在。调用方因此无法感知单次发布失败——当前没有任何调用方需要感知；若将来出现"必须送达"的场景，应该上持久化 outbox，而不是让 Pub/Sub 抛错。

### 4. 让告警规则本身成为被验证的产物

`platform/k8s/base/backend-prometheusrule.yaml` 定义 4 组告警：scrape / slo / dependencies / data-protection。其中 `BackendApiMetricsAbsent`（`absent(up{...})`）专门覆盖"连 target 都没被创建"这种最隐蔽的失效。

关键点：**PromQL 写错不会有任何运行时报错，只会永远不触发**。所以 CI 新增 `platform-manifests` job：kustomize 渲染 → 拒绝 `:latest` 标签 → 断言 NetworkPolicy 仍放行 monitoring 命名空间（本轮修复的回归保护）→ `promtool check rules` 校验规则语法。

### 5. 明确 deferred：分布式链路追踪

OpenTelemetry 追踪本轮**不做**。理由：metrics 能回答"是否出问题、影响多大"，这是当前最缺的；tracing 回答"问题在哪一跳"，价值在服务拆分后才充分体现，而当前是模块化单体。提前引入 OTel SDK 会带来采样策略、Collector 部署、存储成本三块新负担，收益却有限。

### 6. `/api/metrics` 的鉴权取舍

端点当前不鉴权。指标里不含个人健康数据，只有计数与状态量；NetworkPolicy 已把访问面收敛到 monitoring 命名空间。加 bearer token 会让 ServiceMonitor 配置复杂化，收益不成比例。**前提是 NetworkPolicy 生效**——这也是为什么 CI 里专门加了一条断言防止它被改回去。

## Consequences

- **变容易**：横向扩展设施的失效变得可见（此前完全沉默）；告警规则语法错误在 CI 就被拦住；`/metrics` 的抓取链路有端到端测试证明。
- **变困难 / 付出的代价**：
  - 指标基数需要盯着。`sleep_leader_lock_runs_total{lock_key}` 的 lock_key 目前是有限枚举；若将来出现动态 key（比如按 deviceId 抢锁），基数会爆炸，必须在那时改成聚合标签。
  - 告警阈值（错误率 5%、P95 1s、连接预算 80%/95%）是**基于假设的初值**，没有生产流量佐证。必须在有真实流量后按实际分布回调，否则要么天天狼来了，要么形同虚设。
  - `PostgresBackupJobFailed/Stale` 依赖 kube-state-metrics。若集群没装，这三条规则不会报错，只会永远不触发——已在规则文件里注明。
  - 扇出发布失败对调用方不可见，只能靠指标发现。这是刻意的取舍，不是疏漏。
- **仍未覆盖**：分布式追踪、日志聚合（结构化日志→Loki/ELK）、Grafana dashboard as code。这三项没有做，也没有假装做了。

## 后续项

- 有真实流量后校准全部告警阈值，并给 SLO 告警补 burn-rate（多窗口多燃烧率）而非单一阈值。
- Grafana dashboard 纳入 kustomize，与告警规则同源管理。
- Phase 2 评估 OpenTelemetry：先做 trace context 透传（W3C traceparent），再决定是否接 Collector。
- 结构化日志 + 日志/指标/追踪三者用同一组 label 关联。
