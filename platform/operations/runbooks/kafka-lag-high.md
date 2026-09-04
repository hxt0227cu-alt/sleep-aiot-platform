# Runbook: Kafka 消费者延迟过高

## 概述

**故障类型**: 消息队列故障
**严重级别**: High (P2)
**响应时间**: 15分钟
**解决时间**: 2小时
**负责人**: 数据团队 / 值班人员

## 故障现象

- Kafka 消费者延迟（Lag）持续增长
- 数据处理延迟增加
- 监控告警 `KafkaLagHigh` 触发
- 下游服务数据更新不及时

## 快速诊断步骤

### 1. 确认延迟情况（3分钟）

```bash
# 查看消费者组延迟
kubectl exec -n messaging kafka-0 -- kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group <consumer-group>

# 查看所有消费者组
kubectl exec -n messaging kafka-0 -- kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list

# 查看 Topic 分区情况
kubectl exec -n messaging kafka-0 -- kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic <topic-name>
```

### 2. 检查消费者状态（3分钟）

```bash
# 查看消费者 Pod 状态
kubectl get pods -n backend -l app=<consumer-app> -o wide

# 查看消费者日志
kubectl logs -n backend -l app=<consumer-app> --tail=100

# 查看消费者资源使用
kubectl top pods -n backend -l app=<consumer-app>
```

### 3. 检查 Kafka 集群状态（2分钟）

```bash
# 查看 Kafka Pod 状态
kubectl get pods -n messaging -l app=kafka -o wide

# 查看 Kafka 日志
kubectl logs -n messaging kafka-0 --tail=50

# 查看 Broker 状态
kubectl exec -n messaging kafka-0 -- kafka-broker-api-versions.sh --bootstrap-server localhost:9092 | head -5
```

## 常见原因和解决方案

### 原因 1: 消费者处理能力不足

**症状**: 消费者 CPU 使用率高，处理速度跟不上生产速度

**解决方案**:
```bash
# 1. 扩容消费者实例
kubectl scale deployment <consumer-app> -n backend --replicas=6

# 2. 增加分区数（如果分区数 < 消费者数）
kubectl exec -n messaging kafka-0 -- kafka-topics.sh --bootstrap-server localhost:9092 --alter --topic <topic> --partitions 12

# 3. 优化消费者处理逻辑
# - 批量处理
# - 异步处理
# - 减少外部调用
```

### 原因 2: 消费者卡住/死锁

**症状**: 消费者 Pod 运行中但不消费消息，Lag 持续增长

**解决方案**:
```bash
# 1. 查看消费者线程状态
kubectl exec -n backend <consumer-pod> -- jstack 1 | grep -A5 "BLOCKED"

# 2. 重启消费者
kubectl rollout restart deployment/<consumer-app> -n backend

# 3. 等待恢复
kubectl rollout status deployment/<consumer-app> -n backend
```

### 原因 3: 下游服务慢导致消费者阻塞

**症状**: 消费者等待下游服务响应，处理速度慢

**解决方案**:
```bash
# 1. 检查下游服务响应时间
# 查看 Grafana 面板

# 2. 增加下游服务超时时间
# 修改消费者配置

# 3. 扩容下游服务
kubectl scale deployment <downstream-service> -n <namespace> --replicas=4

# 4. 启用异步处理（如果支持）
kubectl set env deployment/<consumer-app> -n backend ASYNC_PROCESSING=true
```

### 原因 4: Kafka Broker 性能问题

**症状**: 多个消费者组同时延迟高，Broker CPU/磁盘 IO 高

**解决方案**:
```bash
# 1. 查看 Broker 资源
kubectl top pods -n messaging -l app=kafka

# 2. 查看磁盘 IO
kubectl exec -n messaging kafka-0 -- iostat -x 1 5

# 3. 扩容 Kafka 集群
# 增加 Broker 数量或提升配置

# 4. 检查是否有大消息
kubectl exec -n messaging kafka-0 -- kafka-log-dirs.sh --bootstrap-server localhost:9092 --describe | grep -A5 "largest"
```

### 原因 5: 消息量突增

**症状**: 生产速率突然增加，消费者来不及处理

**解决方案**:
```bash
# 1. 确认消息量
kubectl exec -n messaging kafka-0 -- kafka-run-class.sh kafka.tools.GetOffsetShell --broker-list localhost:9092 --topic <topic> --time -1

# 2. 临时扩容消费者
kubectl scale deployment <consumer-app> -n backend --replicas=10

# 3. 检查是否有异常生产者
# 查看生产者日志
```

## 验证恢复

```bash
# 1. 消费者延迟下降
kubectl exec -n messaging kafka-0 -- kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group <consumer-group> | grep -v "^\s*0\s*$"

# 2. 消费者正常消费
kubectl logs -n backend -l app=<consumer-app> --tail=20 | grep -i "consume"

# 3. 下游数据更新及时
# 查看业务指标
```

## 升级条件

- 30分钟内延迟未下降
- 多个消费者组同时延迟高
- Kafka Broker 故障
- 数据丢失风险
- 影响核心业务

## 事后复盘要求

- 延迟持续超过 1 小时：必须复盘
- 数据丢失：必须复盘
- 分析延迟根本原因
- 评估是否需要调整分区数/消费者数

## 相关 Runbook

- [API 5xx 故障](./api-5xx-outage.md)
- [MQTT 设备大规模离线](./mqtt-mass-offline.md)
- [ClickHouse 写入失败](./clickhouse-write-fail.md)
