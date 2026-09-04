# Runbook: 全量回滚

## 概述

**故障类型**: 发布故障
**严重级别**: Critical (P1)
**响应时间**: 5分钟
**解决时间**: 30分钟
**负责人**: 值班主管 / 工程经理

## 适用场景

- 新版本发布后出现严重故障
- 多个服务同时异常
- 数据错误或安全漏洞
- 性能严重下降
- 无法快速定位和修复问题

## 回滚前确认

### 1. 确认需要回滚（2分钟）

- [ ] 故障影响超过 1000 用户
- [ ] 故障持续超过 15 分钟未恢复
- [ ] 无法快速定位根因
- [ ] 多个服务同时异常
- [ ] 值班主管确认需要回滚

### 2. 确认回滚版本（2分钟）

```bash
# 查看部署历史
kubectl rollout history deployment/backend-api -n backend

# 查看当前版本
kubectl get deployment backend-api -n backend -o jsonpath='{.spec.template.spec.containers[0].image}'

# 确认上一个稳定版本
# 查看 Git 标签或部署记录
```

### 3. 通知相关人员（1分钟）

- 在飞书故障群通知全量回滚
- 通知值班主管和工程经理
- 通知客户成功团队（如影响用户）

## 回滚步骤

### 步骤 1: 后端服务回滚（5分钟）

```bash
# 回滚后端 API
kubectl rollout undo deployment/backend-api -n backend

# 回滚其他后端服务
kubectl rollout undo deployment/alarm-service -n backend
kubectl rollout undo deployment/ota-service -n backend
kubectl rollout undo deployment/data-pipeline -n backend

# 等待回滚完成
kubectl rollout status deployment/backend-api -n backend --timeout=120s
kubectl rollout status deployment/alarm-service -n backend --timeout=120s
```

### 步骤 2: 前端回滚（3分钟）

```bash
# 回滚前端部署
kubectl rollout undo deployment/web-frontend -n frontend

# 等待回滚完成
kubectl rollout status deployment/web-frontend -n frontend --timeout=60s

# 清除 CDN 缓存（如果需要）
# 阿里云 CDN 控制台操作或 API 调用
```

### 步骤 3: 小程序回滚（如需要）

```bash
# 小程序回滚需要在微信公众平台操作
# 1. 登录微信公众平台
# 2. 进入版本管理
# 3. 选择上一个稳定版本
# 4. 点击"回滚"
```

### 步骤 4: 数据库回滚（如需要）

**警告**: 数据库回滚可能导致数据丢失，仅在确认数据损坏时执行

```bash
# 1. 确认是否需要数据库回滚
# 查看数据库变更记录

# 2. 如果需要，从备份恢复
# 查找最近的备份
# rclone ls aliyun:postgres-backup/ | tail -10

# 3. 创建当前数据库备份（防止回滚失败）
# kubectl exec -n database postgres-0 -- pg_dump -U postgres sleep_platform > /tmp/backup-before-rollback.sql

# 4. 恢复到上一个版本
# 参考数据库恢复 Runbook
```

### 步骤 5: 配置回滚（如需要）

```bash
# 回滚 ConfigMap
kubectl rollout undo configmap/backend-config -n backend 2>/dev/null || \
kubectl apply -f https://github.com/sleep-monitor/config/raw/v1.0.0/backend-config.yaml

# 回滚 Secret（如需要，注意安全）
# 从 Vault 恢复上一个版本的密钥
```

### 步骤 6: 验证回滚（5分钟）

```bash
# 1. 所有 Pod 运行正常
kubectl get pods -n backend | grep -v Running
kubectl get pods -n frontend | grep -v Running

# 2. 镜像版本正确
kubectl get deployment backend-api -n backend -o jsonpath='{.spec.template.spec.containers[0].image}'

# 3. API 健康检查
curl -sf https://api.sleep-monitor.com/health

# 4. 错误率下降
# 查看 Grafana 面板

# 5. 业务指标恢复
# 查看设备在线数、数据摄入量等
```

## 回滚后操作

### 1. 监控（持续30分钟）

- 密切关注错误率、响应时间
- 关注设备在线数、数据摄入量
- 关注用户反馈

### 2. 记录故障

- 在故障管理系统中创建故障记录
- 记录回滚时间、版本、原因
- 收集相关日志和指标

### 3. 事后复盘

- 故障恢复后 48 小时内举行复盘会议
- 分析故障根本原因
- 制定改进措施
- 更新 Runbook

## 回滚失败处理

如果回滚后问题仍然存在：

1. **检查是否回滚到正确版本**
   ```bash
   kubectl get deployment backend-api -n backend -o jsonpath='{.spec.template.spec.containers[0].image}'
   ```

2. **检查是否有缓存问题**
   - 清除 CDN 缓存
   - 清除浏览器缓存
   - 重启相关服务

3. **检查数据库是否需要回滚**
   - 如果问题与数据相关，可能需要数据库回滚

4. **升级到工程经理和 CTO**
   - 如果回滚失败，立即升级
   - 考虑启用备用环境

## 注意事项

- 回滚操作需要值班主管或工程经理批准
- 数据库回滚需要 DBA 批准
- 回滚过程中不要进行其他变更
- 回滚后至少监控 30 分钟
- 记录所有操作步骤和时间点

## 相关 Runbook

- [API 5xx 故障](./api-5xx-outage.md)
- [PostgreSQL 主库宕机](./postgres-master-down.md)
- [Vault 服务中断](./vault-outage.md)
- [数据误删除](./data-accidental-delete.md)
