# Runbook: Vault 服务中断

## 概述

**故障类型**: 安全服务故障
**严重级别**: Critical (P1)
**响应时间**: 5分钟
**解决时间**: 30分钟
**负责人**: 安全团队 / 值班人员

## 故障现象

- 应用启动失败，无法获取密钥
- API 返回 500 错误，日志中 `Vault connection refused`
- 新 Pod 无法启动（依赖 Vault 注入密钥）
- 监控告警 `VaultDown` 触发

## 快速诊断步骤

### 1. 确认 Vault 状态（2分钟）

```bash
# 查看 Vault Pod 状态
kubectl get pods -n vault -o wide

# 查看 Vault 服务状态
kubectl get svc -n vault

# 查看 Vault Pod 日志
kubectl logs -n vault -l app=vault --tail=100

# 检查 Vault 健康状态
kubectl exec -n vault vault-0 -- wget -qO- http://127.0.0.1:8200/v1/sys/health 2>&1
```

### 2. 检查 Vault 密封状态（2分钟）

```bash
# 检查是否被密封
kubectl exec -n vault vault-0 -- vault status

# 常见状态:
# - Sealed: true  -> 需要解封
# - Sealed: false -> 正常运行
# - Initialized: false -> 需要初始化
```

### 3. 检查存储和资源（1分钟）

```bash
# 查看 Vault Pod 资源
kubectl top pods -n vault

# 查看存储使用
kubectl exec -n vault vault-0 -- df -h /vault/data

# 查看事件
kubectl get events -n vault --sort-by=.lastTimestamp | tail -20
```

## 解决方案

### 方案 1: Vault 被密封（Sealed）

**适用场景**: Vault 重启后被密封，需要手动解封

**步骤**:
```bash
# 1. 确认密封状态
kubectl exec -n vault vault-0 -- vault status

# 2. 使用解封密钥解封（需要 3/5 密钥分片）
# 注意：解封密钥应安全存储，多人分别持有
kubectl exec -n vault vault-0 -- vault operator unseal <unseal-key-1>
kubectl exec -n vault vault-0 -- vault operator unseal <unseal-key-2>
kubectl exec -n vault vault-0 -- vault operator unseal <unseal-key-3>

# 3. 验证解封成功
kubectl exec -n vault vault-0 -- vault status
# Sealed 应为 false

# 4. 如果是 HA 集群，其他节点也需要解封
kubectl exec -n vault vault-1 -- vault operator unseal <unseal-key-1>
# ...

# 5. 验证应用恢复
kubectl get pods -n backend | grep -v Running
```

### 方案 2: Vault Pod 崩溃

**适用场景**: Pod 崩溃或 OOM

**步骤**:
```bash
# 1. 查看崩溃原因
kubectl describe pod -n vault vault-0 | grep -A10 "Last State"

# 2. 如果是 OOM，临时增加内存
kubectl set resources statefulset vault -n vault --limits=memory=4Gi --requests=memory=2Gi

# 3. 等待 Pod 重启
kubectl rollout status statefulset/vault -n vault

# 4. 解封 Vault（参考方案 1）
```

### 方案 3: Vault 存储损坏

**适用场景**: Raft 存储损坏，无法启动

**步骤**:
```bash
# 1. 确认存储损坏
kubectl logs -n vault vault-0 | grep -i "error" | tail -20

# 2. 从快照恢复
# 查找最近的快照
# rclone ls aliyun:vault-snapshots/ | tail -10

# 3. 下载快照到 Pod
kubectl cp /path/to/snapshot.snap vault/vault-0:/tmp/snapshot.snap

# 4. 恢复快照
kubectl exec -n vault vault-0 -- vault operator raft snapshot restore /tmp/snapshot.snap

# 5. 解封 Vault
# 参考方案 1

# 6. 验证数据完整性
kubectl exec -n vault vault-0 -- vault kv list secret/
```

### 方案 4: 临时降级（Vault 完全不可用）

**适用场景**: Vault 短时间内无法恢复，需要让应用继续运行

**步骤**:
```bash
# 1. 启用应用的降级模式（使用环境变量或本地缓存的密钥）
kubectl set env deployment/backend-api -n backend VAULT_FALLBACK_MODE=true

# 2. 滚动重启应用
kubectl rollout restart deployment/backend-api -n backend

# 3. 注意：降级模式下密钥可能不是最新的
# 恢复后需要关闭降级模式
```

## 验证恢复

```bash
# 1. Vault 状态正常
kubectl exec -n vault vault-0 -- vault status
# Sealed: false, Initialized: true

# 2. 密钥可读取
kubectl exec -n vault vault-0 -- vault kv get secret/backend/database

# 3. 应用可正常启动
kubectl get pods -n backend | grep -v Running
# 应为空

# 4. 无新的 Vault 相关错误
kubectl logs -n backend -l app=backend-api --tail=50 | grep -i vault | grep -i error
```

## 升级条件

- 15分钟内无法解封 Vault
- 存储损坏需要从备份恢复
- 解封密钥不可用
- 多个 Vault 节点同时故障
- 涉及安全事件

## 安全注意事项

- 解封密钥必须多人分别持有，禁止单人持有全部密钥
- 解封操作需要双人在场
- 解封过程需要记录审计日志
- 禁止将解封密钥存储在 Vault 自身中

## 事后复盘要求

- 必须进行事后复盘
- 分析 Vault 密封/崩溃的根本原因
- 评估是否需要调整解封密钥分片策略
- 检查是否需要增加自动解封机制（仅限开发环境）

## 相关 Runbook

- [密钥泄露响应](./key-leak-response.md)
- [API 5xx 故障](./api-5xx-outage.md)
- [全量回滚](./full-site-rollback.md)
