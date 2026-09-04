# Runbook: 证书批量过期

## 概述

**故障类型**: 安全事件
**严重级别**: High (P2)
**响应时间**: 15分钟
**解决时间**: 4小时
**负责人**: 安全团队 / 运维人员

## 故障现象

- 大量设备证书即将过期
- 设备无法连接服务（TLS 握手失败）
- 证书过期告警触发
- 设备大规模离线
- API 返回证书相关错误

## 快速诊断步骤

### 1. 确认证书过期范围（5分钟）

```bash
# 查看即将过期的证书列表
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/certs/expiring?days=30

# 查看证书统计
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/stats

# 查看设备连接失败率
# Grafana 面板: MQTT Connection Failures
kubectl logs -n iot emqx-0 --tail=100 | grep -i "certificate\|ssl\|tls" | tail -20
```

### 2. 检查证书颁发服务（10分钟）

```bash
# 查看 PKI 服务状态
kubectl get pods -n backend -l app=pki-service

# 查看 PKI 服务日志
kubectl logs -n backend -l app=pki-service --tail=100

# 检查 CA 证书状态
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/ca/status

# 检查 CRL 状态
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/crl/status
```

## 常见原因和解决方案

### 原因 1: 证书自动续期失败

**症状**: 证书到期前未自动续期，大量证书即将过期

**解决方案**:
```bash
# 1. 确认自动续期服务状态
kubectl get pods -n backend -l app=cert-rotator

# 2. 查看续期服务日志
kubectl logs -n backend -l app=cert-rotator --tail=100

# 3. 手动触发批量续期
kubectl exec -n backend deploy/pki-service -- wget -qO- --post-data='{"days":30}' http://localhost:3000/api/v1/pki/certs/renew-batch

# 4. 监控续期进度
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/certs/renew-status

# 5. 验证新证书
# 检查设备是否使用新证书连接
```

### 原因 2: CA 证书过期

**症状**: 中间 CA 证书过期，所有设备证书验证失败

**解决方案**:
```bash
# 1. 确认 CA 证书状态
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/ca/status

# 2. 如果中间 CA 即将过期，签发新的中间 CA
# 参考 pki/device-csr-sign.py

# 3. 更新服务端信任的 CA 证书链
# 更新 EMQX 配置
kubectl set env statefulset/emqx -n iot EMQX_LISTENERS__SSL__DEFAULT__CACERTFILE=/path/to/new-ca.crt

# 4. 滚动重启服务
kubectl rollout restart statefulset/emqx -n iot
kubectl rollout restart deployment/backend-api -n backend

# 5. 触发设备证书更新
# 通过 MQTT 通知设备更新证书
kubectl exec -n iot emqx-0 -- emqx_ctl pub publish -t '$SYS/pki/cert-update' -p '{"ca_updated":true}' -q 2
```

### 原因 3: 设备无法获取新证书

**症状**: 证书续期成功，但设备未下载新证书

**解决方案**:
```bash
# 1. 检查设备证书更新状态
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/certs/update-status

# 2. 检查设备网络连接
# 查看设备在线率
kubectl exec -n iot emqx-0 -- emqx_ctl stats | grep connections

# 3. 通过 MQTT 主动通知设备更新证书
kubectl exec -n iot emqx-0 -- emqx_ctl pub publish \
  -t 'device/+/cert/update' \
  -p '{"action":"renew","url":"https://api.sleep-monitor.com/api/v1/pki/cert/renew"}' \
  -q 2

# 4. 对于离线设备，等待上线后自动更新
# 设备启动时会检查证书有效期并自动续期

# 5. 对于无法自动更新的设备，指导用户手动更新
# 提供手动更新指引
```

### 原因 4: 证书吊销列表（CRL）过期

**症状**: CRL 过期，设备无法验证证书状态

**解决方案**:
```bash
# 1. 检查 CRL 状态
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/crl/status

# 2. 手动生成新的 CRL
python pki/crl-generator.py \
  --ca-cert pki/device-ca.crt \
  --ca-key pki/device-ca.key \
  --output crl/device-ca.crl \
  --validity-days 7

# 3. 上传新 CRL 到 CDN
# rclone copy crl/device-ca.crl aliyun:cdn-crl/

# 4. 刷新 CDN 缓存
# 阿里云 CDN 刷新接口

# 5. 通过 MQTT 通知设备更新 CRL
kubectl exec -n iot emqx-0 -- emqx_ctl pub publish \
  -t '$SYS/pki/crl/update' \
  -p '{"crl_url":"https://crl.sleep-monitor.com/device-ca.crl"}' \
  -q 1
```

### 原因 5: 服务端 TLS 证书过期

**症状**: API 服务 TLS 证书过期，客户端无法连接

**解决方案**:
```bash
# 1. 检查服务端证书状态
echo | openssl s_client -connect api.sleep-monitor.com:443 -servername api.sleep-monitor.com 2>/dev/null | openssl x509 -noout -dates

# 2. 如果证书即将过期，申请新证书
# 使用 cert-manager 自动续期（如果已配置）
kubectl get certificate -n backend

# 3. 手动更新证书
# 从证书颁发机构获取新证书
# 更新 Kubernetes Secret
kubectl create secret tls api-tls --cert=new-cert.crt --key=new-cert.key -n backend --dry-run=client -o yaml | kubectl apply -f -

# 4. 滚动重启服务
kubectl rollout restart deployment/backend-api -n backend

# 5. 验证证书更新
echo | openssl s_client -connect api.sleep-monitor.com:443 -servername api.sleep-monitor.com 2>/dev/null | openssl x509 -noout -dates
```

## 批量证书续期流程

### 步骤 1: 准备

```bash
# 1. 确认 CA 证书有效
# 2. 确认 PKI 服务正常运行
# 3. 备份当前证书
# 4. 通知相关团队
```

### 步骤 2: 批量续期

```bash
# 1. 触发批量续期
kubectl exec -n backend deploy/pki-service -- wget -qO- \
  --post-data='{"days":30,"batch_size":1000}' \
  http://localhost:3000/api/v1/pki/certs/renew-batch

# 2. 监控续期进度
while true; do
  status=$(kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/certs/renew-status)
  echo "$status"
  if echo "$status" | grep -q "completed"; then
    break
  fi
  sleep 60
done

# 3. 验证续期结果
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/certs/expiring?days=30
```

### 步骤 3: 设备更新

```bash
# 1. 通知在线设备更新证书
kubectl exec -n iot emqx-0 -- emqx_ctl pub publish \
  -t '$SYS/pki/cert/update' \
  -p '{"action":"renew-all","reason":"batch_renewal"}' \
  -q 2

# 2. 等待设备更新
# 监控设备证书更新率

# 3. 对于离线设备，等待上线后自动更新
```

## 证书过期预防

### 监控告警

```yaml
# 证书过期告警
alerts:
  - name: "CertificateExpiring30Days"
    expr: 'x509_cert_not_after - time() < 86400 * 30'
    for: 1h
    labels:
      severity: medium
    annotations:
      summary: "证书将在30天内过期"

  - name: "CertificateExpiring7Days"
    expr: 'x509_cert_not_after - time() < 86400 * 7'
    for: 1h
    labels:
      severity: high
    annotations:
      summary: "证书将在7天内过期"

  - name: "CertificateExpired"
    expr: 'x509_cert_not_after - time() < 0'
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "证书已过期"
```

### 自动续期

```yaml
# cert-manager 自动续期配置
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls
spec:
  secretName: api-tls
  duration: 2160h # 90天
  renewBefore: 360h # 15天
  dnsNames:
    - api.sleep-monitor.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

## 验证恢复

```bash
# 1. 证书过期数量下降
kubectl exec -n backend deploy/pki-service -- wget -qO- http://localhost:3000/api/v1/pki/certs/expiring?days=30

# 2. 设备连接恢复正常
# 查看 MQTT 连接数
kubectl exec -n iot emqx-0 -- emqx_ctl stats | grep connections

# 3. 无证书相关错误
kubectl logs -n iot emqx-0 --tail=50 | grep -i "certificate\|ssl\|tls" | grep -i error

# 4. API 服务证书有效
echo | openssl s_client -connect api.sleep-monitor.com:443 -servername api.sleep-monitor.com 2>/dev/null | openssl x509 -noout -dates
```

## 升级条件

- 证书已过期且影响超过 100 设备
- 30分钟内无法完成批量续期
- CA 证书过期
- 涉及安全漏洞
- 需要手动更新大量设备

## 事后复盘要求

- 证书过期影响超过 100 设备：必须复盘
- CA 证书过期：必须复盘
- 自动续期失败：必须复盘
- 分析证书过期根本原因
- 优化证书监控和自动续期
- 更新 Runbook

## 相关文档

- [CRL 操作策略](../security/crl-operation-policy.md)
- [密钥管理架构](../security/key-management-architecture.md)
- [MQTT 设备大规模离线](./mqtt-mass-offline.md)
- [密钥泄露响应](./key-leak-response.md)
- [设备证书签发工具](../../pki/device-csr-sign.py)
- [CRL 生成工具](../../pki/crl-generator.py)
