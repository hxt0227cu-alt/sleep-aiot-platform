# Vault 灾难恢复 Playbook

## 概述

本文档定义 HashiCorp Vault 服务的灾难恢复流程，包括数据恢复、密钥轮换、服务重建等。

## Vault 架构

- **部署模式**: 3 副本 HA 集群（Raft 存储）
- **解封模式**: 手动解封（3/5 密钥分片）
- **数据备份**: 每 6 小时自动快照，存储到对象存储
- **主密钥保护**: 阿里云 KMS（自动解封备选方案）

## 灾难场景

### 场景 1: Vault 单节点故障

**现象**: 一个 Vault Pod 崩溃或不可用

**影响**: 无影响（HA 集群，其他节点继续服务）

**恢复步骤**:
1. 确认故障节点状态
   ```bash
   kubectl get pods -n vault -o wide
   kubectl describe pod -n vault vault-2
   ```
2. 查看故障原因
   ```bash
   kubectl logs -n vault vault-2 --previous
   ```
3. 等待自动恢复（Kubernetes 会自动重启 Pod）
   ```bash
   kubectl rollout status statefulset/vault -n vault
   ```
4. 如果 Pod 持续 CrashLoopBackOff，手动删除重建
   ```bash
   kubectl delete pod -n vault vault-2
   ```
5. 验证集群状态
   ```bash
   kubectl exec -n vault vault-0 -- vault status
   kubectl exec -n vault vault-0 -- vault operator raft list-peers
   ```

### 场景 2: Vault 被密封（Sealed）

**现象**: 所有 Vault 节点重启后被密封，应用无法获取密钥

**影响**: 严重 - 所有依赖 Vault 的服务无法启动或运行

**恢复步骤**:

1. **确认密封状态**（2分钟）
   ```bash
   kubectl exec -n vault vault-0 -- vault status
   # 确认 Sealed: true
   ```

2. **准备解封密钥**（5分钟）
   - 联系密钥持有人（至少 3 人）
   - 确认解封密钥分片可用
   - 准备安全的操作环境

3. **执行解封**（10分钟）
   ```bash
   # 在每个节点上执行解封（需要 3/5 密钥分片）
   kubectl exec -n vault vault-0 -- vault operator unseal <key-1>
   kubectl exec -n vault vault-0 -- vault operator unseal <key-2>
   kubectl exec -n vault vault-0 -- vault operator unseal <key-3>

   # 对其他节点重复
   kubectl exec -n vault vault-1 -- vault operator unseal <key-1>
   # ...

   kubectl exec -n vault vault-2 -- vault operator unseal <key-1>
   # ...
   ```

4. **验证解封成功**（2分钟）
   ```bash
   kubectl exec -n vault vault-0 -- vault status
   # 确认 Sealed: false
   ```

5. **验证应用恢复**（5分钟）
   - 检查依赖 Vault 的服务是否恢复
   - 检查应用日志中的 Vault 相关错误
   - 重启仍有问题的 Pod

**预防措施**:
- 配置自动解封（使用 KMS 或云厂商 KMS）
- 解封密钥分片多人分别保管
- 定期演练解封流程

### 场景 3: Vault 数据损坏

**现象**: Vault 数据损坏，无法正常读取或写入

**影响**: 严重 - 所有密钥可能丢失

**恢复步骤**:

1. **确认数据损坏**（5分钟）
   ```bash
   kubectl exec -n vault vault-0 -- vault status
   kubectl logs -n vault vault-0 | grep -i error
   # 尝试读取密钥
   kubectl exec -n vault vault-0 -- vault kv get secret/backend/database
   ```

2. **查找最近的备份**（5分钟）
   ```bash
   # 列出备份文件
   rclone ls aliyun:vault-snapshots/ | tail -10
   # 或查看 PVC 中的备份
   kubectl exec -n vault vault-0 -- ls -la /vault/data/snapshots/
   ```

3. **从快照恢复**（30分钟）
   ```bash
   # 1. 下载最新快照
   kubectl cp /path/to/snapshot.snap vault/vault-0:/tmp/snapshot.snap

   # 2. 停止 Vault（如果还在运行）
   kubectl scale statefulset vault -n vault --replicas=0

   # 3. 清理损坏数据（保留备份）
   # 注意：这一步需要谨慎，确认备份可用后再执行

   # 4. 重新启动单节点
   kubectl scale statefulset vault -n vault --replicas=1

   # 5. 初始化并解封
   kubectl exec -n vault vault-0 -- vault operator init
   kubectl exec -n vault vault-0 -- vault operator unseal <key>

   # 6. 从快照恢复
   kubectl exec -n vault vault-0 -- vault operator raft snapshot restore /tmp/snapshot.snap

   # 7. 验证数据
   kubectl exec -n vault vault-0 -- vault login <root-token>
   kubectl exec -n vault vault-0 -- vault kv list secret/
   ```

4. **恢复集群**（15分钟）
   ```bash
   # 扩展到 3 副本
   kubectl scale statefulset vault -n vault --replicas=3

   # 等待节点加入集群
   kubectl exec -n vault vault-0 -- vault operator raft list-peers
   ```

5. **轮换密钥**（30分钟）
   - 数据损坏可能意味着密钥泄露，需要轮换所有密钥
   - 详见密钥轮换流程

6. **验证应用恢复**（10分钟）
   - 重启所有依赖 Vault 的服务
   - 验证服务正常运行

### 场景 4: Vault 整个集群不可用

**现象**: 所有 Vault 节点不可用，无法恢复

**影响**: 极严重 - 需要重建整个 Vault 服务

**恢复步骤**:

1. **启用降级模式**（10分钟）
   - 通知所有团队 Vault 不可用
   - 应用切换到降级模式（使用缓存的密钥或环境变量）
   - 暂停需要新密钥的操作

2. **重建 Vault 集群**（60分钟）
   ```bash
   # 1. 删除旧的 StatefulSet 和 PVC（确认备份可用后）
   kubectl delete statefulset vault -n vault
   kubectl delete pvc -n vault -l app=vault

   # 2. 重新部署 Vault
   kubectl apply -f platform/k8s/base/vault-ha-statefulset.yaml

   # 3. 等待 Pod 启动
   kubectl wait --for=condition=Ready pod/vault-0 -n vault --timeout=120s

   # 4. 初始化新集群
   kubectl exec -n vault vault-0 -- vault operator init -key-shares=5 -key-threshold=3

   # 5. 保存新的解封密钥和 Root Token（安全存储）

   # 6. 解封
   kubectl exec -n vault vault-0 -- vault operator unseal <new-key-1>
   # ...

   # 7. 从备份恢复数据（如果有）
   # 参考场景 3 的恢复步骤
   ```

3. **重新配置密钥**（60分钟）
   - 如果无法从备份恢复，需要重新创建所有密钥
   - 更新所有服务的密钥引用
   - 重启所有服务

4. **验证恢复**（30分钟）
   - 验证所有密钥可访问
   - 验证所有服务正常运行
   - 监控 24 小时

## 密钥轮换流程

当 Vault 数据损坏或可能泄露时，需要轮换所有密钥：

1. **生成新密钥**
   ```bash
   # JWT 签名密钥
   vault write -f transit/keys/jwt-signing-key/rotate

   # 数据库加密密钥
   vault write -f transit/keys/database-encryption-key/rotate
   ```

2. **配置双密钥过渡期**
   - 新密钥用于加密/签名
   - 旧密钥继续用于解密/验证
   - 过渡期：24-72 小时

3. **更新应用配置**
   - 更新所有服务使用新密钥
   - 滚动重启服务

4. **禁用旧密钥**
   - 确认所有服务已更新
   - 禁用旧密钥的加密/签名权限
   - 保留解密/验证权限 7 天

5. **销毁旧密钥**
   - 7 天后销毁旧密钥
   - 记录轮换审计日志

## 备份策略

| 备份类型 | 频率 | 保留期限 | 存储位置 |
|---------|------|---------|---------|
| Raft 快照 | 每 6 小时 | 30 天 | 对象存储（OSS） |
| 配置备份 | 每次变更 | 永久 | Git 仓库 |
| 解封密钥 | 初始化时 | 永久 | 离线安全存储（多人分片） |
| 审计日志 | 实时 | 5 年 | 独立审计系统 |

## 验证清单

恢复完成后，验证以下项目：

- [ ] Vault 集群状态正常（3 节点）
- [ ] Vault 已解封（Sealed: false）
- [ ] 所有密钥可正常读取
- [ ] 所有密钥可正常写入
- [ ] 动态密钥生成正常
- [ ] 审计日志正常记录
- [ ] 所有依赖 Vault 的服务正常运行
- [ ] 应用日志中无 Vault 相关错误
- [ ] 备份策略已恢复
- [ ] 解封密钥已安全存储

## 相关文档

- [Vault 服务中断 Runbook](../operations/runbooks/vault-outage.md)
- [灾难恢复 Playbook](./playbook.md)
- [RPO/RTO 定义](./rpo-rto-definition.md)
- [密钥管理架构](../security/key-management-architecture.md)
- [生产权限矩阵](../operations/production-permission-matrix.yaml)
