# 有状态组件灾难恢复演练

## 概述

本文档定义有状态组件（数据库、消息队列、缓存等）的灾难恢复演练流程，确保这些关键组件在故障时能够快速恢复。

## 演练范围

| 组件 | 类型 | 高可用模式 | RTO | RPO |
|------|------|-----------|-----|-----|
| PostgreSQL | 关系型数据库 | 主从复制 + Patroni | 5分钟 | 0（同步复制） |
| Redis | 缓存 | 主从 + Sentinel | 2分钟 | 5分钟 |
| Kafka | 消息队列 | KRaft 集群 | 5分钟 | 5分钟 |
| ClickHouse | 分析数据库 | 副本 + 分片 | 15分钟 | 15分钟 |
| EMQX | MQTT Broker | 集群 | 2分钟 | 0 |
| Vault | 密钥管理 | Raft HA | 15分钟 | 0 |

## 演练计划

### 演练 1: PostgreSQL 主库故障切换

**目标**: 验证 PostgreSQL 主库故障时，从库能自动提升为主库，应用能自动重连。

**演练步骤**:

1. **准备阶段**（10分钟）
   - 确认主从复制状态正常
   ```bash
   kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT * FROM pg_stat_replication;"
   ```
   - 记录当前主库和从库
   - 创建测试表并插入测试数据
   ```bash
   kubectl exec -n database postgres-0 -- psql -U postgres -d sleep_platform -c "
     CREATE TABLE IF NOT EXISTS dr_test (id SERIAL PRIMARY KEY, data TEXT, created_at TIMESTAMP DEFAULT NOW());
     INSERT INTO dr_test (data) VALUES ('before-failover-' || NOW());
   "
   ```

2. **故障注入**（1分钟）
   - 删除主库 Pod，模拟主库崩溃
   ```bash
   kubectl delete pod -n database postgres-0
   ```

3. **观察自动切换**（5分钟）
   - 观察 Patroni 是否自动提升从库为主库
   ```bash
   kubectl get pods -n database -w
   kubectl exec -n database postgres-1 -- psql -U postgres -c "SELECT pg_is_in_recovery();"
   ```
   - 记录切换时间（RTO）
   - 验证应用是否自动重连（观察后端日志）

4. **数据验证**（5分钟）
   - 验证测试数据是否完整
   ```bash
   kubectl exec -n database postgres-1 -- psql -U postgres -d sleep_platform -c "SELECT * FROM dr_test ORDER BY id DESC LIMIT 5;"
   ```
   - 插入新数据，验证新主库可写
   ```bash
   kubectl exec -n database postgres-1 -- psql -U postgres -d sleep_platform -c "INSERT INTO dr_test (data) VALUES ('after-failover-' || NOW());"
   ```

5. **恢复阶段**（10分钟）
   - 等待原主库恢复后，转为从库
   - 验证主从复制恢复正常
   - 清理测试数据

**验收标准**:
- RTO < 5分钟
- RPO = 0（无数据丢失）
- 应用自动重连，无需人工干预
- 数据完整性验证通过

### 演练 2: Redis 主节点故障

**目标**: 验证 Redis 主节点故障时，Sentinel 能自动进行故障转移。

**演练步骤**:

1. **准备阶段**（5分钟）
   - 确认 Redis 主从和 Sentinel 状态
   ```bash
   kubectl exec -n cache redis-0 -- redis-cli -a $REDIS_PASSWORD info replication
   kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel masters
   ```
   - 写入测试数据
   ```bash
   kubectl exec -n cache redis-0 -- redis-cli -a $REDIS_PASSWORD SET dr_test "before-failover"
   ```

2. **故障注入**（1分钟）
   - 删除 Redis 主节点 Pod
   ```bash
   kubectl delete pod -n cache redis-0
   ```

3. **观察故障转移**（3分钟）
   - 观察 Sentinel 是否自动提升从节点为主节点
   ```bash
   kubectl get pods -n cache -w
   kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel masters
   ```
   - 记录切换时间（RTO）

4. **数据验证**（2分钟）
   - 验证测试数据是否存在
   ```bash
   kubectl exec -n cache redis-1 -- redis-cli -a $REDIS_PASSWORD GET dr_test
   ```
   - 写入新数据，验证新主节点可写

5. **恢复阶段**（5分钟）
   - 等待原主节点恢复后，转为从节点
   - 清理测试数据

**验收标准**:
- RTO < 2分钟
- 数据不丢失（Redis 持久化开启时）
- 应用自动重连

### 演练 3: Kafka Broker 故障

**目标**: 验证 Kafka 单个 Broker 故障时，集群能继续正常工作，消费者能自动重连。

**演练步骤**:

1. **准备阶段**（5分钟）
   - 确认 Kafka 集群状态
   ```bash
   kubectl exec -n messaging kafka-0 -- kafka-topics.sh --bootstrap-server localhost:9092 --list
   kubectl exec -n messaging kafka-0 -- kafka-broker-api-versions.sh --bootstrap-server localhost:9092 | head -5
   ```
   - 创建测试 Topic（3 分区，3 副本）
   - 生产测试消息

2. **故障注入**（1分钟）
   - 删除一个 Kafka Broker Pod
   ```bash
   kubectl delete pod -n messaging kafka-0
   ```

3. **观察集群恢复**（5分钟）
   - 观察 Broker 是否自动恢复
   ```bash
   kubectl get pods -n messaging -w
   ```
   - 验证其他 Broker 继续服务
   - 验证消费者能继续消费消息

4. **数据验证**（5分钟）
   - 验证消息不丢失（至少一次语义）
   - 生产新消息，验证集群可写
   - 检查消费者延迟是否恢复正常

5. **恢复阶段**（5分钟）
   - 等待故障 Broker 恢复
   - 验证集群状态恢复正常

**验收标准**:
- RTO < 5分钟
- 消息不丢失（幂等消费者）
- 消费者延迟在 10 分钟内恢复正常

### 演练 4: EMQX 节点故障

**目标**: 验证 EMQX 集群单个节点故障时，设备能自动重连到其他节点。

**演练步骤**:

1. **准备阶段**（5分钟）
   - 确认 EMQX 集群状态
   ```bash
   kubectl exec -n iot emqx-0 -- emqx_ctl cluster status
   kubectl exec -n iot emqx-0 -- emqx_ctl stats | grep connections
   ```
   - 记录当前连接数

2. **故障注入**（1分钟）
   - 删除一个 EMQX 节点 Pod
   ```bash
   kubectl delete pod -n iot emqx-0
   ```

3. **观察设备重连**（5分钟）
   - 观察设备是否自动重连到其他节点
   ```bash
   kubectl exec -n iot emqx-1 -- emqx_ctl stats | grep connections
   ```
   - 记录连接数恢复时间
   - 验证设备数据上报正常

4. **恢复阶段**（5分钟）
   - 等待故障节点恢复
   - 验证集群状态恢复正常
   - 验证连接数均衡分布

**验收标准**:
- RTO < 2分钟
- 设备自动重连，无需人工干预
- 数据上报不中断（设备本地缓存 + 补传）

## 演练频率

| 组件 | 演练频率 | 负责人 |
|------|---------|--------|
| PostgreSQL | 每季度 | DBA |
| Redis | 每季度 | 运维 |
| Kafka | 每半年 | 运维 |
| ClickHouse | 每半年 | 运维 |
| EMQX | 每季度 | IoT 团队 |
| Vault | 每半年 | 安全团队 |

## 演练报告模板

每次演练后，填写以下报告：

```markdown
# 有状态组件灾难恢复演练报告

## 基本信息
- 演练日期:
- 演练组件:
- 参与人员:
- 演练类型: 计划内 / 计划外

## 演练过程
- 故障注入时间:
- 服务恢复时间:
- RTO (实际):
- RPO (实际):
- 遇到的问题:
- 解决方法:

## 验收结果
- [ ] RTO 达标
- [ ] RPO 达标
- [ ] 数据完整性验证通过
- [ ] 应用自动恢复
- [ ] 无人工干预（或记录人工干预步骤）

## 改进措施
1.
2.
3.

## 附件
- 演练日志
- 监控截图
- 相关指标数据
```

## 相关文档

- [灾难恢复演练计划](./ha-drill-plan.md)
- [灾难恢复 Playbook](./playbook.md)
- [RPO/RTO 定义](./rpo-rto-definition.md)
- [PostgreSQL 主库宕机 Runbook](../operations/runbooks/postgres-master-down.md)
- [Redis 故障转移失败 Runbook](../operations/runbooks/redis-failover-fail.md)
- [Vault 灾难恢复 Playbook](./vault-dr-playbook.md)
