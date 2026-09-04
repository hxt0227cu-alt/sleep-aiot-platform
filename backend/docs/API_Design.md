# 智能睡眠仪台灯 - API设计文档

## 一、API概述

> 当前路由事实以 `backend/src/**/*.controller.ts` 为准。本文件的端点示例并非完整清单；Swagger/OpenAPI 自动生成尚未接入，新增接口不得仅通过手工修改本文件宣称完成。

### 1.1 基本信息

| 项目 | 说明 |
|------|------|
| URI 版本策略 | 当前不使用 URI 版本号 |
| 基础URL | `https://<your-domain>/api` |
| 认证方式 | JWT Bearer Token |
| 数据格式 | JSON |
| 字符编码 | UTF-8 |

### 1.2 通用响应格式

```json
{
  "code": 200,
  "message": "success",
  "data": {},
  "timestamp": 1704067200000
}
```

### 1.3 错误码定义

| 错误码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未授权 |
| 403 | 禁止访问 |
| 404 | 资源不存在 |
| 429 | 请求过于频繁 |
| 500 | 服务器内部错误 |
| 1001 | 设备未绑定 |
| 1002 | 设备离线 |
| 1003 | 设备指令执行失败 |
| 1004 | 数据查询超时 |

---

## 二、用户认证API

### 2.1 用户注册

**接口**: `POST /auth/register`

**请求参数**:
```json
{
  "phone": "13800138000",
  "password": "<user-password>",
  "nickname": "张三",
  "wechat_openid": "oxxxxxx"
}
```

**响应示例**:
```json
{
  "code": 200,
  "message": "注册成功",
  "data": {
    "user_id": "user_001",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 7200
  }
}
```

### 2.2 用户登录

**接口**: `POST /auth/login`

**请求参数**:
```json
{
  "phone": "13800138000",
  "password": "<user-password>"
}
```

**响应示例**:
```json
{
  "code": 200,
  "message": "登录成功",
  "data": {
    "user_id": "user_001",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 7200,
    "user_info": {
      "nickname": "张三",
      "avatar": "https://cdn.example.com/avatar/user_001.jpg"
    }
  }
}
```

### 2.3 微信登录

**接口**: `POST /auth/wechat-login`

**请求参数**:
```json
{
  "code": "wx_login_code",
  "encrypted_data": "encrypted_user_info",
  "iv": "initialization_vector"
}
```

### 2.4 刷新Token

**接口**: `POST /auth/refresh`

**请求头**: `Authorization: Bearer <refresh_token>`

### 2.5 用户登出

**接口**: `POST /auth/logout`

**请求头**: `Authorization: Bearer <access_token>`

---

## 三、设备管理API

### 3.1 设备注册

**接口**: `POST /devices/register`

**请求参数**:
```json
{
  "device_id": "lamp_001",
  "device_name": "卧室台灯",
  "device_type": "sleep_lamp",
  "firmware_version": "1.0.0",
  "mac_address": "AA:BB:CC:DD:EE:FF"
}
```

**响应示例**:
```json
{
  "code": 200,
  "message": "设备注册成功",
  "data": {
    "device_id": "lamp_001",
    "device_secret": "secret_key_xxx",
    "mqtt_config": {
      "broker": "mqtt.sleep-lamp.com",
      "port": 8883,
      "username": "lamp_001",
      "password": "mqtt_password_xxx"
    }
  }
}
```

### 3.2 绑定设备

**接口**: `POST /devices/bind`

**请求参数**:
```json
{
  "device_id": "lamp_001",
  "binding_code": "123456"
}
```

### 3.3 解绑设备

**接口**: `DELETE /devices/{device_id}/unbind`

### 3.4 获取设备列表

**接口**: `GET /devices`

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "devices": [
      {
        "device_id": "lamp_001",
        "device_name": "卧室台灯",
        "device_type": "sleep_lamp",
        "online": true,
        "last_seen": 1704067200000,
        "firmware_version": "1.0.0",
        "location": "卧室"
      }
    ]
  }
}
```

### 3.5 获取设备详情

**接口**: `GET /devices/{device_id}`

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "device_id": "lamp_001",
    "device_name": "卧室台灯",
    "device_type": "sleep_lamp",
    "online": true,
    "last_seen": 1704067200000,
    "firmware_version": "1.0.0",
    "hardware_info": {
      "chip_id": "ESP32-S3",
      "mac_address": "AA:BB:CC:DD:EE:FF",
      "psram_size": "8MB"
    },
    "network_info": {
      "wifi_ssid": "Home_WiFi",
      "signal_strength": -45,
      "ip_address": "192.168.1.100"
    },
    "status": {
      "light": {
        "power": true,
        "brightness": 80,
        "color_temp": 4000
      },
      "anion": {
        "power": false
      },
      "voice": {
        "enabled": true,
        "wakeup_word": "小眠同学"
      }
    }
  }
}
```

### 3.6 设备控制指令

**接口**: `POST /devices/{device_id}/command`

**请求参数**:
```json
{
  "command": "light_control",
  "params": {
    "power": true,
    "brightness": 80,
    "color_temp": 4000
  },
  "timeout": 5000
}
```

**支持的命令类型**:

| 命令 | 说明 | 参数 |
|------|------|------|
| light_control | 灯光控制 | power, brightness, color_temp |
| anion_control | 负离子控制 | power |
| voice_control | 语音控制 | enabled, wakeup_word |
| alarm_config | 报警配置 | enabled, rules |
| ota_upgrade | OTA升级 | version, url |

---

## 四、睡眠监测API

### 4.1 获取实时体征数据

**接口**: `GET /sleep/{device_id}/realtime`

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "device_id": "lamp_001",
    "timestamp": 1704067200000,
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

### 4.2 获取历史体征数据

**接口**: `GET /sleep/{device_id}/history`

**请求参数**:
- `start_time`: 开始时间戳（毫秒）
- `end_time`: 结束时间戳（毫秒）
- `interval`: 采样间隔（秒），默认60
- `metrics`: 指标类型，`heart_rate,breathing_rate,body_movement`

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "device_id": "lamp_001",
    "start_time": 1704067200000,
    "end_time": 1704153600000,
    "interval": 60,
    "metrics": {
      "heart_rate": [
        {"timestamp": 1704067200000, "value": 72},
        {"timestamp": 1704067260000, "value": 70},
        {"timestamp": 1704067320000, "value": 68}
      ],
      "breathing_rate": [
        {"timestamp": 1704067200000, "value": 16},
        {"timestamp": 1704067260000, "value": 15},
        {"timestamp": 1704067320000, "value": 14}
      ]
    }
  }
}
```

### 4.3 获取睡眠报告

**接口**: `GET /sleep/{device_id}/report`

**请求参数**:
- `date`: 日期，格式`YYYY-MM-DD`，默认今天

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "device_id": "lamp_001",
    "date": "2024-01-01",
    "sleep_score": 85,
    "sleep_duration": {
      "total": 43200,
      "deep_sleep": 18000,
      "light_sleep": 21600,
      "rem_sleep": 3600,
      "awake": 3600
    },
    "sleep_efficiency": 92,
    "sleep_latency": 900,
    "awakenings": 3,
    "sleep_structure": [
      {
        "state": "deep_sleep",
        "start_time": "2024-01-01T23:00:00Z",
        "end_time": "2024-01-01T02:00:00Z",
        "duration": 10800
      },
      {
        "state": "light_sleep",
        "start_time": "2024-01-01T02:00:00Z",
        "end_time": "2024-01-01T04:00:00Z",
        "duration": 7200
      }
    ],
    "vital_signs": {
      "avg_heart_rate": 68,
      "min_heart_rate": 55,
      "max_heart_rate": 85,
      "avg_breathing_rate": 15,
      "min_breathing_rate": 12,
      "max_breathing_rate": 18
    },
    "health_suggestions": [
      "您的睡眠质量良好，深睡时间充足",
      "建议保持规律的作息时间",
      "睡前避免使用电子设备"
    ]
  }
}
```

### 4.4 获取睡眠趋势

**接口**: `GET /sleep/{device_id}/trend`

**请求参数**:
- `days`: 天数，默认7
- `metric`: 指标，`sleep_score,sleep_duration,efficiency`

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "device_id": "lamp_001",
    "period": "7_days",
    "trend": {
      "sleep_score": [
        {"date": "2024-01-01", "value": 85},
        {"date": "2024-01-02", "value": 82},
        {"date": "2024-01-03", "value": 88}
      ],
      "sleep_duration": [
        {"date": "2024-01-01", "value": 43200},
        {"date": "2024-01-02", "value": 41400},
        {"date": "2024-01-03", "value": 45000}
      ]
    }
  }
}
```

---

## 五、报警管理API

### 5.1 获取报警记录

**接口**: `GET /alarms`

**请求参数**:
- `device_id`: 设备ID（可选）
- `start_time`: 开始时间（可选）
- `end_time`: 结束时间（可选）
- `level`: 报警级别，`critical,warning,info`（可选）
- `page`: 页码，默认1
- `page_size`: 每页数量，默认20

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 150,
    "page": 1,
    "page_size": 20,
    "alarms": [
      {
        "alarm_id": "alarm_001",
        "device_id": "lamp_001",
        "type": "heart_rate_high",
        "level": "critical",
        "message": "心率异常偏高",
        "value": 125,
        "threshold": 120,
        "timestamp": 1704067200000,
        "status": "handled",
        "handled_by": "user_001",
        "handled_at": 1704067260000
      }
    ]
  }
}
```

### 5.2 获取报警详情

**接口**: `GET /alarms/{alarm_id}`

### 5.3 配置报警规则

**接口**: `POST /alarms/config`

**请求参数**:
```json
{
  "device_id": "lamp_001",
  "rules": [
    {
      "type": "heart_rate_high",
      "enabled": true,
      "threshold": 120,
      "duration": 60,
      "actions": ["push", "sms", "call"]
    },
    {
      "type": "heart_rate_low",
      "enabled": true,
      "threshold": 50,
      "duration": 60,
      "actions": ["push", "sms"]
    },
    {
      "type": "no_movement",
      "enabled": true,
      "threshold": 900,
      "actions": ["push", "sms", "call"]
    }
  ]
}
```

### 5.4 获取报警配置

**接口**: `GET /alarms/config/{device_id}`

### 5.5 标记报警已处理

**接口**: `PUT /alarms/{alarm_id}/handle`

**请求参数**:
```json
{
  "note": "已查看，情况正常"
}
```

---

## 六、语音服务API

### 6.1 获取白噪音列表

**接口**: `GET /voice/white-noise`

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "sounds": [
      {
        "id": "rain",
        "name": "雨声",
        "category": "nature",
        "duration": 1800,
        "url": "https://cdn.sleep-lamp.com/audio/rain.mp3",
        "cover": "https://cdn.sleep-lamp.com/images/rain.jpg"
      },
      {
        "id": "ocean",
        "name": "海浪",
        "category": "nature",
        "duration": 2100,
        "url": "https://cdn.sleep-lamp.com/audio/ocean.mp3",
        "cover": "https://cdn.sleep-lamp.com/images/ocean.jpg"
      }
    ]
  }
}
```

### 6.2 语音识别结果上报

**接口**: `POST /voice/recognize`

**请求参数**:
```json
{
  "device_id": "lamp_001",
  "audio_data": "base64_encoded_audio",
  "recognition_mode": "cloud"
}
```

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "text": "打开台灯",
    "confidence": 0.95,
    "intent": "light_control",
    "entities": {
      "action": "turn_on",
      "target": "lamp"
    }
  }
}
```

### 6.3 语音合成

**接口**: `POST /voice/tts`

**请求参数**:
```json
{
  "text": "您的家人心率异常，请立即查看",
  "voice": "female",
  "speed": 1.0
}
```

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "audio_url": "https://cdn.sleep-lamp.com/tts/xxx.mp3",
    "duration": 3.5
  }
}
```

---

## 七、用户管理API

### 7.1 获取用户信息

**接口**: `GET /users/profile`

### 7.2 更新用户信息

**接口**: `PUT /users/profile`

**请求参数**:
```json
{
  "nickname": "李四",
  "avatar": "https://cdn.example.com/avatar/new.jpg"
}
```

### 7.3 管理紧急联系人

**接口**: `POST /users/contacts`

**请求参数**:
```json
{
  "name": "张三",
  "phone": "13900139000",
  "relationship": "配偶"
}
```

### 7.4 获取紧急联系人列表

**接口**: `GET /users/contacts`

### 7.5 删除紧急联系人

**接口**: `DELETE /users/contacts/{contact_id}`

---

## 八、OTA升级API

### 8.1 检查固件更新

**接口**: `GET /ota/check/{device_id}`

**响应示例**:
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "has_update": true,
    "current_version": "1.0.0",
    "latest_version": "1.1.0",
    "update_type": "incremental",
    "file_size": 1024000,
    "download_url": "https://cdn.sleep-lamp.com/firmware/v1.1.0.bin",
    "release_notes": "修复心率检测算法，优化功耗",
    "md5": "abc123def456..."
  }
}
```

### 8.2 上报OTA进度

**接口**: `POST /ota/progress`

**请求参数**:
```json
{
  "device_id": "lamp_001",
  "version": "1.1.0",
  "progress": 50,
  "status": "downloading"
}
```

---

## 九、WebSocket实时推送

### 9.1 连接地址

**URL**: `wss://api.sleep-lamp.com/ws`

**连接参数**:
- `token`: JWT访问令牌
- `device_id`: 设备ID（可选）

### 9.2 消息类型

#### 设备状态更新

```json
{
  "type": "device_status",
  "device_id": "lamp_001",
  "data": {
    "online": true,
    "timestamp": 1704067200000
  }
}
```

#### 实时体征数据

```json
{
  "type": "vital_signs",
  "device_id": "lamp_001",
  "data": {
    "heart_rate": 72,
    "breathing_rate": 16,
    "body_movement": 0.2,
    "sleep_state": "light_sleep",
    "timestamp": 1704067200000
  }
}
```

#### 报警推送

```json
{
  "type": "alarm",
  "device_id": "lamp_001",
  "data": {
    "alarm_id": "alarm_001",
    "type": "heart_rate_high",
    "level": "critical",
    "message": "心率异常偏高",
    "value": 125,
    "timestamp": 1704067200000
  }
}
```

#### 设备指令响应

```json
{
  "type": "command_response",
  "device_id": "lamp_001",
  "data": {
    "command_id": "cmd_001",
    "status": "success",
    "result": {},
    "timestamp": 1704067200000
  }
}
```

---

## 十、API安全规范

### 10.1 认证机制

- 所有API（除注册/登录外）需要JWT Token认证
- Token有效期：2小时
- Refresh Token有效期：30天

### 10.2 请求限流

| 接口类型 | 限流策略 |
|----------|----------|
| 认证接口 | 10次/分钟/IP |
| 设备控制 | 60次/分钟/用户 |
| 数据查询 | 120次/分钟/用户 |

### 10.3 数据加密

- 所有HTTPS通信使用TLS 1.2+
- 敏感数据（密码、手机号）传输加密
- 设备通信使用MQTT TLS

---

## 十一、API版本管理

### 11.1 版本策略

- 当前公开 URI 保持 `/api`，不包含 `/v1`。
- 未来如需 URI 版本化，必须先通过独立 ADR 定义兼容期，并在迁移期间保留现有 `/api` 路径。
- 不兼容变更不得通过直接替换现有路径发布。

### 11.2 废弃通知

- 废弃API提前3个月通知
- 响应头添加`Deprecated: true`
- 响应体包含`deprecation_warning`字段

---

## 十二、附录

### 12.1 HTTP状态码

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 204 | 无内容 |
| 400 | 请求错误 |
| 401 | 未授权 |
| 403 | 禁止访问 |
| 404 | 资源不存在 |
| 429 | 请求过于频繁 |
| 500 | 服务器错误 |
| 503 | 服务不可用 |

### 12.2 数据类型定义

| 类型 | 说明 | 示例 |
|------|------|------|
| timestamp | Unix时间戳（毫秒） | 1704067200000 |
| device_id | 设备唯一标识 | lamp_001 |
| user_id | 用户唯一标识 | user_001 |
| alarm_id | 报警唯一标识 | alarm_001 |
