# Runbook: API 5xx 故障

## 概述

**故障类型**: 服务故障
**严重级别**: Critical (P1)
**响应时间**: 5分钟
**解决时间**: 30分钟
**负责人**: 后端团队 / 值班人员

## 故障现象

- API 返回大量 5xx 错误（500/502/503/504）
- 客户端报告服务不可用
- Grafana 面板显示错误率飙升
- PagerDuty 告警触发

## 快速诊断步骤

### 1. 确认故障范围（2分钟）

```bash
# 查看 API 错误率
kubectl get pods -n backend -o wide

# 查看最近的 Pod 重启
kubectl get pods -n backend --sort-by=.status.containerStatuses[0].restartCount

# 查看 Pod 日志
kubectl logs -n backend -l app=backend-api --tail=100 --previous
```

### 2. 检查依赖服务（3分钟）

```bash
# 检查数据库连接
kubectl exec -n backend deploy/backend-api -- wget -qO- http://postgres.database:5432/ 2>&1 | head -5

# 检查 Redis
kubectl exec -n backend deploy/backend-api -- redis-cli -h redis.cache ping

# 检查 MQTT
kubectl exec -n backend deploy/backend-api -- wget -qO- http://emqx.iot:18083/status 2>&1 | head -5
```

### 3. 查看资源使用情况（2分钟）

```bash
# 查看 CPU/内存使用
kubectl top pods -n backend

# 查看节点资源
kubectl top nodes

# 查看事件
kubectl get events -n backend --sort-by=.lastTimestamp | tail -20
```

## 常见原因和解决方案

### 原因 1: 数据库连接池耗尽

**症状**: 日志中大量 `Connection timeout` / `Too many connections`

**解决方案**:
```bash
# 1. 查看数据库连接数
kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT count(*) FROM pg_stat_activity;"

# 2. 查看等待连接
kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT * FROM pg_stat_activity WHERE state = 'active' ORDER BY query_start LIMIT 10;"

# 3. 临时扩容后端实例
kubectl scale deployment backend-api -n backend --replicas=6

# 4. 如数据库连接数过高，终止空闲连接
kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND state_change < NOW() - INTERVAL '5 minutes';"
```

### 原因 2: Pod OOM 被 Kill

**症状**: Pod 频繁重启，`Reason: OOMKilled`

**解决方案**:
```bash
# 1. 确认 OOM
kubectl describe pod -n backend <pod-name> | grep -A5 "Last State"

# 2. 临时增加内存限制
kubectl set resources deployment backend-api -n backend --limits=memory=4Gi --requests=memory=2Gi

# 3. 等待滚动更新完成
kubectl rollout status deployment/backend-api -n backend

# 4. 后续：分析内存泄漏原因
```

### 原因 3: 下游服务不可用

**症状**: 日志中大量 `connection refused` / `timeout`

**解决方案**:
```bash
# 1. 确认下游服务状态
kubectl get pods -n database
kubectl get pods -n cache
kubectl get pods -n iot

# 2. 如果下游服务故障，先恢复下游
# 参考对应服务的 Runbook

# 3. 临时启用降级模式（如果支持）
kubectl set env deployment/backend-api -n backend FEATURE_FLAG_DEGRADED_MODE=true
```

### 原因 4: 新版本引入 Bug

**症状**: 故障发生在部署后

**解决方案**:
```bash
# 1. 查看最近的部署
kubectl rollout history deployment/backend-api -n backend

# 2. 回滚到上一个版本
kubectl rollout undo deployment/backend-api -n backend

# 3. 等待回滚完成
kubectl rollout status deployment/backend-api -n backend

# 4. 确认错误率下降
```

### 原因 5: 流量突增 / 爬虫攻击

**症状**: QPS 异常升高，来自特定 IP 或 User-Agent

**解决方案**:
```bash
# 1. 查看流量来源
kubectl logs -n backend -l app=backend-api --tail=1000 | grep -oP '(?<=from )\d+\.\d+\.\d+\.\d+' | sort | uniq -c | sort -rn | head -10

# 2. 临时限流
# 在 Ingress / API Gateway 配置限流规则

# 3. 封禁恶意 IP
# 在 WAF / 安全组中封禁
```

## 升级条件

满足以下任一条件，立即升级到值班主管：
- 15分钟内无法定位原因
- 影响用户超过 1000 人
- 涉及数据丢失风险
- 需要全量回滚
- 多个服务同时故障

## 验证恢复

```bash
# 1. 错误率恢复正常（< 1%）
# 查看 Grafana 面板

# 2. Pod 状态正常
kubectl get pods -n backend | grep -v Running

# 3. 无新的 5xx 告警
# 查看 PagerDuty

# 4. 响应时间恢复正常
# 查看 Grafana P95 延迟面板
```

## 事后复盘要求

- 故障持续超过 30 分钟：必须进行事后复盘
- 涉及数据丢失：必须进行事后复盘
- 复盘会议在故障恢复后 48 小时内举行
- 复盘报告在 1 周内完成

## 相关 Runbook

- [PostgreSQL 主库宕机](./postgres-master-down.md)
- [Redis 故障转移失败](./redis-failover-fail.md)
- [Kafka 延迟过高](./kafka-lag-high.md)
- [全量回滚](./full-site-rollback.md)
