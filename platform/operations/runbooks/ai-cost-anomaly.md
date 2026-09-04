# Runbook: AI 成本异常

## 概述

**故障类型**: 成本异常
**严重级别**: High (P2)
**响应时间**: 15分钟
**解决时间**: 2小时
**负责人**: AI 团队 / 运维人员

## 故障现象

- AI 服务成本突然增加
- Token 消耗量异常
- API 调用次数激增
- 预算告警触发
- 账单异常

## 快速诊断步骤

### 1. 确认成本异常（5分钟）

```bash
# 查看 AI 服务成本监控
# Grafana 面板: AI Cost Dashboard

# 查看 Token 消耗量
kubectl exec -n ai ai-service-0 -- curl -s http://localhost:8080/metrics | grep token_usage

# 查看 API 调用量
kubectl logs -n ai -l app=ai-service --tail=100 | grep -c "api_call"
```

### 2. 定位异常来源（10分钟）

```bash
# 查看按租户的 Token 消耗
kubectl exec -n ai ai-service-0 -- curl -s http://localhost:8080/admin/usage | jq '.by_tenant'

# 查看按用户的 API 调用
kubectl exec -n ai ai-service-0 -- curl -s http://localhost:8080/admin/usage | jq '.by_user'

# 查看异常请求模式
kubectl logs -n ai -l app=ai-service --tail=1000 | grep -i "error\|timeout\|retry" | head -20
```

## 常见原因和解决方案

### 原因 1: 循环调用/无限循环

**症状**: 单个用户或租户的 API 调用量异常高，Token 消耗激增

**解决方案**:
```bash
# 1. 识别异常用户/租户
kubectl exec -n ai ai-service-0 -- curl -s http://localhost:8080/admin/usage | jq '.by_tenant | sort_by(.token_usage) | reverse | .[0]'

# 2. 临时限制该用户/租户的调用
kubectl set env deployment/ai-service -n ai RATE_LIMIT_TENANT_<tenant_id>=100

# 3. 重启 AI 服务
kubectl rollout restart deployment/ai-service -n ai

# 4. 调查循环调用原因
# 查看应用日志，定位循环调用的代码路径
```

### 原因 2: 提示词注入导致 Token 膨胀

**症状**: 单次请求的 Token 消耗量异常高

**解决方案**:
```bash
# 1. 查看大 Token 请求
kubectl logs -n ai -l app=ai-service --tail=1000 | grep -E "token_usage.*[0-9]{4,}" | head -10

# 2. 启用输入长度限制
kubectl set env deployment/ai-service -n ai MAX_INPUT_TOKENS=4000 MAX_OUTPUT_TOKENS=2000

# 3. 重启服务
kubectl rollout restart deployment/ai-service -n ai

# 4. 调查是否有提示词注入攻击
# 查看异常请求的输入内容
```

### 原因 3: 重试风暴

**症状**: 下游服务故障导致 AI 服务大量重试，Token 消耗增加

**解决方案**:
```bash
# 1. 检查下游服务状态
kubectl get pods -n backend
kubectl get pods -n database

# 2. 检查重试次数
kubectl logs -n ai -l app=ai-service --tail=100 | grep -c "retry"

# 3. 修复下游服务
# 参考对应服务的 Runbook

# 4. 临时降低重试次数
kubectl set env deployment/ai-service -n ai MAX_RETRIES=2 RETRY_DELAY_MS=1000

# 5. 重启服务
kubectl rollout restart deployment/ai-service -n ai
```

### 原因 4: 模型配置错误

**症状**: 使用了更昂贵的模型，或上下文窗口设置过大

**解决方案**:
```bash
# 1. 检查当前模型配置
kubectl exec -n ai ai-service-0 -- curl -s http://localhost:8080/admin/config | jq '.model'

# 2. 切换到更经济的模型
kubectl set env deployment/ai-service -n ai AI_MODEL=gpt-3.5-turbo MAX_TOKENS=2000

# 3. 重启服务
kubectl rollout restart deployment/ai-service -n ai

# 4. 验证成本下降
# 观察 Grafana 成本面板
```

### 原因 5: 缓存失效

**症状**: 缓存命中率下降，重复请求增加

**解决方案**:
```bash
# 1. 检查缓存命中率
kubectl exec -n ai ai-service-0 -- curl -s http://localhost:8080/metrics | grep cache_hit_rate

# 2. 检查 Redis 状态
kubectl get pods -n cache
kubectl exec -n cache redis-0 -- redis-cli info memory

# 3. 增加缓存容量或调整缓存策略
kubectl set env deployment/ai-service -n ai CACHE_TTL_SECONDS=3600 CACHE_MAX_ENTRIES=10000

# 4. 重启服务
kubectl rollout restart deployment/ai-service -n ai
```

## 成本控制措施

### 预算告警

```yaml
# 预算告警配置
budget_alerts:
  - threshold: 80%
    severity: medium
    action: notify
  - threshold: 90%
    severity: high
    action: notify + rate_limit
  - threshold: 100%
    severity: critical
    action: notify + suspend_service
```

### 限流策略

```yaml
rate_limits:
  per_user:
    requests_per_minute: 10
    tokens_per_day: 100000
  per_tenant:
    requests_per_minute: 100
    tokens_per_day: 1000000
  global:
    requests_per_minute: 1000
    tokens_per_day: 10000000
```

## 验证恢复

```bash
# 1. Token 消耗量恢复正常
# 查看 Grafana 成本面板

# 2. API 调用量恢复正常
kubectl logs -n ai -l app=ai-service --tail=100 | grep -c "api_call"

# 3. 成本告警解除
# 查看预算告警状态

# 4. 服务正常运行
kubectl get pods -n ai | grep -v Running
```

## 升级条件

- 30分钟内无法定位成本异常原因
- 成本超过预算 200%
- 涉及安全事件（如提示词注入攻击）
- 需要暂停 AI 服务

## 事后复盘要求

- 成本异常持续超过 1 小时：必须复盘
- 成本超过预算 150%：必须复盘
- 分析成本异常根本原因
- 优化成本控制措施
- 更新 Runbook

## 相关 Runbook

- [API 5xx 故障](./api-5xx-outage.md)
- [Kafka 延迟过高](./kafka-lag-high.md)
- [Redis 故障转移失败](./redis-failover-fail.md)
