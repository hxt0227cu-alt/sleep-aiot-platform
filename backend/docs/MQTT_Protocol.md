# 智能睡眠仪台灯 - MQTT协议设计文档

## 一、MQTT协议概述

### 1.1 基本信息

| 项目 | 说明 |
|------|------|
| MQTT版本 | 3.1.1 |
| Broker | EMQX 5.x |
| 端口 | 8883 (TLS) / 1883 (非TLS) |
| QoS | 0/1/2 |
| 保留消息 | Retain: false |
| 心跳间隔 | 30秒 |
| 清理会话 | 300秒 |

### 1.2 主题结构

```
device/{device_id}/telemetry      # 设备遥测数据上报
device/{device_id}/status         # 设备状态上报
device/{device_id}/alarm          # 设备报警上报
device/{device_id}/log            # 设备日志上报
device/{device_id}/command        # 云端下发指令
device/{device_id}/config         # 云端下发配置
device/{device_id}/ota/command    # OTA升级指令
device/{device_id}/ota/progress   # OTA进度上报
```

---

## 二、设备上报主题

### 2.1 遥测数据上报

**主题**: `device/{device_id}/telemetry`

**消费所有权**：设备负责发布；`services/telemetry-ingest` 使用共享组 `telemetry-ingest` 消费并进入数据平台。NestJS backend 不订阅该主题。这是 ADR-013 的治理约定，broker 本身不会阻止其他客户端订阅。

**QoS**: 1

**Payload**:
```json
{
  "ts": 1704067200000,
  "type": "vital_signs",
  "data": {
    "heart_rate": {
      "value": 72,
      "unit": "bpm",
      "status": "normal"
    },
    "breathing_rate": {
      "value": 16,
      "unit": "times/min",
      "status": "normal"
    },
    "body_movement": {
      "value": 0.2,
      "unit": "g",
      "status": "low"
    },
    "sleep_state": {
      "state": "light_sleep",
      "confidence": 0.92
    }
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| ts | Integer | 时间戳（毫秒） |
| type | String | 数据类型：vital_signs, device_status |
| data | Object | 数据内容 |

**上报频率**: 10Hz (每100毫秒一次)

### 2.2 设备状态上报

**主题**: `device/{device_id}/status`

**QoS**: 1

**Payload**:
```json
{
  "ts": 1704067200000,
  "online": true,
  "wifi": {
    "ssid": "Home_WiFi",
    "signal_strength": -45,
    "ip_address": "192.168.1.100"
  },
  "system": {
    "uptime": 86400,
    "memory_usage": 65,
    "cpu_usage": 30,
    "free_heap": 245760
  },
  "firmware": {
    "version": "1.0.0",
    "build_date": "2024-01-01"
  }
}
```

**上报频率**: 60秒一次

### 2.3 报警上报

**主题**: `device/{device_id}/alarm`

**QoS**: 2

**Payload**:
```json
{
  "ts": 1704067200000,
  "alarm_id": "alarm_001",
  "type": "heart_rate_high",
  "level": "critical",
  "message": "心率异常偏高",
  "value": 125,
  "threshold": 120,
  "duration": 60
}
```

**报警类型**:

| 类型 | 级别 | 说明 |
|------|--------|------|
| heart_rate_high | critical | 心率过高 |
| heart_rate_low | critical | 心率过低 |
| breathing_rate_high | critical | 呼吸率过高 |
| breathing_rate_low | critical | 呼吸率过低 |
| no_movement | critical | 长时间无体动 |
| device_offline | warning | 设备离线离线 |
| low_battery | warning | 电量过低 |
| firmware_error | info | 固件错误 |

### 2.4 日志上报

**主题**: `device/{device_id}/log`

**QoS**: 0

**Payload**:
```json
{
  "ts": 1704067200000,
  "level": "error",
  "module": "radar_driver",
  "message": "UART通信超时",
  "code": "ERR_UART_TIMEOUT"
}
```

**日志级别**: `debug`, `info`, `warn`, `error`, `fatal`

---

## 三、云端下发主题

### 3.1 设备控制指令

**主题**: `device/{device_id}/command`

**QoS**: 1

**Payload**:
```json
{
  "cmd_id": "cmd_001",
  "command": "light_control",
  "params": {
    "power": true,
    "brightness": 80,
    "color_temp": 4000
  },
  "timeout": 5000
}
```

**支持的命令**:

| 命令 | 参数 | 说明 |
|------|------|------|
| light_control | power, brightness, color_temp | 灯光控制 |
| anion_control | power | 负离子控制 |
| voice_control | enabled, wakeup_word | 语音控制 |
| alarm_config | enabled, rules | 报警配置 |
| reboot | - | 重启设备 |
| factory_reset | - | 恢复出厂设置 |

**设备响应**:

设备执行命令后，需要向 `device/{device_id}/command/response` 主题发送响应：

```json
{
  "cmd_id": "cmd_001",
  "status": "success",
  "result": {
    "power": true,
    "brightness": 80,
    "color_temp": 4000
  },
  "error": null,
  "ts": 1704067200000
}
```

**响应状态**:

| 状态 | 说明 |
|------|------|
| success | 命令执行成功 |
| failed | 命令执行失败 |
| timeout | 命令执行超时 |
| rejected | 命令被拒绝 |

### 3.2 配置下发

**主题**: `device/{device_id}/config`

**QoS**: 1

**Payload**:
```json
{
  "config_id": "cfg_001",
  "type": "alarm_config",
  "data": {
    "rules": [
      {
        "type": "heart_rate_high",
        "enabled": true,
        "threshold": 120,
        "duration": 60,
        "actions": ["push", "sms", "call"]
      }
    ]
  }
}
```

**配置类型**:

| 类型 | 说明 |
|------|------|
| alarm_config | 报警配置 |
| light_config | 灯光配置 |
| voice_config | 语音配置 |
| network_config | 网络配置 |

### 3.3 OTA升级指令

**主题**: `device/{device_id}/ota/command`

**QoS**: 2

**Payload**:
```json
{
  "ota_id": "ota_001",
  "version": "1.1.0",
  "url": "https://cdn.sleep-lamp.com/firmware/v1.1.0.bin",
  "size": 1024000,
  "md5": "abc123def456...",
  "force": false
}
```

**OTA进度上报**:

设备在OTA过程中，向 `device/{device_id}/ota/progress` 主题上报进度：

```json
{
  "ota_id": "ota_001",
  "version": "1.1.0",
  "progress": 50,
  "status": "downloading",
  "message": "正在下载固件..."
}
```

**OTA状态**:

| 状态 | 说明 |
|------|------|
| checking | 检查更新 |
| downloading | 下载中 |
| verifying | 验证中 |
| flashing | 烧录中 |
| rebooting | 重启中 |
| success | 升级成功 |
| failed | 升级失败 |

---

## 四、MQTT安全规范

### 4.1 认证机制

| 认证方式 | 说明 |
|----------|------|
| Client ID | 设备ID，格式：`device:{device_id}` |
| Username | 设备ID |
| Password | 设备密钥（注册时下发） |
| TLS | 强制启用，使用证书认证 |

### 4.2 连接配置

```javascript
const mqttConfig = {
  clientId: 'device:lamp_001',
  username: 'lamp_001',
  password: 'device_secret_key_xxx',
  clean: true,
  connectTimeout: 10000,
  reconnectPeriod: 5000,
  keepalive: 30,
  qos: 1,
  rejectUnauthorized: true,
  forceSSL: true,
  ca: '/path/to/ca.crt',
  cert: '/path/to/client.crt',
  key: '/path/to/client.key'
}
```

### 4.3 消息加密

敏感数据（如设备密钥、配置信息）传输时使用AES-256加密：

```javascript
const encryptedData = encryptAES256(JSON.stringify(payload), deviceSecret);
```

---

## 五、消息流程图

### 5.1 设备上线流程

```
设备启动
  │
  ├─> 连接MQTT Broker
  │     └─> 认证成功
  │
  ├─> 订阅命令主题
  │     ├─> device/{device_id}/command
  │     ├─> device/{device_id}/config
  │     └─> device/{device_id}/ota/command
  │
  ├─> 上报设备状态
  │     └─> device/{device_id}/status
  │
  └─> 开始遥测数据上报
        └─> device/{device_id}/telemetry (10Hz)
```

### 5.2 指令下发流程

```
小程序/后端
  │
  ├─> 发布命令到 device/{device_id}/command
  │     └─> QoS 1, 等待响应
  │
  └─> 设备接收命令
        │
        ├─> 解析命令
        ├─> 执行命令
        └─> 发送响应到 device/{device_id}/command/response
              │
              └─> 后端接收响应
                    └─> 更新设备状态
```

### 5.3 OTA升级流程

```
后端
  │
  ├─> 检查固件更新
  │     └─> 有新版本
  │
  ├─> 发布OTA指令到 device/{device_id}/ota/command
  │     └─> QoS 2, 确保送达
  │
  └─> 设备接收OTA指令
        │
        ├─> 下载固件
        │     └─> 上报进度 (device/{device_id}/ota/progress)
        │
        ├─> 验证固件
        │     └─> 上报进度
        │
        ├─> 烧录固件
        │     └─> 上报进度
        │
        └─> 重启设备
              └─> 重新连接MQTT
                    └─> 上报新版本
```

---

## 六、错误处理

### 6.1 连接错误

| 错误类型 | 处理策略 |
||----------|----------|
| 认证失败 | 记录日志，停止重连，等待人工介入 |
| 网络断开 | 指数退避重连，间隔：5s, 10s, 30s, 60s |
| Broker不可达 | 切换备用服务器（如有） |
| TLS证书过期 | 重新获取证书，重新连接 |

### 6.2 消息错误

| 错误类型 | 处理策略 |
|----------|----------|
| Payload格式错误 | 记录日志，发送错误响应 |
| 命令不支持 | 记录日志，发送拒绝响应 |
| 参数验证失败 | 记录日志，发送错误响应 |
| 执行超时 | 记录日志，发送超时响应 |

### 6.3 重连策略

```javascript
const reconnectStrategy = {
  initialDelay: 5000,
  maxDelay: 60000,
  multiplier: 1.5,
  maxRetries: 10,
  onConnectFailure: (retryCount) => {
    const delay = Math.min(
      initialDelay * Math.pow(multiplier, retryCount),
      maxDelay
    );
    return delay;
  }
};
```

---

## 七、性能优化

### 7.1 消息批处理

遥测数据采用批处理，减少消息数量：

```javascript
const telemetryBatch = [];
const BATCH_SIZE = 10;
const BATCH_INTERVAL = 1000;

setInterval(() => {
  if (telemetryBatch.length > 0) {
    mqttClient.publish(`device/${deviceId}/telemetry`, 
      JSON.stringify(telemetryBatch),
      { qos: 1 }
    );
    telemetryBatch.length = 0;
  }
}, BATCH_INTERVAL);
```

### 7.2 QoS策略

| 消息类型 | QoS | 说明 |
|----------|-----|------|
| 遥测数据 | 0 | 允许丢失，减少延迟 |
| 设备状态 | 1 | 确保送达 |
| 报警消息 | 2 | 必须送达 |
| 控制指令 | 1 | 确保送达 |
| OTA指令 | 2 | 必须送达 |

### 7.3 主题订阅优化

使用通配符订阅，减少订阅数量：

```javascript
mqttClient.subscribe(`device/${deviceId}/#`, { qos: 1 });
```

---

## 八、测试用例

### 8.1 设备上报测试

```bash
# 测试遥测数据上报
mosquit_pub -h mqtt.sleep-lamp.com \
  -p 888335 \
  -t "device/lamp_001/telemetry" \
  -m '{"ts":1704067200000,"type":"vital_signs","data":{"heart_rate":{"value":72,"unit":"bpm"}}}' \
  -q 1 \
  -u "lamp_001" \
  -P "device_secret_key_xxx"
```

### 8.2 云端下发测试

```bash
# 测试控制指令下发
mosquit_pub -h mqtt.sleep-lamp.com \
  -p 888335 \
  -t "device/lamp_001/command" \
  -m '{"cmd_id":"cmd_001","command":"light_control","params":{"power":true,"brightness":80}}' \
  -q 1
```

---

## 九、附录

### 9.1 主题命名规范

| 规范 | 说明 | 示例 |
|------|------|------|
| 使用小写 | 主题名称使用小写 | `device/lamp_001/telemetry` |
| 使用斜杠 | 分隔符使用斜杠 | `device/{device_id}/command` |
| 避免特殊字符 | 不使用 `+`, `#`, `*` 在主题中 | - |
| 设备ID格式 | 使用字母、数字、下划线 | `lamp_001`, `device_123` |

### 9.2 Payload大小限制

| 消息类型 | 最大大小 | 说明 |
|----------|----------|------|
| 遥测数据 | 1KB | 单次上报数据量 |
| 设备状态 | 2KB | 完整状态信息 |
| 报警消息 | 512B | 报警详情 |
| 控制指令 | 1KB | 命令和参数 |
| OTA指令 | 512B | OTA元数据 |

### 9.3 常用错误码

| 错误码 | 说明 |
|--------|------|
| ERR_INVALID_PAYLOAD | Payload格式错误 |
| ERR_UNSUPPORTED_CMD | 不支持的命令 |
| ERR_INVALID_PARAMS | 参数验证失败 |
| ERR_TIMEOUT | 执行超时 |
| ERR_DEVICE_BUSY | 设备忙碌 |
| ERR_NOT_IMPLEMENTED | 功能未实现 |
