# Runbook: 报警通知失败

## 概述

**故障类型**: 通知服务故障
**严重级别**: High (P2)
**响应时间**: 15分钟
**解决时间**: 2小时
**负责人**: 后端团队 / 运维人员

## 故障现象

- 报警触发但用户未收到通知
- 通知服务返回错误
- 短信/电话/推送通知发送失败
- 通知队列积压
- 用户投诉未收到报警

## 快速诊断步骤

### 1. 确认通知服务状态（5分钟）

```bash
# 查看通知服务 Pod 状态
kubectl get pods -n backend -l app=notification-service -o wide

# 查看通知服务日志
kubectl logs -n backend -l app=notification-service --tail=100

# 查看通知服务健康检查
kubectl exec -n backend deploy/notification-service -- wget -qO- http://localhost:3000/health
```

### 2. 检查通知渠道（10分钟）

```bash
# 检查短信服务状态
kubectl logs -n backend -l app=notification-service --tail=100 | grep -i "sms\|短信" | tail -20

# 检查电话服务状态
kubectl logs -n backend -l app=notification-service --tail=100 | grep -i "voice\|电话" | tail -20

# 检查推送服务状态
kubectl logs -n backend -l app=notification-service --tail=100 | grep -i "push\|推送" | tail -20

# 检查消息队列
kubectl exec -n messaging kafka-0 -- kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group notification-group
```

## 常见原因和解决方案

### 原因 1: 第三方通知服务故障

**症状**: 短信/电话服务返回错误，所有通知渠道失败

**解决方案**:
```bash
# 1. 确认第三方服务状态
# 查看阿里云短信服务状态页
# 查看错误码

# 2. 切换到备用通知渠道
kubectl set env deployment/notification-service -n backend NOTIFICATION_PROVIDER=backup

# 3. 重启通知服务
kubectl rollout restart deployment/notification-service -n backend

# 4. 等待第三方服务恢复
# 联系第三方服务商支持
```

### 原因 2: 通知配额耗尽

**症状**: 通知服务返回配额不足错误

**解决方案**:
```bash
# 1. 检查配额使用情况
kubectl logs -n backend -l app=notification-service --tail=100 | grep -i "quota\|配额" | tail -10

# 2. 临时提升配额
# 联系第三方服务商提升配额

# 3. 启用通知降级
# 只发送高优先级通知
kubectl set env deployment/notification-service -n backend NOTIFICATION_PRIORITY_FILTER=high

# 4. 重启服务
kubectl rollout restart deployment/notification-service -n backend
```

### 原因 3: 通知队列积压

**症状**: Kafka 通知主题延迟高，通知发送延迟

**解决方案**:
```bash
# 1. 检查消费者延迟
kubectl exec -n messaging kafka-0 -- kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group notification-group

# 2. 扩容通知服务
kubectl scale deployment notification-service -n backend --replicas=6

# 3. 增加分区数（如果需要）
kubectl exec -n messaging kafka-0 -- kafka-topics.sh --bootstrap-server localhost:9092 --alter --topic alarm-notifications --partitions 12

# 4. 等待延迟下降
# 监控 Kafka 消费者延迟
```

### 原因 4: 通知服务配置错误

**症状**: 通知服务启动失败或返回配置错误

**解决方案**:
```bash
# 1. 检查配置
kubectl exec -n backend deploy/notification-service -- env | grep -i notification

# 2. 检查 ConfigMap
kubectl get configmap -n backend notification-config -o yaml

# 3. 检查 Secret
kubectl get secret -n backend notification-secret -o yaml

# 4. 修正配置后重启
kubectl rollout restart deployment/notification-service -n backend
```

### 原因 5: 报警检测服务故障

**症状**: 报警未触发，不是通知问题而是检测问题

**解决方案**:
```bash
# 1. 检查报警服务状态
kubectl get pods -n backend -l app=alarm-service

# 2. 检查报警服务日志
kubectl logs -n backend -l app=alarm-service --tail=100

# 3. 检查报警规则
kubectl exec -n backend deploy/alarm-service -- wget -qO- http://localhost:3000/api/v1/alarm/rules

# 4. 参考报警服务 Runbook
```

## 通知降级策略

### 降级级别

| 级别 | 触发条件 | 策略 |
|------|---------|------|
| L0 | 正常 | 所有通知渠道正常 |
| L1 | 单一渠道故障 | 切换到备用渠道 |
| L2 | 多渠道故障 | 只发送高优先级通知（Critical/High） |
| L3 | 所有渠道故障 | 记录通知，服务恢复后补送 |
| L4 | 服务完全不可用 | 启用备用通知系统 |

### 降级操作

```bash
# 启用 L2 降级（只发送高优先级通知）
kubectl set env deployment/notification-service -n backend \
  NOTIFICATION_DOWNGRADE_LEVEL=L2 \
  NOTIFICATION_PRIORITY_THRESHOLD=high

# 恢复正常
kubectl set env deployment/notification-service -n backend \
  NOTIFICATION_DOWNGRADE_LEVEL=L0

# 重启服务
kubectl rollout restart deployment/notification-service -n backend
```

## 验证恢复

```bash
# 1. 通知服务正常运行
kubectl get pods -n backend -l app=notification-service | grep -v Running

# 2. 发送测试通知
kubectl exec -n backend deploy/notification-service -- wget -qO- --post-data='{"type":"test","userId":"test"}' http://localhost:3000/api/v1/notification/test

# 3. 通知队列延迟正常
kubectl exec -n messaging kafka-0 -- kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group notification-group | grep -v "^\s*0\s*$"

# 4. 用户收到通知
# 确认测试用户收到通知
```

## 升级条件

- 30分钟内无法恢复通知服务
- 影响超过 1000 用户
- 涉及安全报警（如生命体征异常）
- 第三方服务长时间故障（>2小时）
- 需要启用备用通知系统

## 事后复盘要求

- 通知服务中断超过 1 小时：必须复盘
- 影响超过 100 用户：必须复盘
- 涉及安全报警通知失败：必须复盘
- 分析故障根本原因
- 优化通知渠道冗余
- 更新 Runbook

## 相关 Runbook

- [API 5xx 故障](./api-5xx-outage.md)
- [Kafka 延迟过高](./kafka-lag-high.md)
- [MQTT 设备大规模离线](./mqtt-mass-offline.md)
- [全量回滚](./full-site-rollback.md)
