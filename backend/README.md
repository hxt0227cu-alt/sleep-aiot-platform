# 智能睡眠监测台灯 - 后端服务

基于 NestJS + TypeScript + Prisma + TimescaleDB 的后端服务。

## 技术栈

- **框架**: NestJS 11.x + Express
- **语言**: TypeScript
- **数据库**: PostgreSQL + TimescaleDB
- **ORM**: Prisma 5.x
- **缓存**: Redis 7.x
- **消息队列**: MQTT (EMQX)
- **认证**: JWT

## 快速开始

### 1. 启动基础设施

使用 Docker Compose 启动 TimescaleDB、Redis 和 EMQX：

```bash
cd ..
docker-compose up -d
```

服务访问地址：
- TimescaleDB: `localhost:5433`
- Redis: `localhost:6380`
- EMQX Dashboard: `http://localhost:18083`（凭证由本地 `.env` 注入）
- MQTT Broker: `localhost:1883`

### 2. 安装依赖

```bash
cd backend
npm install
```

### 3. 初始化数据库

> 数据库名按环境配置：本地开发示例使用 `sleep_lamp`，ECS/preprod 现有配置使用 `sleep_monitor`。执行 Prisma 或 TimescaleDB SQL 前必须核对目标环境的 `DATABASE_URL`，不要把一个环境的库名复制到另一个环境。两份 TimescaleDB SQL 的正式部署入口仍待 owner 决策，详见 `docs/Database_Design.md`。

```bash
npx prisma generate
npx prisma db push
```

### 4. 启动服务

```bash
# 开发模式
npm run start:dev

# 生产模式
npm run start:prod
```

服务默认运行在 `http://localhost:3000`

## MQTT 服务

### MQTT 配置

MQTT 配置在 `.env` 文件中：

```env
MQTT_BROKER_URL="mqtt://localhost:1883"
MQTT_USERNAME="<mqtt-user>"
MQTT_PASSWORD="<生成的随机值>"
```

### 主题结构

| 主题 | 方向 | 说明 |
|------|------|------|
| `device/{device_id}/telemetry` | 设备 → telemetry-ingest | 遥测数据上报；backend 不订阅 |
| `device/{device_id}/status` | 设备 → 云端 | 设备状态上报（60秒） |
| `device/{device_id}/alarm` | 设备 → 云端 | 报警上报 |
| `device/{device_id}/log` | 设备 → 云端 | 日志上报 |
| `device/{device_id}/command` | 云端 → 设备 | 控制指令下发 |
| `device/{device_id}/command/response` | 设备 → 云端 | 指令响应 |
| `device/{device_id}/config` | 云端 → 设备 | 配置下发 |
| `device/{device_id}/ota/command` | 云端 → 设备 | OTA升级指令 |
| `device/{device_id}/ota/progress` | 设备 → 云端 | OTA进度上报 |

### MQTT 测试

#### 1. 使用测试脚本

运行 MQTT 测试工具：

```bash
node scripts/test-mqtt.js
```

该脚本会：
- 连接到 MQTT Broker
- 订阅测试主题
- 发送遥测数据、设备状态、报警和控制指令
- 持续监听并显示接收到的消息

#### 2. 运行单元测试

```bash
npm run test
```

### MQTTService API

```typescript
// 发布消息
await mqttService.publish('device/test/command', JSON.stringify(data), { qos: 1 });

// 订阅 backend 拥有的主题；telemetry 由 telemetry-ingest 消费
mqttService.subscribe('$share/sleep-backend/device/+/status', (topic, message) => {
  console.log('Received:', topic, message.toString());
});

// 取消订阅
mqttService.unsubscribe('$share/sleep-backend/device/+/status');

// 检查连接状态
const isConnected = mqttService.isConnected();
```

## 可用脚本

```bash
# 开发模式
npm run start:dev

# 生产构建
npm run build

# 生产模式
npm run start:prod

# 代码格式化
npm run format

# 代码检查
npm run lint

# 单元测试
npm run test

# 测试覆盖率
npm run test:cov

# E2E测试
npm run test:e2e
```

## 项目结构

```
backend/
├── src/
│   ├── alarm/          # 报警模块
│   ├── auth/           # 认证模块
│   ├── common/         # 通用组件
│   ├── config/         # 配置文件
│   ├── database/       # 数据库模块
│   ├── device/         # 设备模块
│   ├── mqtt/           # MQTT模块
│   ├── redis/          # Redis模块
│   ├── sleep/          # 睡眠数据模块
│   ├── app.module.ts   # 应用模块
│   └── main.ts         # 应用入口
├── scripts/
│   └── test-mqtt.js    # MQTT测试脚本
├── test/
│   └── mqtt.service.spec.ts  # MQTT测试
├── prisma/
│   └── schema.prisma   # Prisma Schema
├── docs/               # 文档
├── .env                # 环境变量
└── package.json
```

## 文档

- [API 设计文档](docs/API_Design.md)
- [数据库设计文档](docs/Database_Design.md)
- [MQTT 协议文档](docs/MQTT_Protocol.md)
