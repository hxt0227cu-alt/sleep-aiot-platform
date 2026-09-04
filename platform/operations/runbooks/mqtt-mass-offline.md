# Runbook: MQTT 设备大规模离线

## 概述

**故障类型**: IoT 服务故障
**严重级别**: Critical (P1)
**响应时间**: 5分钟
**解决时间**: 30分钟
**负责人**: IoT 团队 / 值班人员

## 故障现象

- 大量设备同时离线
- MQTT 连接数骤降
- 设备心跳超时告警
- 监控告警 `MQTTMassOffline` 触发
- 用户报告设备不工作

## 快速诊断步骤

### 1. 确认离线规模（2分钟）

```bash
# 查看 EMQX 连接数
kubectl exec -n iot deploy/emqx -- emqx_ctl listeners

# 查看当前连接数
kubectl exec -n iot deploy/emqx -- emqx_ctl stats | grep connections

# 查看连接数历史
# 查看 Grafana 面板
```

### 2. 检查 EMQX 集群状态（3分钟）

```bash
# 查看 EMQX Pod 状态
kubectl get pods -n iot -l app=emqx -o wide

# 查看 EMQX 集群状态
kubectl exec -n iot emqx-0 -- emqx_ctl cluster status

# 查看 EMQX 日志
kubectl logs -n iot emqx-0 --tail=100

# 查看 EMQX 资源使用
kubectl top pods -n iot -l app=emqx
```

### 3. 检查网络和依赖（3分钟）

```bash
# 检查 DNS 解析
kubectl exec -n iot emqx-0 -- nslookup mqtt.sleep-monitor.com

# 检查数据库连接
kubectl exec -n iot emqx-0 -- wget -qO- http://postgres.database:5432/ 2>&1 | head -5

# 检查 Redis 连接
kubectl exec -n iot emqx-0 -- redis-cli -h redis.cache ping

# 检查负载均衡器
kubectl get svc -n iot emqx
```

## 常见原因和解决方案

### 原因 1: EMQX 节点崩溃

**症状**: EMQX Pod 重启或 CrashLoopBackOff

**解决方案**:
```bash
# 1. 查看崩溃原因
kubectl describe pod -n iot emqx-0 | grep -A10 "Last State"

# 2. 查看日志
kubectl logs -n iot emqx-0 --previous --tail=100

# 3. 如果是 OOM，增加内存
kubectl set resources statefulset emqx -n iot --limits=memory=8Gi --requests=memory=4Gi

# 4. 等待 Pod 恢复
kubectl rollout status statefulset/emqx -n iot

# 5. 验证集群状态
kubectl exec -n iot emqx-0 -- emqx_ctl cluster status
```

### 原因 2: 数据库连接池耗尽

**症状**: EMQX 日志中大量数据库连接超时

**解决方案**:
```bash
# 1. 查看数据库连接数
kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT count(*) FROM pg_stat_activity;"

# 2. 查看等待连接
kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT * FROM pg_stat_activity WHERE state = 'active' ORDER BY query_start LIMIT 10;"

# 3. 增加 EMQX 数据库连接池大小
kubectl set env statefulset/emqx -n iot EMQX_AUTHENTICATION__1__DATABASE__POOL_SIZE=32

# 4. 重启 EMQX
kubectl rollout restart statefulset/emqx -n iot

# 5. 终止空闲数据库连接
kubectl exec -n database postgres-0 -- psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND state_change < NOW() - INTERVAL '5 minutes';"
```

### 原因 3: 网络故障 / DNS 问题

**症状**: 设备无法连接 MQTT Broker，DNS 解析失败

**解决方案**:
```bash
# 1. 检查 DNS 解析
kubectl exec -n iot emqx-0 -- nslookup mqtt.sleep-monitor.com

# 2. 如果 DNS 故障，检查 CoreDNS
kubectl get pods -n kube-system -l k8s-app=kube-dns

# 3. 检查负载均衡器
kubectl get svc -n iot emqx -o wide

# 4. 检查安全组/防火墙
# 阿里云控制台检查安全组规则

# 5. 如果是云服务商故障，等待恢复或切换备用入口
```

### 原因 4: 认证服务故障

**症状**: 设备连接时认证失败，大量连接被拒绝

**解决方案**:
```bash
# 1. 查看认证服务状态
kubectl get pods -n backend -l app=auth-service

# 2. 查看认证服务日志
kubectl logs -n backend -l app=auth-service --tail=50

# 3. 如果认证服务故障，重启或扩容
kubectl rollout restart deployment/auth-service -n backend

# 4. 临时启用 EMQX 本地认证（降级模式）
kubectl set env statefulset/emqx -n iot EMQX_AUTHENTICATION__1__ENABLE=false

# 5. 注意：降级模式下安全性降低，恢复后应立即关闭
```

### 原因 5: 设备端固件 Bug

**症状**: 特定批次设备同时离线，其他设备正常

**解决方案**:
```bash
# 1. 分析离线设备特征
# 查看设备批次、固件版本、地区

# 2. 如果是特定固件版本问题，触发 OTA 回滚
# 参考 OTA 异常 Runbook

# 3. 临时增加连接超时
kubectl set env statefulset/emqx -n iot EMQX_MQTT__CLIENT_IDLE_TIMEOUT=120s
```

## 验证恢复

```bash
# 1. 连接数恢复
kubectl exec -n iot emqx-0 -- emqx_ctl stats | grep connections

# 2. 设备重新上线
# 查看设备管理后台

# 3. 无新的连接拒绝
kubectl logs -n iot emqx-0 --tail=50 | grep -i "deny" | wc -l

# 4. 业务数据恢复正常
# 查看数据摄入指标
```

## 升级条件

- 10分钟内连接数未恢复
- 超过 50% 设备离线
- EMQX 集群故障
- 涉及安全事件（如大规模未授权连接）
- 影响超过 1000 用户

## 事后复盘要求

- 离线设备超过 1000 台：必须复盘
- 持续超过 30 分钟：必须复盘
- 分析离线根本原因
- 评估是否需要增加 EMQX 集群容量
- 检查设备重连机制是否合理

## 相关 Runbook

- [API 5xx 故障](./api-5xx-outage.md)
- [Kafka 延迟过高](./kafka-lag-high.md)
- [OTA 异常](./ota-abnormal.md)
- [PostgreSQL 主库宕机](./postgres-master-down.md)
