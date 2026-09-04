# Runbook: ClickHouse 写入失败

## 概述

**故障类型**: 数据库故障
**严重级别**: High (P2)
**响应时间**: 15分钟
**解决时间**: 2小时
**负责人**: DBA / 运维人员

## 故障现象

- 数据写入 ClickHouse 失败
- 数据管道报错
- 分析数据延迟
- ClickHouse 服务不可用
- 磁盘空间不足

## 快速诊断步骤

### 1. 确认 ClickHouse 状态（5分钟）

```bash
# 查看 ClickHouse Pod 状态
kubectl get pods -n analytics -o wide

# 查看 ClickHouse 日志
kubectl logs -n analytics clickhouse-0 --tail=100

# 检查 ClickHouse 健康状态
kubectl exec -n analytics clickhouse-0 -- wget -qO- http://localhost:8123/ping

# 检查集群状态
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "SELECT * FROM system.clusters"
```

### 2. 检查资源使用（5分钟）

```bash
# 检查磁盘空间
kubectl exec -n analytics clickhouse-0 -- df -h

# 检查内存使用
kubectl top pods -n analytics

# 检查 CPU 使用
kubectl top nodes

# 检查事件
kubectl get events -n analytics --sort-by=.lastTimestamp | tail -20
```

## 常见原因和解决方案

### 原因 1: 磁盘空间不足

**症状**: 写入失败，日志提示 "Disk full" 或 "No space left on device"

**解决方案**:
```bash
# 1. 确认磁盘空间不足
kubectl exec -n analytics clickhouse-0 -- df -h
# 查看使用率 > 90%

# 2. 清理旧数据
# 查看表大小
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "
  SELECT table, formatReadableSize(sum(bytes)) as size
  FROM system.parts
  WHERE active
  GROUP BY table
  ORDER BY sum(bytes) DESC
"

# 3. 删除过期分区
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "
  ALTER TABLE sleep_analytics.device_telemetry
  DROP PARTITION '202601'
"

# 4. 清理临时文件
kubectl exec -n analytics clickhouse-0 -- rm -rf /var/lib/clickhouse/tmp/*

# 5. 如果空间仍然不足，扩容磁盘
# 编辑 PVC 增加容量
kubectl patch pvc clickhouse-storage-clickhouse-0 -n analytics -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# 6. 等待扩容完成
kubectl get pvc -n analytics -w
```

### 原因 2: 内存不足

**症状**: 写入失败，日志提示 "Memory limit exceeded" 或 OOM

**解决方案**:
```bash
# 1. 确认内存使用
kubectl top pods -n analytics
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "SELECT * FROM system.metrics WHERE metric LIKE '%Memory%'"

# 2. 检查内存限制
kubectl get pod -n analytics clickhouse-0 -o jsonpath='{.spec.containers[0].resources}'

# 3. 临时增加内存限制
kubectl set resources statefulset/clickhouse -n analytics --limits=memory=16Gi --requests=memory=8Gi

# 4. 等待 Pod 重启
kubectl rollout status statefulset/clickhouse -n analytics

# 5. 优化查询内存使用
# 检查运行中的查询
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "SELECT query_id, query, memory_usage FROM system.processes ORDER BY memory_usage DESC LIMIT 10"

# 6. 终止消耗内存过多的查询
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "KILL QUERY WHERE query_id = '<query_id>'"
```

### 原因 3: 副本同步延迟

**症状**: 写入失败，日志提示 "Replica is behind" 或 "Quorum not reached"

**解决方案**:
```bash
# 1. 检查副本状态
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "
  SELECT table, replica_name, is_leader, is_readonly, queue_size, inserts_in_queue
  FROM system.replicas
"

# 2. 检查同步延迟
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "
  SELECT table, max(absolute_delay) as max_delay
  FROM system.replicas
  GROUP BY table
"

# 3. 如果延迟过高，等待同步完成
# 监控 queue_size 下降

# 4. 如果同步卡住，重启副本
kubectl delete pod -n analytics clickhouse-1

# 5. 等待副本恢复
kubectl rollout status statefulset/clickhouse -n analytics

# 6. 临时降低写入一致性要求
# 修改应用配置，使用 ANY 替代 ALL
```

### 原因 4: 表结构错误

**症状**: 写入失败，日志提示 "Unknown column" 或 "Type mismatch"

**解决方案**:
```bash
# 1. 查看表结构
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "DESCRIBE TABLE sleep_analytics.device_telemetry"

# 2. 查看写入数据的结构
# 检查应用日志中的写入数据

# 3. 如果表结构不匹配，修改表结构
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "
  ALTER TABLE sleep_analytics.device_telemetry
  ADD COLUMN IF NOT EXISTS new_column String DEFAULT ''
"

# 4. 或者修改应用写入逻辑
# 更新应用配置

# 5. 验证写入恢复
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "SELECT count() FROM sleep_analytics.device_telemetry WHERE event_date = today()"
```

### 原因 5: ZooKeeper 故障（如果使用）

**症状**: 写入失败，日志提示 "ZooKeeper connection lost" 或 "Session expired"

**解决方案**:
```bash
# 1. 检查 ZooKeeper 状态
kubectl get pods -n zookeeper

# 2. 检查 ZooKeeper 日志
kubectl logs -n zookeeper zookeeper-0 --tail=50

# 3. 重启 ZooKeeper（如果需要）
kubectl rollout restart statefulset/zookeeper -n zookeeper

# 4. 等待 ZooKeeper 恢复
kubectl rollout status statefulset/zookeeper -n zookeeper

# 5. 重启 ClickHouse
kubectl rollout restart statefulset/clickhouse -n analytics

# 6. 验证写入恢复
```

### 原因 6: 网络问题

**症状**: 写入超时，日志提示 "Connection timeout" 或 "Connection refused"

**解决方案**:
```bash
# 1. 检查网络连通性
kubectl exec -n analytics clickhouse-0 -- ping clickhouse-1.clickhouse.analytics.svc.cluster.local

# 2. 检查端口连通性
kubectl exec -n analytics clickhouse-0 -- wget -qO- http://clickhouse-1:8123/ping

# 3. 检查 Service
kubectl get svc -n analytics

# 4. 检查 Endpoints
kubectl get endpoints -n analytics

# 5. 检查网络策略
kubectl get networkpolicy -n analytics

# 6. 如果是网络策略问题，调整策略
```

## 数据恢复

### 从 Kafka 重放数据

```bash
# 1. 确认 Kafka 中还有数据
kubectl exec -n messaging kafka-0 -- kafka-run-class.sh kafka.tools.GetOffsetShell --broker-list localhost:9092 --topic clickhouse-events

# 2. 重置消费者偏移量
kubectl exec -n messaging kafka-0 -- kafka-consumer-groups.sh --bootstrap-server localhost:9092 --group clickhouse-consumer --reset-offsets --to-earliest --execute --topic clickhouse-events

# 3. 重启数据管道服务
kubectl rollout restart deployment/data-pipeline -n backend

# 4. 监控数据重放进度
```

### 从备份恢复

```bash
# 1. 查找最近的备份
# rclone ls aliyun:clickhouse-backup/

# 2. 下载备份
# rclone copy aliyun:clickhouse-backup/20260820/ /tmp/backup/

# 3. 恢复数据
# clickhouse-backup restore 20260820

# 4. 验证数据完整性
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "SELECT count() FROM sleep_analytics.device_telemetry"
```

## 验证恢复

```bash
# 1. ClickHouse 服务正常
kubectl get pods -n analytics | grep -v Running

# 2. 写入成功
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "INSERT INTO sleep_analytics.test_table VALUES (1, 'test')"
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "SELECT * FROM sleep_analytics.test_table"

# 3. 数据管道正常
kubectl logs -n backend -l app=data-pipeline --tail=50 | grep -i error

# 4. 分析数据更新
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "SELECT max(event_time) FROM sleep_analytics.device_telemetry"

# 5. 磁盘空间正常
kubectl exec -n analytics clickhouse-0 -- df -h | grep -v "Use%" | awk '{if ($5+0 > 80) print "WARNING: " $0}'
```

## 升级条件

- 30分钟内无法恢复写入
- 数据丢失风险
- 需要从备份恢复
- 影响超过 1000 用户
- 磁盘空间持续不足

## 事后复盘要求

- 写入失败超过 1 小时：必须复盘
- 数据丢失：必须复盘
- 磁盘空间不足导致：必须复盘
- 分析故障根本原因
- 优化监控和告警
- 更新 Runbook

## 相关 Runbook

- [Kafka 延迟过高](./kafka-lag-high.md)
- [PostgreSQL 主库宕机](./postgres-master-down.md)
- [API 5xx 故障](./api-5xx-outage.md)
- [全量回滚](./full-site-rollback.md)
