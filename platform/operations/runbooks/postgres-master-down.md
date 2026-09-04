# Runbook: PostgreSQL 主库宕机

## 概述

**故障类型**: 数据库故障
**严重级别**: Critical (P1)
**响应时间**: 5分钟
**解决时间**: 15分钟
**负责人**: DBA / 值班人员

## 故障现象

- 后端 API 大量 500 错误，数据库连接失败
- PostgreSQL 主库 Pod 状态异常或不可达
- 应用日志中大量 `connection refused` / `timeout`
- 监控告警 `PostgreSQLDown` 触发

## 快速诊断步骤

### 1. 确认主库状态（2分钟）

```bash
# 查看 PostgreSQL Pod 状态
kubectl get pods -n database -l app=postgres -o wide

# 查看主库 Pod 详情
kubectl describe pod -n database postgres-0

# 查看主库日志
kubectl logs -n database postgres-0 --tail=100

# 查看之前的日志（如果 Pod 已重启）
kubectl logs -n database postgres-0 --previous --tail=100
```

### 2. 检查从库状态（2分钟）

```bash
# 查看从库状态
kubectl exec -n database postgres-1 -- psql -U postgres -c "SELECT * FROM pg_stat_replication;"

# 查看从库是否可提升为主库
kubectl exec -n database postgres-1 -- psql -U postgres -c "SELECT pg_is_in_recovery();"
```

### 3. 检查资源和事件（1分钟）

```bash
# 查看节点资源
kubectl top nodes

# 查看数据库 Pod 资源
kubectl top pods -n database

# 查看最近事件
kubectl get events -n database --sort-by=.lastTimestamp | tail -20
```

## 解决方案

### 方案 1: 主库 Pod 崩溃但可恢复

**适用场景**: Pod 崩溃但存储完好，可自动重启

**步骤**:
```bash
# 1. 等待 Pod 自动重启（CrashLoopBackOff 除外）
kubectl get pods -n database -l app=postgres -w

# 2. 如果 Pod 卡在 CrashLoopBackOff，查看错误原因
kubectl logs -n database postgres-0 --previous

# 3. 常见问题修复
# - 配置错误: 修正 ConfigMap 后删除 Pod 触发重建
# - 存储满: 清理空间或扩容
# - 权限问题: 修正 PVC 权限

# 4. 手动删除 Pod 触发重建
kubectl delete pod -n database postgres-0

# 5. 等待 Pod 恢复
kubectl wait --for=condition=Ready pod/postgres-0 -n database --timeout=120s
```

### 方案 2: 主库完全不可用，提升从库

**适用场景**: 主库无法恢复，需要故障转移

**步骤**:
```bash
# 1. 确认从库数据同步状态
kubectl exec -n database postgres-1 -- psql -U postgres -c "SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"

# 2. 提升从库为主库
kubectl exec -n database postgres-1 -- psql -U postgres -c "SELECT pg_promote();"

# 3. 验证提升成功
kubectl exec -n database postgres-1 -- psql -U postgres -c "SELECT pg_is_in_recovery();"
# 应返回 false

# 4. 更新服务指向新主库
# 修改 Service selector 或更新连接串
kubectl patch service postgres -n database -p '{"spec":{"selector":{"app":"postgres","statefulset.kubernetes.io/pod-name":"postgres-1"}}}'

# 5. 通知应用重新连接
# 滚动重启后端服务
kubectl rollout restart deployment/backend-api -n backend

# 6. 原主库恢复后，将其转为从库
# （需要重新配置流复制）
```

### 方案 3: 存储损坏，从备份恢复

**适用场景**: 数据损坏，无法从 Pod 恢复

**步骤**:
```bash
# 1. 确认数据损坏
kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT * FROM pg_stat_database WHERE datname='sleep_platform';"

# 2. 查找最近的备份
# 查看备份存储（OSS/S3）
# rclone ls aliyun:postgres-backup/ | tail -10

# 3. 创建新的 PostgreSQL 实例
# 使用备份恢复
# kubectl apply -f postgres-restore.yaml

# 4. 恢复数据
# pg_restore 或 WAL 回放

# 5. 切换应用到新实例
```

## 验证恢复

```bash
# 1. 主库可连接
kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT 1;"

# 2. 应用连接正常
kubectl logs -n backend -l app=backend-api --tail=50 | grep -i "database" | grep -i "error" | wc -l
# 应为 0

# 3. 复制正常（如果有从库）
kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT * FROM pg_stat_replication;"

# 4. 错误率恢复正常
# 查看 Grafana 面板
```

## 升级条件

- 10分钟内无法恢复主库
- 数据损坏需要从备份恢复
- 影响超过 1000 用户
- 需要 DBA 深度介入

## 事后复盘要求

- 必须进行事后复盘
- 分析主库宕机根本原因
- 评估是否需要增加从库或调整高可用方案
- 更新 Runbook

## 相关 Runbook

- [API 5xx 故障](./api-5xx-outage.md)
- [数据误删除](./data-accidental-delete.md)
- [全量回滚](./full-site-rollback.md)
