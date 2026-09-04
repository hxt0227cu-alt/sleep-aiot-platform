# Runbook: 租户资源耗尽

## 概述

**故障类型**: 资源配额故障
**严重级别**: Medium (P3)
**响应时间**: 1小时
**解决时间**: 4小时
**负责人**: 运维人员 / 产品团队

## 故障现象

- 租户 API 调用被限流
- 租户资源使用达到配额上限
- 租户用户报告服务不可用
- 配额告警触发
- 新设备无法添加

## 快速诊断步骤

### 1. 确认租户资源使用（10分钟）

```bash
# 查看租户配额使用情况
kubectl exec -n backend deploy/tenant-service -- wget -qO- http://localhost:3000/api/v1/tenant/<tenant-id>/usage

# 查看所有租户配额使用
kubectl exec -n backend deploy/tenant-service -- wget -qO- http://localhost:3000/api/v1/admin/tenants/usage

# 查看限流日志
kubectl logs -n backend -l app=rate-limiter --tail=100 | grep <tenant-id>

# 查看租户信息
kubectl exec -n backend deploy/tenant-service -- wget -qO- http://localhost:3000/api/v1/tenant/<tenant-id>
```

### 2. 定位资源耗尽类型（10分钟）

```bash
# 查看各资源类型使用情况
# API 调用次数
# 设备数量
# 数据存储量
# AI Token 用量
# 用户数量

# 查看资源使用趋势
# Grafana 面板: Tenant Resource Usage
```

## 常见原因和解决方案

### 原因 1: API 调用配额耗尽

**症状**: API 返回 429 Too Many Requests，租户 API 调用被限流

**解决方案**:
```bash
# 1. 确认 API 调用配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- http://localhost:3000/api/v1/tenant/<tenant-id>/quota | jq '.api_calls'

# 2. 查看 API 调用趋势
# Grafana 面板

# 3. 临时提升配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- \
  --post-data='{"api_calls_limit": 100000}' \
  http://localhost:3000/api/v1/admin/tenant/<tenant-id>/quota

# 4. 分析异常调用
# 查看是否有异常高频调用
kubectl logs -n backend -l app=rate-limiter --tail=1000 | grep <tenant-id> | awk '{print $NF}' | sort | uniq -c | sort -rn | head -10

# 5. 如果是异常调用，限制特定 API
kubectl exec -n backend deploy/rate-limiter -- wget -qO- \
  --post-data='{"tenant_id":"<tenant-id>","api_path":"/api/v1/*","rate_limit":100}' \
  http://localhost:3000/api/v1/admin/rate-limit/custom
```

### 原因 2: 设备数量配额耗尽

**症状**: 无法添加新设备，提示设备数量已达上限

**解决方案**:
```bash
# 1. 确认设备配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- http://localhost:3000/api/v1/tenant/<tenant-id>/quota | jq '.device_limit'

# 2. 查看当前设备数量
kubectl exec -n backend deploy/device-service -- wget -qO- http://localhost:3000/api/v1/devices?tenant_id=<tenant-id> | jq '.total'

# 3. 清理离线设备
# 查看长期离线设备
kubectl exec -n backend deploy/device-service -- wget -qO- "http://localhost:3000/api/v1/devices?tenant_id=<tenant-id>&status=offline&offline_days=30"

# 4. 临时提升配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- \
  --post-data='{"device_limit": 500}' \
  http://localhost:3000/api/v1/admin/tenant/<tenant-id>/quota

# 5. 联系租户确认是否需要升级套餐
```

### 原因 3: 数据存储配额耗尽

**症状**: 数据写入失败，提示存储空间不足

**解决方案**:
```bash
# 1. 确认存储配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- http://localhost:3000/api/v1/tenant/<tenant-id>/quota | jq '.storage_limit_gb'

# 2. 查看当前存储使用
kubectl exec -n analytics clickhouse-0 -- clickhouse-client --query "
  SELECT formatReadableSize(sum(bytes)) as total_size
  FROM system.parts
  WHERE database = 'sleep_analytics' AND table LIKE '%<tenant-id>%'
"

# 3. 清理过期数据
# 查看数据保留策略
kubectl exec -n backend deploy/data-lifecycle -- wget -qO- http://localhost:3000/api/v1/admin/retention-policy

# 4. 触发数据清理
kubectl exec -n backend deploy/data-lifecycle -- wget -qO- \
  --post-data='{"tenant_id":"<tenant-id>","action":"cleanup"}' \
  http://localhost:3000/api/v1/admin/data-lifecycle/trigger

# 5. 临时提升配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- \
  --post-data='{"storage_limit_gb": 100}' \
  http://localhost:3000/api/v1/admin/tenant/<tenant-id>/quota
```

### 原因 4: AI Token 配额耗尽

**症状**: AI 功能不可用，提示 Token 用量已达上限

**解决方案**:
```bash
# 1. 确认 AI Token 配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- http://localhost:3000/api/v1/tenant/<tenant-id>/quota | jq '.ai_token_limit'

# 2. 查看 Token 使用趋势
# Grafana 面板: AI Token Usage

# 3. 分析 Token 消耗
# 查看是否有异常高消耗
kubectl logs -n ai -l app=ai-service --tail=1000 | grep <tenant-id> | awk '{print $NF}' | sort -n | tail -10

# 4. 临时提升配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- \
  --post-data='{"ai_token_limit": 1000000}' \
  http://localhost:3000/api/v1/admin/tenant/<tenant-id>/quota

# 5. 优化 AI 使用
# 启用缓存
# 限制单次请求 Token 数
# 启用输入长度限制
```

### 原因 5: 用户数量配额耗尽

**症状**: 无法添加新用户，提示用户数量已达上限

**解决方案**:
```bash
# 1. 确认用户配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- http://localhost:3000/api/v1/tenant/<tenant-id>/quota | jq '.user_limit'

# 2. 查看当前用户数量
kubectl exec -n backend deploy/user-service -- wget -qO- "http://localhost:3000/api/v1/users?tenant_id=<tenant-id>" | jq '.total'

# 3. 清理未激活用户
# 查看长期未登录用户
kubectl exec -n backend deploy/user-service -- wget -qO- "http://localhost:3000/api/v1/admin/users?tenant_id=<tenant-id>&inactive_days=90"

# 4. 临时提升配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- \
  --post-data='{"user_limit": 100}' \
  http://localhost:3000/api/v1/admin/tenant/<tenant-id>/quota

# 5. 联系租户确认是否需要升级套餐
```

## 配额管理

### 配额类型

| 配额类型 | 免费版 | 基础版 | 专业版 | 企业版 |
|---------|--------|--------|--------|--------|
| API 调用/天 | 1,000 | 10,000 | 100,000 | 无限 |
| 设备数量 | 1 | 10 | 100 | 无限 |
| 存储 (GB) | 1 | 10 | 100 | 无限 |
| AI Token/月 | 1,000 | 10,000 | 100,000 | 无限 |
| 用户数量 | 1 | 5 | 20 | 无限 |

### 配额告警阈值

| 告警级别 | 阈值 | 动作 |
|---------|------|------|
| 提醒 | 80% | 邮件通知租户 |
| 警告 | 90% | 邮件 + 应用内通知 |
| 严重 | 95% | 邮件 + 应用内通知 + 客服联系 |
| 限制 | 100% | 限流/拒绝新请求 |

### 配额重置

```bash
# 每日配额重置（API 调用）
# 每天 00:00 UTC 自动重置

# 每月配额重置（AI Token）
# 每月 1 日 00:00 UTC 自动重置

# 手动重置配额
kubectl exec -n backend deploy/tenant-service -- wget -qO- \
  --post-data='{"tenant_id":"<tenant-id>","quota_type":"api_calls","action":"reset"}' \
  http://localhost:3000/api/v1/admin/tenant/quota/reset
```

## 租户升级流程

### 步骤 1: 确认需求

```bash
# 1. 联系租户确认需求
# 2. 确认当前套餐和使用情况
# 3. 推荐合适的套餐
```

### 步骤 2: 临时提升配额

```bash
# 1. 临时提升配额（7天有效期）
kubectl exec -n backend deploy/tenant-service -- wget -qO- \
  --post-data='{"tenant_id":"<tenant-id>","temporary_quota":{"api_calls_limit":100000},"duration_days":7}' \
  http://localhost:3000/api/v1/admin/tenant/quota/temporary

# 2. 通知租户配额已临时提升
```

### 步骤 3: 套餐升级

```bash
# 1. 租户完成付费
# 2. 更新租户套餐
kubectl exec -n backend deploy/tenant-service -- wget -qO- \
  --post-data='{"tenant_id":"<tenant-id>","plan":"professional"}' \
  http://localhost:3000/api/v1/admin/tenant/plan

# 3. 配额自动更新为新套餐配额
# 4. 通知租户升级完成
```

## 验证恢复

```bash
# 1. 配额已提升
kubectl exec -n backend deploy/tenant-service -- wget -qO- http://localhost:3000/api/v1/tenant/<tenant-id>/quota

# 2. API 调用恢复正常
# 测试 API 调用
curl -H "Authorization: Bearer <token>" https://api.sleep-monitor.com/api/v1/devices

# 3. 无 429 错误
kubectl logs -n backend -l app=rate-limiter --tail=50 | grep <tenant-id> | grep 429 | wc -l

# 4. 租户确认服务恢复
```

## 升级条件

- 配额耗尽影响超过 100 用户
- 租户要求紧急提升配额
- 异常调用导致配额耗尽
- 需要临时提升配额超过 7 天
- 需要升级套餐

## 事后复盘要求

- 配额耗尽导致服务中断超过 1 小时：必须复盘
- 异常调用导致配额耗尽：必须复盘
- 分析配额耗尽根本原因
- 优化配额告警和通知
- 优化租户套餐设计
- 更新 Runbook

## 相关 Runbook

- [API 5xx 故障](./api-5xx-outage.md)
- [Kafka 延迟过高](./kafka-lag-high.md)
- [AI 成本异常](./ai-cost-anomaly.md)
- [全量回滚](./full-site-rollback.md)
