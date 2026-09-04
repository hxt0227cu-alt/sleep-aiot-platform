# Runbook: OTA 异常

## 概述

**故障类型**: 固件升级故障
**严重级别**: High (P2)
**响应时间**: 15分钟
**解决时间**: 4小时
**负责人**: IoT 团队 / 固件团队

## 故障现象

- 设备固件升级失败
- 升级后设备无法启动（变砖）
- 升级后设备功能异常
- 大量设备升级失败
- 升级进度卡住
- 设备升级后频繁重启

## 快速诊断步骤

### 1. 确认升级异常范围（5分钟）

```bash
# 查看 OTA 服务状态
kubectl get pods -n backend -l app=ota-service -o wide

# 查看 OTA 服务日志
kubectl logs -n backend -l app=ota-service --tail=100

# 查看升级统计
kubectl exec -n backend deploy/ota-service -- wget -qO- http://localhost:3000/api/v1/ota/stats

# 查看失败设备列表
kubectl exec -n backend deploy/ota-service -- wget -qO- http://localhost:3000/api/v1/ota/failed-devices
```

### 2. 检查固件包（10分钟）

```bash
# 检查固件包完整性
# 查看固件包大小
ls -lh firmware/build/sleep-monitor-*.bin

# 验证固件签名
python pki/firmware-sign-offline.py verify --firmware firmware/build/sleep-monitor-v1.0.0.bin --public-key pki/firmware-ca.pub

# 检查固件版本兼容性
# 查看固件支持的设备型号
# 查看固件最低硬件版本要求
```

### 3. 检查设备状态（10分钟）

```bash
# 查看失败设备的详细信息
kubectl exec -n backend deploy/ota-service -- wget -qO- http://localhost:3000/api/v1/ota/device/<device-id>/status

# 查看设备日志（如果设备还能连接）
# MQTT 日志
# 设备上报的错误信息

# 检查设备硬件版本
# 是否有特定型号设备失败
```

## 常见原因和解决方案

### 原因 1: 固件包损坏或签名错误

**症状**: 所有设备升级失败，验签失败

**解决方案**:
```bash
# 1. 确认固件包损坏
# 验证固件签名
python pki/firmware-sign-offline.py verify --firmware <firmware.bin> --public-key <pub.key>

# 2. 停止当前升级
kubectl exec -n backend deploy/ota-service -- wget -qO- --post-data='' http://localhost:3000/api/v1/ota/stop

# 3. 重新构建固件包
cd firmware
idf.py build

# 4. 重新签名固件
python pki/firmware-sign-offline.py sign --firmware build/sleep-monitor.bin --private-key <priv.key>

# 5. 上传新固件
# 上传到 OSS
# 更新 OTA 服务配置

# 6. 重新发起升级
kubectl exec -n backend deploy/ota-service -- wget -qO- --post-data='{"version":"v1.0.1"}' http://localhost:3000/api/v1/ota/start
```

### 原因 2: 设备存储空间不足

**症状**: 部分设备升级失败，提示存储空间不足

**解决方案**:
```bash
# 1. 确认存储空间问题
# 查看设备上报的错误信息
# 检查设备存储使用情况

# 2. 清理设备存储
# 触发设备清理旧固件
kubectl exec -n backend deploy/ota-service -- wget -qO- --post-data='{"action":"cleanup"}' http://localhost:3000/api/v1/ota/device/<device-id>/command

# 3. 提供更小的固件包
# 优化固件大小
# 移除不必要的功能

# 4. 分批升级
# 先升级有足够空间的设备
# 空间不足的设备先清理再升级
```

### 原因 3: 升级后设备无法启动（变砖）

**症状**: 设备升级后无法启动，无法连接网络

**解决方案**:
```bash
# 1. 确认变砖范围
# 统计无法连接的设备数量
# 检查是否集中在特定批次或型号

# 2. 立即停止升级
kubectl exec -n backend deploy/ota-service -- wget -qO- --post-data='' http://localhost:3000/api/v1/ota/stop

# 3. 启动回滚
# 触发设备回滚到上一个版本（如果支持 A/B 分区）
kubectl exec -n backend deploy/ota-service -- wget -qO- --post-data='{"action":"rollback"}' http://localhost:3000/api/v1/ota/device/<device-id>/command

# 4. 对于无法自动回滚的设备
# 指导用户手动恢复
# 提供 USB 烧录恢复方案
# 安排售后维修

# 5. 调查变砖原因
# 分析固件启动日志
# 检查硬件兼容性
# 检查升级过程是否中断
```

### 原因 4: 网络问题导致升级中断

**症状**: 升级进度卡住，设备频繁重试

**解决方案**:
```bash
# 1. 检查网络状态
# 查看设备网络信号强度
# 检查 OTA 服务带宽使用

# 2. 检查 OSS 访问
# 测试固件包下载速度
# 检查 CDN 状态

# 3. 优化升级策略
# 增加断点续传
# 降低并发升级数
# 增加重试次数和超时时间

# 4. 分批升级
# 按地区分批升级
# 避开网络高峰时段
```

### 原因 5: 固件兼容性问题

**症状**: 特定型号或批次设备升级后功能异常

**解决方案**:
```bash
# 1. 确认兼容性问题
# 检查失败设备的型号和硬件版本
# 查看固件兼容性配置

# 2. 停止对受影响设备的升级
# 更新 OTA 兼容性配置
# 排除受影响的设备型号

# 3. 回滚受影响设备
# 触发设备回滚

# 4. 修复固件兼容性
# 分析兼容性问题
# 修复固件
# 重新测试

# 5. 重新发布修复后的固件
```

## 升级回滚流程

### 自动回滚（A/B 分区）

```bash
# 1. 设备检测到新版本无法启动
# 2. 自动切换到 A 分区（旧版本）
# 3. 上报回滚状态
# 4. OTA 服务记录回滚
```

### 手动回滚

```bash
# 1. 触发设备回滚
kubectl exec -n backend deploy/ota-service -- wget -qO- \
  --post-data='{"device_id":"<device-id>","action":"rollback"}' \
  http://localhost:3000/api/v1/ota/rollback

# 2. 等待设备回滚完成
# 3. 验证设备恢复正常
# 4. 记录回滚结果
```

### 批量回滚

```bash
# 1. 批量触发回滚
kubectl exec -n backend deploy/ota-service -- wget -qO- \
  --post-data='{"version":"v1.0.0","action":"batch_rollback"}' \
  http://localhost:3000/api/v1/ota/batch-rollback

# 2. 监控回滚进度
# 3. 验证回滚结果
```

## 灰度升级策略

### 升级阶段

| 阶段 | 设备比例 | 持续时间 | 观察指标 |
|------|---------|---------|---------|
| 1 | 1% | 24小时 | 升级成功率、设备在线率 |
| 2 | 5% | 24小时 | 升级成功率、设备在线率、功能异常 |
| 3 | 20% | 48小时 | 升级成功率、设备在线率、用户反馈 |
| 4 | 50% | 48小时 | 升级成功率、设备在线率、用户反馈 |
| 5 | 100% | 持续 | 升级成功率、设备在线率 |

### 自动回滚条件

- 升级成功率 < 95%
- 设备在线率下降 > 5%
- 变砖设备 > 10台
- 用户投诉 > 5起/小时
- 关键功能异常

## 验证恢复

```bash
# 1. OTA 服务正常运行
kubectl get pods -n backend -l app=ota-service | grep -v Running

# 2. 升级成功率恢复正常
# 查看 OTA 统计面板

# 3. 设备在线率恢复正常
# 查看设备管理后台

# 4. 无新的升级失败
# 监控 OTA 服务日志

# 5. 用户反馈正常
# 查看用户投诉
```

## 升级条件

- 30分钟内无法定位升级失败原因
- 变砖设备超过 100 台
- 影响超过 1000 用户
- 涉及安全漏洞
- 需要召回设备

## 事后复盘要求

- 变砖设备超过 10 台：必须复盘
- 升级成功率 < 90%：必须复盘
- 影响超过 100 用户：必须复盘
- 分析升级失败根本原因
- 优化升级流程和测试
- 更新 Runbook

## 相关文档

- [MQTT 设备大规模离线](./mqtt-mass-offline.md)
- [全量回滚](./full-site-rollback.md)
- [API 5xx 故障](./api-5xx-outage.md)
- [固件签名工具](../../pki/firmware-sign-offline.py)
- [OTA 灰度策略](../../firmware/ota/ota-gray-strategy.yaml)
