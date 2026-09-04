# CRL 操作策略

## 概述

本文档定义证书吊销列表（CRL）的生成、分发、校验和应急操作策略。

## CRL 类型

| CRL 类型 | 签发 CA | 发布频率 | 有效期 | 分发方式 |
|---------|--------|---------|--------|---------|
| 根 CA CRL | Root CA | 不发布 | - | 根 CA 极少吊销 |
| 中间 CA CRL | Intermediate CA | 每周 | 30天 | CDN + OTA |
| 设备 CA CRL | Device CA | 每日 | 7天 | CDN + OTA + MQTT |
| 服务端 CA CRL | Server CA | 每周 | 7天 | CDN |
| 固件 CA CRL | Firmware CA | 每月 | 365天 | CDN |

## CRL 生成流程

### 1. 常规生成（每日）

```bash
# 1. 收集待吊销证书列表
# 从证书管理系统获取待吊销证书

# 2. 生成 CRL
python pki/crl-generator.py \
  --ca-cert pki/device-ca.crt \
  --ca-key pki/device-ca.key \
  --revoked revoked-list.json \
  --output crl/device-ca.crl \
  --crl-number $(date +%Y%m%d001) \
  --validity-days 7

# 3. 上传到 CDN
# rclone copy crl/device-ca.crl aliyun:cdn-crl/

# 4. 通知设备更新
# 通过 MQTT 广播 CRL 更新消息
```

### 2. 紧急吊销（安全事件）

```bash
# 1. 立即生成 CRL（不等待常规周期）
python pki/crl-generator.py --emergency ...

# 2. 立即上传到 CDN 并刷新缓存
# 阿里云 CDN 刷新接口

# 3. 通过 MQTT 立即推送 CRL 更新
# 所有设备收到后立即拉取新 CRL

# 4. 通知所有相关团队
# 飞书紧急群通知
```

### 3. CRL 内容

```
CRL 版本: v2
签发者: Sleep Monitor Device CA
签名算法: ECDSA-SHA256
本次更新: 2026-08-20 02:00:00 UTC
下次更新: 2026-08-27 02:00:00 UTC
CRL 编号: 20260820001

吊销证书列表:
  序列号: 1234567890
    吊销日期: 2026-08-19 10:30:00 UTC
    吊销原因: keyCompromise (密钥泄露)
    设备ID: DEV-20260101001

  序列号: 1234567891
    吊销日期: 2026-08-18 15:20:00 UTC
    吊销原因: cessationOfOperation (停止运营)
    设备ID: DEV-20260101002
```

## CRL 分发策略

### 分发渠道

| 渠道 | 更新延迟 | 适用场景 | 覆盖率 |
|------|---------|---------|--------|
| CDN | < 5分钟 | 设备主动拉取 | 99% |
| OTA 推送 | < 1小时 | 固件更新时附带 | 95% |
| MQTT 广播 | < 1分钟 | 在线设备即时通知 | 80%（在线设备） |
| 设备缓存 | 即时 | 离线设备使用缓存 | 100%（有缓存） |

### CDN 配置

```yaml
# CRL CDN 配置
crl_cdn:
  domain: "crl.sleep-monitor.com"
  cache_ttl: 3600  # 1小时
  refresh_on_update: true  # CRL 更新时自动刷新缓存
  https_only: true
  access_control: public  # CRL 公开可访问
```

### MQTT 通知

```
Topic: $SYS/pki/crl/update
Payload:
{
  "crl_type": "device-ca",
  "crl_number": "20260820001",
  "crl_url": "https://crl.sleep-monitor.com/device-ca.crl",
  "issued_at": "2026-08-20T02:00:00Z",
  "next_update": "2026-08-27T02:00:00Z",
  "reason": "regular_update"  # regular_update / emergency
}
QoS: 1 (至少一次)
Retained: true (新连接设备也能收到)
```

## 设备端 CRL 校验

### 校验分级策略

| 模式 | 吊销证书处理 | CRL 过期处理 | CRL 不可用处理 | 适用场景 |
|------|------------|------------|--------------|---------|
| 严格模式 | 拒绝连接 | 拒绝连接 | 使用缓存 + 告警 | 量产设备 |
| 宽松模式 | 允许 + 告警 | 允许 + 告警 | 使用缓存 + 告警 | 内部测试 |
| 仅警告 | 记录日志 | 记录日志 | 记录日志 | 开发设备 |

### 设备端流程

```
1. 设备启动时
   - 从 NVS 读取缓存的 CRL
   - 检查 CRL 是否过期
   - 如过期，尝试在线拉取新 CRL

2. TLS 握手时
   - 验证服务端证书链
   - 检查证书是否在 CRL 中
   - 如在 CRL 中，根据校验模式处理

3. 定期更新
   - 每24小时检查 CRL 更新
   - 收到 MQTT 通知时立即更新
   - 更新失败时使用缓存并记录告警

4. 离线处理
   - 离线时使用缓存的 CRL
   - 缓存有效期 72小时（宽限期）
   - 超过72小时未更新，记录严重告警
```

### CRL 缓存管理

```
存储位置: NVS 加密分区
最大大小: 64KB
缓存有效期: 72小时（宽限期）
更新策略:
  - 常规: 每24小时检查更新
  - 紧急: 收到 MQTT 通知立即更新
  - 启动时: 检查缓存有效性
失败重试:
  - 间隔: 1分钟, 5分钟, 15分钟, 1小时
  - 最大重试: 10次/天
```

## CRL 应急操作

### 场景 1: 大规模设备密钥泄露

**操作步骤**:
1. 确认密钥泄露范围和影响
2. 立即生成紧急 CRL，吊销所有受影响设备证书
3. 立即上传 CRL 并刷新 CDN 缓存
4. 通过 MQTT 紧急广播 CRL 更新（QoS=2）
5. 通知所有在线设备立即拉取新 CRL
6. 对离线设备，等待上线后自动更新
7. 评估是否需要批量更新设备证书
8. 记录事件并进行事后复盘

**时间要求**:
- CRL 生成: < 10分钟
- CDN 更新: < 5分钟
- MQTT 广播: < 1分钟
- 在线设备更新: < 30分钟
- 全量设备更新: < 24小时

### 场景 2: CRL 服务不可用

**操作步骤**:
1. 确认 CRL 服务故障范围（CDN/源站/数据库）
2. 启用备用 CRL 分发渠道
3. 通知设备使用缓存 CRL
4. 延长 CRL 缓存有效期（临时）
5. 修复 CRL 服务
6. 恢复正常 CRL 更新流程
7. 记录事件

**设备端处理**:
- CRL 不可用时使用缓存
- 缓存有效期临时延长到 7天
- 记录告警但不拒绝连接（宽松模式）

### 场景 3: CRL 签名密钥泄露

**操作步骤**:
1. 立即确认密钥泄露
2. 紧急轮换 CRL 签名密钥
3. 使用新密钥生成 CRL
4. 通知所有设备更新信任的 CA 证书
5. 通过 OTA 更新设备端 CA 证书
6. 吊销旧密钥签发的所有 CRL
7. 记录事件并进行安全复盘

**时间要求**:
- 密钥轮换: < 1小时
- 新 CRL 发布: < 2小时
- 设备更新: < 72小时

## CRL 监控和告警

### 监控指标

| 指标 | 阈值 | 告警级别 | 说明 |
|------|------|---------|------|
| CRL 生成失败 | > 0 | Critical | CRL 生成任务失败 |
| CRL 过期 | > 0 | Critical | CRL 已过期未更新 |
| CRL 下载失败率 | > 5% | High | 设备下载 CRL 失败率过高 |
| CRL 更新延迟 | > 1小时 | Medium | CRL 更新延迟超过预期 |
| 吊销证书数突增 | > 100/小时 | High | 短时间内大量证书被吊销 |
| 设备 CRL 缓存过期率 | > 10% | High | 超过10%设备 CRL 缓存过期 |

### 告警通知

- **Critical**: PagerDuty + 飞书紧急 + 电话
- **High**: PagerDuty + 飞书
- **Medium**: 飞书
- **Low**: 邮件

## CRL 审计

### 审计日志内容

- CRL 生成时间
- CRL 编号
- 签发 CA
- 吊销证书数量
- 吊销原因分布
- 操作人
- 签名验证结果

### 审计日志存储

- 存储位置: 独立审计日志系统
- 保留期限: 5年
- 完整性: 哈希链
- 访问控制: 仅审计员

### 定期审计

- 每日: CRL 生成和分发检查
- 每周: 吊销证书原因分析
- 每月: CRL 覆盖率和更新率统计
- 每季度: CRL 流程有效性评估

## 相关文档

- [CA 层级架构](../../pki/ca-hierarchy-architecture.md)
- [CRL 策略](../../pki/crl-policy.yaml)
- [密钥管理架构](./key-management-architecture.md)
- [托管服务路线图](./managed-service-roadmap.md)
- [设备证书生命周期](../../backend/src/device/device-cert.service.ts)
