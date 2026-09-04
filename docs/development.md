# 智能睡眠监测台灯 - 开发者文档

## 目录

- [1. 项目架构](#1-项目架构)
- [2. 开发环境搭建](#2-开发环境搭建)
- [3. 后端开发](#3-后端开发)
- [4. 小程序开发](#4-小程序开发)
- [5. 固件开发](#5-固件开发)
- [6. 数据库设计](#6-数据库设计)
- [7. API开发规范](#7-api开发规范)
- [8. 测试指南](#8-测试指南)
- [9. 性能优化](#9-性能优化)
- [10. 贡献指南](#10-贡献指南)

---

## 1. 项目架构

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户层                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  微信小程序  │  │  Web管理后台  │  │  移动APP    │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                      API网关层                            │
│              (Nginx + SSL + 负载均衡)                  │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                      应用层                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  NestJS后端  │  │  WebSocket服务 │  │  MQTT服务   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                      数据层                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ TimescaleDB  │  │    Redis     │  │  MQTT Broker │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                      设备层                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  ESP32-S3   │  │  R60ABD1雷达  │  │  其他传感器  │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 技术栈

| 层级 | 技术选型 | 版本 | 说明 |
|------|----------|------|------|
| 前端框架 | Taro | 3.6.23 | 多端小程序框架 |
| UI框架 | React | 18.0.0 | 前端UI框架 |
| 后端框架 | NestJS | 11.0.1 | Node.js企业级框架 |
| ORM | Prisma | 5.22.0 | 类型安全ORM |
| 数据库 | TimescaleDB | latest-pg16 | 时序数据库 |
| 缓存 | Redis | 7.x | 内存数据库 |
| MQTT 客户端 | `mqtt` npm 包 | 5.15.x | MQTT 协议客户端；EMQX broker 版本见部署配置 |
| 固件框架 | ESP-IDF | 5.4.1 | ESP32开发框架 |
| 芯片 | ESP32-S3 | - | 主控芯片 |
| 雷达 | R60ABD1 | - | 毫米mm波雷达 |

### 1.3 目录结构

稳定的开发入口如下；模块细节以源码和 `docs/current-architecture.md` 为准：

- `src/`：Vite/React Web 与 Capacitor Web 源码。
- `miniprogram/`：Taro/React 微信小程序。
- `backend/`：NestJS 业务控制面，数据库模型与迁移位于 `backend/prisma/`。
- `services/`：遥测、实时处理、Flink、特征与 Agent 独立服务。
- `platform/`：数据契约、部署、可观测性、IaC 与验证资产。
- `firmware/`：ESP32-S3 固件源码；当前只作为源码/设计证据。

`dist/`、`build/`、依赖目录与本地数据目录不属于源码入口。

---

## 2. 开发环境搭建

### 2.1 基础环境

**系统要求**:
- 操作系统: Windows 10+ / macOS 10.15+ / Ubuntu 20.04+
- Node.js: 20.x LTS 或更高版本
- npm: 9.x 或更高版本
- Git: 2.x 或更高版本
- Docker: 20.10+ (可选)
- VSCode: 最新版本 (推荐)

### 2.2 后端开发环境

```bash
# 克隆项目
git clone https://github.com/your-repo/sleep202603.git
cd sleep202603/backend

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件，配置数据库连接等

# 初始化数据库
npx prisma generate
npx prisma db push

# 启动开发服务器
npm run start:dev
```

### 2.3 小程序开发环境

```bash
# 进入小程序目录
cd miniprogram

# 安装依赖
npm install

# 配置项目
# 编辑 project.config.json，填入小程序AppID

# 启动开发服务器
npm run dev:weapp
```

### 2.4 固件开发环境

```bash
# 安装ESP-IDF
# 访问 https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/get-started/index.html
# 下载并安装ESP-IDF v5.4.1

# 配置VSCode
# 安装ESP-IDF插件
# 配置ESP-IDF路径和版本

# 打开项目
cd firmware
# 按F1打开命令面板
# 输入"ESP-IDF: Set Target"选择ESP32-S3
```

---

## 3. 后端开发

### 3.1 项目结构

NestJS采用模块化架构，每个功能模块独立：

```
src/
├── auth/              # 认证模块
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   └── dto/
├── device/            # 设备模块
│   ├── device.module.ts
│   ├── device.controller.ts
│   ├── device.service.ts
│   └── dto/
├── sleep/             # 睡眠模块
│   ├── sleep.module.ts
│   ├── sleep.controller.ts
│   ├── sleep.service.ts
│   └── dto/
└── ...
```

### 3.2 创建新模块

```bash
# 使用NestJS CLI创建模块
nest g module modules/your-module
nest g controller modules/your-module/your-module
nest g service modules/your-module/your-module
nest g dto modules/your-module/create-your-module.dto
```

### 3.3 数据库操作

**创建模型**:
```prisma
// prisma/schema.prisma
model YourModel {
  id        String   @id @default(uuid())
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

**生成Prisma Client**:
```bash
npx prisma generate
```

**运行迁移**:
```bash
npx prisma migrate dev --name init
```

**在代码中使用**:
```typescript
@Injectable()
export class YourService {
  constructor(private prisma: PrismaService) {}

  async create(data: CreateDto) {
    return this.prisma.yourModel.create({
      data: {
        name: data.name,
      },
    });
  }

  async findAll() {
    return this.prisma.yourModel.findMany();
  }
}
```

### 3.4 API开发规范

**Controller规范**:
```typescript
@Controller('your-endpoint')
export class YourController {
  @Get()
  findAll() {
    return this.yourService.findAll();
  }

  @Post()
  create(@Body() createDto: CreateDto) {
    return this.yourService.create(createDto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.yourService.findOne(id);
  }
}
```

**Service规范**:
```typescript
@Injectable()
export class YourService {
  async create(createDto: CreateDto) {
    try {
      return await this.prisma.yourModel.create({
        data: createDto,
      });
    } catch (error) {
      throw new BadRequestException('创建失败');
    }
  }
}
```

**DTO规范**:
```typescript
export class CreateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsInt()
  age?: number;
}
```

### 3.5 错误处理

```typescript
// 全局异常过滤器
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = exception instanceof HttpException
      ? exception.message
      : 'Internal server error';

    response.status(status).json({
      code: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
```

---

## 4. 小程序开发

### 4.1 页面开发

**创建页面**:
```bash
# 使用Taro CLI创建页面
npx taro create page pages/your-page
```

**页面结构**:
```typescript
// pages/your-page/index.tsx
import React, { useState, useEffect } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

const YourPage: React.FC = () => {
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const result = await api.yourApi.getData()
      setData(result.data)
    } catch (error) {
      console.error('加载数据失败:', error)
    }
  }

  return (
    <View className='your-page'>
      <Text>你的页面</Text>
    </View>
  )
}

export default YourPage
```

### 4.2 组件开发

**创建组件**:
```bash
# 创建组件目录
mkdir -p src/components/YourComponent

# 创建组件文件
touch src/components/YourComponent/index.tsx
touch src/components/YourComponent/index.scss
```

**组件示例**:
```typescript
// components/YourComponent/index.tsx
import React from 'react'
import { View, Text } from '@tarojs/components'
import './index.scss'

interface YourComponentProps {
  title: string
  onClick?: () => void
}

const YourComponent: React.FC<YourComponentProps> = ({ title, onClick }) => {
  return (
    <View className='your-component' onClick={onClick}>
      <Text className='title'>{title}</Text>
    </View>
  )
}

export default YourComponent
```

### 4.3 状态管理

使用Zustand进行状态管理：

```typescript
// store/index.ts
import { create } from 'zustand'

interface AppState {
  user: any
  setUser: (user: any) => void
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}))
```

**使用状态**:
```typescript
import { useAppStore } from '../../store'

const YourPage: React.FC = () => {
  const { user, setUser } = useAppStore()

  return (
    <View>
      <Text>{user?.name}</Text>
    </View>
  )
}
```

### 4.4 API调用

```typescript
// utils/api.ts
import Taro from '@tarojs/taro'

const API_BASE_URL = 'https://api.example.com/api'

export const api = {
  yourApi: {
    getData: async () => {
      const response = await Taro.request({
        url: `${API_BASE_URL}/data`,
        method: 'GET',
      })
      return response.data
    },
  },
}
```

---

## 5. 固件开发

### 5.1 项目结构

```
firmware/
├── main/
│   ├── main.cpp           # 主程序入口
│   ├── app_sleep.cpp      # 睡眠监测应用
│   ├── radar_driver.cpp   # 雷达驱动
│   ├── audio_driver.cpp   # 音频驱动
│   └── ...
├── components/          # 组件库
│   ├── led/
│   ├── wifi/
│   └── mqtt/
├── build/               # 编译产物
└── sdkconfig            # 项目配置
```

### 5.2 创建新任务

```c
// 创建任务
xTaskCreatePinnedToCore(
    your_task,          // 任务函数
    "YourTask",        // 任务名称
    4096,              // 栈大小
    NULL,               // 参数
    5,                  // 优先级
    NULL,               // 任务句柄
    1                   // 运行在核心1
);

// 任务函数
void your_task(void *pvParameters) {
    ESP_LOGI(TAG, "Task started");
    
    while (1) {
        // 任务逻辑
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    vTaskDelete(NULL);
}
```

### 5.3 驱动开发

**驱动模板**:
```c
// radar_driver.h
#ifndef RADAR_DRIVER_H
#define RADAR_DRIVER_H

#include "esp_err.h"

esp_err_t radar_init(void);
esp_err_t radar_deinit(void);
esp_err_t radar_read_data(uint8_t *data, size_t len);

#endif // RADAR_DRIVER_H

// radar_driver.cpp
#include "radar_driver.h"
#include "esp_log.h"

static const char *TAG = "radar_driver";

esp_err_t radar_init(void) {
    ESP_LOGI(TAG, "Initializing radar driver");
    
    // 初始化代码
    
    return ESP_OK;
}

esp_err_t radar_read_data(uint8_t *data, size_t len) {
    // 读取数据代码
    
    return ESP_OK;
}
```

### 5.4 MQTT通信

```c
// MQTT配置
#define MQTT_BROKER_URL     "mqtt://broker.example.com"
#define MQTT_BROKER_PORT    1883
#define MQTT_CLIENT_ID      "esp32_client"

// MQTT事件处理
static void mqtt_event_handler(void *handler_args, esp_event_base_t base_event, 
                                int32_t event_id, void *event_data) {
    esp_mqtt_event_handle_t *event = (esp_mqtt_event_handle_t *)event_data;
    
    switch (event->event_id) {
        case MQTT_EVENT_CONNECTED:
            ESP_LOGI(TAG, "MQTT_EVENT_CONNECTED");
            break;
        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGI(TAG, "MQTT_EVENT_DISCONNECTED");
            break;
        case MQTT_EVENT_DATA:
            ESP_LOGI(TAG, "MQTT_EVENT_DATA");
            break;
        default:
            break;
    }
}

// 发布数据
void mqtt_publish_data(const char *topic, const char *data) {
    int msg_id = esp_mqtt_client_publish(client, 0, topic, strlen(data), data, 0, 1);
    ESP_LOGI(TAG, "Published data to topic: %s", topic);
}
```

### 5.5 OTA升级

```c
// OTA升级
esp_err_t ota_update(const char *ota_url) {
    ESP_LOGI(TAG, "Starting OTA update from: %s", ota_url);
    
    esp_http_client_config_t http_config = {
        .url = ota_url,
        .keep_alive_enable = true,
    };
    
    esp_https_ota_config_t ota_config = {
        .http_config = &http_config,
    };
    
    esp_err_t ret = esp_https_ota(&ota_config);
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "OTA update successful");
        esp_restart();
    }
    
    return ret;
}
```

---

## 6. 数据库设计

### 6.1 数据模型

**用户表**:
```prisma
model User {
  id            String   @id @default(uuid())
  phone         String   @unique
  password      String
  nickname      String?
  avatarUrl     String?
  wechatOpenid  String?  @unique
  lastLoginAt   DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

**设备表**:
```prisma
model Device {
  id                String   @id @default(uuid())
  deviceId          String   @unique
  deviceName        String
  deviceType        String
  firmwareVersion   String
  online            Boolean  @default(false)
  lastSeen          DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}
```

**睡眠数据表**:
```prisma
model VitalSignsData {
  id            String   @id @default(uuid())
  deviceId      String
  timestamp     DateTime
  heartRate     Int?
  breathingRate Int?
  bodyMovement Float?
  sleepState    String?
  createdAt     DateTime @default(now())
  
  @@index([deviceId, timestamp])
}
```

### 6.2 时序数据优化

使用TimescaleDB的Hypertable优化时序数据：

```sql
-- 创建Hypertable
SELECT create_hypertable('vital_signs_data', (
  timestamp TIMESTAMPT NOT NULL,
  device_id TEXT NOT NULL,
  heart_rate INTEGER,
  breathing_rate INTEGER,
  body_movement DOUBLE PRECISION,
  sleep_state TEXT
));

-- 创建索引
CREATE INDEX ON vital_signs_data (device_id, timestamp DESC);
```

---

## 7. API开发规范

### 7.1 RESTful API设计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/devices | 获取设备列表 |
| POST | /api/devices | 创建设备 |
| GET | /api/devices/:id | 获取设备详情 |
| PUT | /api/devices/:id | 更新设备 |
| DELETE | /api/devices/:id | 删除设备 |

### 7.2 响应格式

**成功响应**:
```json
{
  "code": 200,
  "message": "success",
  "data": {},
  "timestamp": 1704067200000
}
```

**错误响应**:
```json
{
  "code": 400,
  "message": "参数错误",
  "errors": [
    {
      "field": "name",
      "message": "名称不能为空"
    }
  ],
  "timestamp": 1704067200000
}
```

### 7.3 分页规范

```typescript
// 分页DTO
export class PaginationDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

// 分页响应
export class PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
```

---

## 8. 测试指南

### 8.1 单元测试

```typescript
// device.service.spec.ts
describe('DeviceService', () => {
  let service: DeviceService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DeviceService, PrismaService],
    }).compile();

    service = module.get<DeviceService>(DeviceService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should create a device', async () => {
    const createDto = { name: 'Test Device' };
    const result = await service.create(createDto);
    
    expect(result).toHaveProperty('id');
    expect(result.name).toBe(createDto.name);
  });
});
```

### 8.2 集成测试

```typescript
// device.e2e-spec.ts
describe('DeviceController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/devices (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/devices')
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty('data');
        expect(Array.isArray(res.body.data)).toBe(true);
      });
  });
});
```

### 8.3 运行测试

```bash
# 运行所有测试
npm run test

# 运行单元测试
npm run test

# 运行E2E测试
npm run test:e2e

# 生成测试覆盖率报告
npm run test:cov
```

---

## 9. 性能优化

### 9.1 数据库优化

**索引优化**:
```sql
-- 为常用查询字段创建索引
CREATE INDEX idx_device_id ON vital_signs_data(device_id);
CREATE INDEX idx_timestamp ON vital_signs_data(timestamp DESC);
CREATE INDEX idx_device_timestamp ON vital_signs_data(device_id, timestamp DESC);
```

**查询优化**:
```typescript
// 使用分页查询
async findDeviceData(deviceId: string, page: number, pageSize: number) {
  return this.prisma.vitalSignsData.findMany({
    where: { deviceId },
    orderBy: { timestamp: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
}
```

### 9.2 缓存优化

```typescript
@Injectable()
export class CacheService {
  constructor(private redis: RedisService) {}

  async get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: any, ttl: number = 3600) {
    return this.redis.set(key, JSON.stringify(value), ttl);
  }

  async del(key: string) {
    return this.redis.del(key);
  }
}
```

### 9.3 前端优化

**代码分割**:
```json
// project.config.json
{
  "subPackages": [
    {
      "root": "pages/history",
      "name": "history"
    }
  ]
}
```

**懒加载**:
```typescript
// 动态导入组件
const LazyComponent = React.lazy(() => import('./LazyComponent'))

// 使用Suspense
<Suspense fallback={<Loading />}>
  <LazyComponent />
</Suspense>
```

---

## 10. 贡献指南

### 10.1 代码规范

- 遵循项目代码规范
- 使用有意义的变量名
- 添加必要的注释
- 保持代码简洁

### 10.2 提交规范

```bash
# 提交信息格式
<type>(<scope>): <subject>

<body>

<footer>
```

**类型**:
- feat: 新功能
- fix: Bug修复
- docs: 文档更新
- style: 代码格式
- refactor: 重构
- test: 测试
- chore: 构建/工具

**示例**:
```bash
feat(device): add device registration API
fix(sleep): fix sleep data parsing bug
docs(readme): update installation guide
```

### 10.3 Pull Request规范

1. Fork项目仓库
2. 创建功能分支
3. 提交代码
4. 创建Pull Request
5. 等待代码审查
6. 根据反馈修改
7. 合并到主分支

---

## 附录

### A. 环境变量清单

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| NODE_ENV | 运行环境 | development |
| PORT | 服务端口 | 3000 |
| DATABASE_URL | 数据库连接 | - |
| REDIS_HOST | Redis主机 | localhost |
| REDIS_PORT | Redis端口 | 6379 |
| MQTT_BROKER_URL | MQTT地址 | - |
| JWT_SECRET | JWT密钥 | - |

### B. 常用命令

```bash
# 后端
npm install              # 安装依赖
npm run start:dev        # 启动开发服务器
npm run build           # 构建项目
npm run test            # 运行测试
npx prisma generate      # 生成Prisma Client
npx prisma db push       # 推送数据库schema

# 小程序
npm install              # 安装依赖
npm run dev:weapp       # 启动开发服务器
npm run build:weapp      # 构建小程序

# 固件
idf.py build             # 编译固件
idf.py flash             # 烧录固件
idf.py monitor           # 监控串口输出
```

### C. 参考资源

- [NestJS文档](https://docs.nestjs.com/)
- [Taro文档](https://taro-docs.jd.com/)
- [ESP-IDF文档](https://docs.espressif.com/)
- [Prisma文档](https://www.prisma.io/docs)
- [TimescaleDB文档](https://docs.timescale.com/)

---

**文档版本**: 1.0.0
**最后更新**: 2024-01-01
**维护者**: 开发团队
