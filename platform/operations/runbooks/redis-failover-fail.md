# Runbook: Redis 故障转移失败

## 概述

**故障类型**: 缓存服务故障
**严重级别**: High (P2)
**响应时间**: 10分钟
**解决时间**: 1小时
**负责人**: 运维人员 / DBA

## 故障现象

- Redis 主节点故障后，Sentinel 未进行故障转移
- 应用连接 Redis 失败
- Redis 从节点未提升为主节点
- 应用大量超时错误
- 缓存命中率下降

## 快速诊断步骤

### 1. 确认 Redis 集群状态（5分钟）

```bash
# 查看 Redis Pod 状态
kubectl get pods -n cache -o wide

# 查看 Redis 主从状态
kubectl exec -n cache redis-0 -- redis-cli -a $REDIS_PASSWORD info replication

# 查看 Sentinel 状态
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel masters
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel slaves mymaster

# 查看 Sentinel 日志
kubectl logs -n cache redis-sentinel-0 --tail=100
```

### 2. 检查网络和资源（5分钟）

```bash
# 检查节点资源
kubectl top nodes
kubectl top pods -n cache

# 检查网络连通性
kubectl exec -n cache redis-1 -- redis-cli -a $REDIS_PASSWORD -h redis-0.redis.cache.svc.cluster.local ping

# 检查事件
kubectl get events -n cache --sort-by=.lastTimestamp | tail -20
```

## 常见原因和解决方案

### 原因 1: Sentinel 配置错误

**症状**: Sentinel 无法检测到主节点故障，或无法进行故障转移

**解决方案**:
```bash
# 1. 检查 Sentinel 配置
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel get-master-addr-by-name mymaster

# 2. 检查 Sentinel 监控的主节点地址是否正确
# 如果地址错误，重新配置 Sentinel
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel monitor mymaster <correct-master-ip> 6379 2

# 3. 检查 Sentinel 仲裁数（quorum）
# 确保 quorum <= Sentinel 节点数
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel set mymaster quorum 2

# 4. 重启 Sentinel
kubectl rollout restart statefulset/redis-sentinel -n cache
```

### 原因 2: 主节点假死（网络分区）

**症状**: 主节点网络分区，Sentinel 认为主节点正常，但应用无法连接

**解决方案**:
```bash
# 1. 确认网络分区
# 从应用 Pod 测试连接主节点
kubectl exec -n backend deploy/backend-api -- redis-cli -h redis-0.redis.cache.svc.cluster.local -p 6379 ping

# 2. 手动触发故障转移
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel failover mymaster

# 3. 等待故障转移完成
sleep 30
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel get-master-addr-by-name mymaster

# 4. 验证新主节点可写
kubectl exec -n cache redis-1 -- redis-cli -a $REDIS_PASSWORD set test_key "test"
kubectl exec -n cache redis-1 -- redis-cli -a $REDIS_PASSWORD get test_key

# 5. 重启应用（清除旧连接）
kubectl rollout restart deployment/backend-api -n backend
```

### 原因 3: 从节点数据不同步

**症状**: 主节点故障后，从节点数据过期，无法提升为主节点

**解决方案**:
```bash
# 1. 检查从节点复制状态
kubectl exec -n cache redis-1 -- redis-cli -a $REDIS_PASSWORD info replication

# 2. 检查复制延迟
kubectl exec -n cache redis-1 -- redis-cli -a $REDIS_PASSWORD info replication | grep master_repl_offset

# 3. 如果从节点数据严重过期，手动全量同步
kubectl exec -n cache redis-1 -- redis-cli -a $REDIS_PASSWORD replicaof redis-0.redis.cache.svc.cluster.local 6379

# 4. 等待同步完成
sleep 60
kubectl exec -n cache redis-1 -- redis-cli -a $REDIS_PASSWORD info replication | grep master_sync_in_progress

# 5. 触发故障转移
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel failover mymaster
```

### 原因 4: Redis 内存不足

**症状**: Redis 主节点 OOM，无法正常响应

**解决方案**:
```bash
# 1. 检查 Redis 内存使用
kubectl exec -n cache redis-0 -- redis-cli -a $REDIS_PASSWORD info memory

# 2. 检查内存策略
kubectl exec -n cache redis-0 -- redis-cli -a $REDIS_PASSWORD config get maxmemory-policy

# 3. 如果内存不足，临时增加内存限制
kubectl set resources statefulset/redis -n cache --limits=memory=4Gi --requests=memory=2Gi

# 4. 等待 Pod 重启
kubectl rollout status statefulset/redis -n cache

# 5. 清理过期数据
kubectl exec -n cache redis-0 -- redis-cli -a $REDIS_PASSWORD --scan --pattern "*" | head -1000 | xargs -L 100 kubectl exec -n cache redis-0 -- redis-cli -a $REDIS_PASSWORD del
```

### 原因 5: Sentinel 节点故障

**症状**: 多个 Sentinel 节点故障，无法达到仲裁数

**解决方案**:
```bash
# 1. 检查 Sentinel 节点状态
kubectl get pods -n cache -l app=redis-sentinel

# 2. 重启故障的 Sentinel 节点
kubectl delete pod -n cache redis-sentinel-0

# 3. 等待 Sentinel 恢复
kubectl rollout status statefulset/redis-sentinel -n cache

# 4. 如果无法恢复，临时降低仲裁数
kubectl exec -n cache redis-sentinel-1 -- redis-cli -p 26379 sentinel set mymaster quorum 1

# 5. 触发故障转移
kubectl exec -n cache redis-sentinel-1 -- redis-cli -p 26379 sentinel failover mymaster

# 6. 恢复后重置仲裁数
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel set mymaster quorum 2
```

## 紧急恢复方案

### 方案 1: 手动故障转移

```bash
# 1. 确认主节点故障
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel is-master-down-by-addr <master-ip> 6379

# 2. 手动触发故障转移
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel failover mymaster

# 3. 等待故障转移完成（最多 60 秒）
for i in {1..12}; do
  sleep 5
  new_master=$(kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel get-master-addr-by-name mymaster)
  if [ "$new_master" != "<old-master-ip> 6379" ]; then
    echo "故障转移完成，新主节点: $new_master"
    break
  fi
done

# 4. 验证新主节点
kubectl exec -n cache redis-1 -- redis-cli -a $REDIS_PASSWORD info replication | grep role

# 5. 重启应用
kubectl rollout restart deployment/backend-api -n backend
```

### 方案 2: 重建 Redis 集群

```bash
# 1. 备份数据（如果主节点还能访问）
kubectl exec -n cache redis-0 -- redis-cli -a $REDIS_PASSWORD --rdb /tmp/backup.rdb
kubectl cp cache/redis-0:/tmp/backup.rdb ./backup.rdb

# 2. 删除旧的 Redis 集群
kubectl delete statefulset redis -n cache
kubectl delete statefulset redis-sentinel -n cache
kubectl delete pvc -n cache -l app=redis

# 3. 重新部署 Redis
kubectl apply -f platform/k8s/base/redis-sentinel.yaml

# 4. 等待集群就绪
kubectl rollout status statefulset/redis -n cache
kubectl rollout status statefulset/redis-sentinel -n cache

# 5. 恢复数据（如果有备份）
kubectl cp ./backup.rdb cache/redis-0:/data/dump.rdb
kubectl delete pod -n cache redis-0
kubectl rollout status statefulset/redis -n cache

# 6. 重启应用
kubectl rollout restart deployment/backend-api -n backend
```

## 验证恢复

```bash
# 1. Redis 集群状态正常
kubectl get pods -n cache | grep -v Running

# 2. 主从复制正常
kubectl exec -n cache redis-0 -- redis-cli -a $REDIS_PASSWORD info replication | grep role

# 3. Sentinel 状态正常
kubectl exec -n cache redis-sentinel-0 -- redis-cli -p 26379 sentinel masters

# 4. 应用可正常连接 Redis
kubectl logs -n backend -l app=backend-api --tail=50 | grep -i redis | grep -i error

# 5. 缓存命中率恢复正常
# 查看 Grafana Redis 面板
```

## 升级条件

- 10分钟内无法完成故障转移
- 应用无法连接 Redis 超过 15 分钟
- 数据丢失风险
- 需要重建 Redis 集群
- 影响超过 1000 用户

## 事后复盘要求

- 故障转移失败：必须复盘
- 影响超过 100 用户：必须复盘
- 数据丢失：必须复盘
- 分析故障转移失败根本原因
- 优化 Redis 高可用配置
- 更新 Runbook

## 相关 Runbook

- [API 5xx 故障](./api-5xx-outage.md)
- [PostgreSQL 主库宕机](./postgres-master-down.md)
- [Kafka 延迟过高](./kafka-lag-high.md)
- [全量回滚](./full-site-rollback.md)
