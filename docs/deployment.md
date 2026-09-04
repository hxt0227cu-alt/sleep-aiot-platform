# 智能睡眠监测台灯 - 项目部署文档

## 目录

- [1. 后端部署指南](#1-后端部署指南)
- [2. 小程序发布指南](#2-小程序发布指南)
- [3. 固件烧录指南](#3-固件烧录指南)
- [4. 常见问题](#4-常见问题)

---

## 1. 后端部署指南

### 1.1 系统要求

- **操作系统**: Linux (Ubuntu 20.04+ 推荐) / Windows / macOS
- **Node.js**: 20.x LTS 或更高版本
- **npm**: 9.x 或更高版本
- **Docker**: 20.10+ (用于运行基础设施服务)
- **Docker Compose**: 2.0+
- **内存**: 至少 4GB RAM
- **磁盘空间**: 至少 20GB 可用空间

### 1.2 环境配置

#### 1.2.1 安装 Node.js 和 npm

**Ubuntu/Debian:**
```bash
# 使用 NodeSource 仓库安装 Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证安装
node --version
npm --version
```

**Windows:**
1. 访问 [Node.js 官网](https://nodejs.org/)
2. 下载并安装 LTS 版本
3. 重启命令行窗口

**macOS:**
```bash
# 使用 Homebrew 安装
brew install node@20

# 验证安装
node --version
npm --version
```

#### 1.2.2 安装 Docker 和 Docker Compose

**Ubuntu/Debian:**
```bash
# 安装 Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# 将当前用户添加到 docker 组
sudo usermod -aG docker $USER

# 安装 Docker Compose
sudo apt-get install docker-compose-plugin

# 验证安装
docker --version
docker compose version
```

**Windows:**
1. 下载并安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)
2. 启动 Docker Desktop

**macOS:**
```bash
# 使用 Homebrew 安装
brew install --cask docker

# 启动 Docker Desktop
open /Applications/Docker.app
```

### 1.3 启动基础设施服务

#### 1.3.1 使用 Docker Compose 启动服务

```bash
# 进入项目根目录
cd <repo-root>

# 启动所有服务（TimescaleDB、Redis、EMQX）
docker compose up -d

# 查看服务状态
docker compose ps

# 查看服务日志
docker compose logs -f
```

#### 1.3.2 服务访问地址

| 服务 | 地址 | 用户名 | 密码 |
|------|------|--------|------|
| TimescaleDB | `localhost:5433` | `${POSTGRES_USER}` | `${POSTGRES_PASSWORD}` |
| Redis | `localhost:6380` | - | `${REDIS_PASSWORD}` |
| EMQX Dashboard | `http://localhost:18083` | `${EMQX_DASHBOARD_USER}` | `${EMQX_DASHBOARD_PASSWORD}` |
| MQTT Broker | `localhost:1883` | - | - |

#### 1.3.3 验证服务状态

> 本地开发示例数据库名为 `sleep_lamp`，ECS/preprod 现有配置使用 `sleep_monitor`。以下命令只适用于本地 Compose；部署到其他环境时必须从该环境的 `DATABASE_URL` 读取目标库名，不得直接复制示例值。

**验证 TimescaleDB:**
```bash
# 使用 psql 连接
docker exec -it sleep-lamp-timescaledb psql -U hxt -d sleep_lamp

# 查看数据库版本
SELECT version();

# 退出
\q
```

**验证 Redis:**
```bash
# 使用 redis-cli 连接
docker exec -it sleep-lamp-redis redis-cli -a "${REDIS_PASSWORD}"

# 测试连接
PING

# 退出
EXIT
```

**验证 EMQX:**
```bash
# 访问 EMQX Dashboard
# 浏览器打开: http://localhost:18083
# 用户名和密码使用本地 `.env` 中的 EMQX Dashboard 配置
```

### 1.4 后端服务部署

#### 1.4.1 安装依赖

```bash
# 进入后端目录
cd <repo-root>/backend

# 安装依赖
npm install
```

#### 1.4.2 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件，修改以下关键配置：
```

**.env 配置说明：**

```env
# 服务端口
PORT=3000
NODE_ENV=production

# 数据库连接（根据 Docker Compose 配置）
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5433/${POSTGRES_DB}?schema=public"

# Redis 连接
REDIS_HOST=localhost
REDIS_PORT=6380
REDIS_PASSWORD=<生成的随机值>

# JWT 密钥（生产环境必须修改）
JWT_SECRET=<生成的随机值>
JWT_EXPIRES_IN=2h
JWT_REFRESH_SECRET=<生成的另一随机值>
JWT_REFRESH_EXPIRES_IN=30d

# MQTT 连接
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_CLIENT_ID=sleep-lamp-backend

# 微信小程序配置（从微信公众平台获取）
WECHAT_APP_ID=your-wechat-app-id
WECHAT_APP_SECRET=your-wechat-app-secret

# 百度语音识别配置（从百度AI开放平台获取）
BAIDU_ASR_APP_ID=your-baidu-asr-app-id
BAIDU_ASR_API_KEY=your-baidu-asr-api-key
BAIDU_ASR_SECRET_KEY=your-baidu-asr-secret-key

# 百度语音合成配置（从百度AI开放平台获取）
BAIDU_TTS_APP_ID=your-baidu-tts-app-id
BAIDU_TTS_API_KEY=your-baidu-tts-api-key
BAIDU_TTS_SECRET_KEY=your-baidu-tts-secret-key

# CDN 基础 URL
CDN_BASE_URL=https://cdn.sleep-lamp.com
```

#### 1.4.3 初始化数据库

```bash
# 生成 Prisma Client
npx prisma generate

# 推送数据库 schema（创建表）
npx prisma db push

# 可选：创建数据库迁移
npx prisma migrate dev --name init

# 可选：填充种子数据
npx prisma db seed
```

#### 1.4.4 构建和启动

**开发模式：**
```bash
# 启动开发服务器（支持热重载）
npm run start:dev
```

**生产模式：**
```bash
# 构建项目
npm run build

# 启动生产服务器
npm run start:prod
```

#### 1.4.5 使用 PM2 部署（推荐）

**安装 PM2:**
```bash
npm install -g pm2
```

**创建 PM2 配置文件 `ecosystem.config.js`:**
```javascript
module.exports = {
  apps: [{
    name: 'sleep-lamp-backend',
    script: 'dist/main.js',
    instances: 2,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
```

**启动服务：**
```bash
# 启动应用
pm2 start ecosystem.config.js

# 查看状态
pm2 status

# 查看日志
pm2 logs sleep-lamp-backend

# 重启应用
pm2 restart sleep-lamp-backend

# 停止应用
pm2 stop sleep-lamp-backend

# 设置开机自启
pm2 startup
pm2 save
```

### 1.5 使用 Nginx 反向代理（可选）

#### 1.5.1 安装 Nginx

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install -y nginx
```

**Windows:**
1. 下载并安装 [Nginx](http://nginx.org/en/download.html)

#### 1.5.2 配置 Nginx

创建 Nginx 配置文件 `/etc/nginx/sites-available/sleep-lamp`:

```nginx
upstream sleep_lamp_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    server_name api.sleep-lamp.com;

    # 日志
    access_log /var/log/nginx/sleep-lamp-access.log;
    error_log /var/log/nginx/sleep-lamp-error.log.log;

    # 请求体大小限制
    client_max_body_size 10M;

    # 代理设置
    location / {
        proxy_pass http://sleep_lamp_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    # WebSocket 支持
    location /ws {
        proxy_pass http://sleep_lamp_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

**启用配置：**
```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/sleep-lamp /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重启 Nginx
sudo systemctl restart nginx
```

### 1.6 配置 HTTPS（可选）

使用 Let's Encrypt 免费证书：

```bash
# 安装 Certbot
sudo apt-get install -y certbot python3-certbot-nginx

# 获取证书
sudo certbot --nginx -d api.sleep-lamp.com

# 自动续期
sudo certbot renew --dry-run
```

### 1.7 验证部署

```bash
# 存活探针：进程是否运行
curl http://localhost:3000/api/health/live

# 就绪探针：汇总数据库、Redis 与 MQTT 依赖状态
curl http://localhost:3000/api/health/ready

# Prometheus 指标
curl http://localhost:3000/api/metrics
```

> 当前源码尚未启用 Swagger UI，`/api/docs` 不属于可用端点。后续如接入 OpenAPI，开发环境 UI 与 CI 规范生成应分别受配置控制，生产环境不得默认公开。

---

## 2. 小程序发布指南

### 2.1 开发环境准备

#### 2.1.1 安装微信开发者工具

1. 访问 [微信开发者工具官网](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 下载并安装对应平台的版本
3. 启动微信开发者工具并扫码登录

#### 2.1.2 安装 Node.js 和 npm

参考 [1.2.1 安装 Node.js 和 npm](#121-安装-nodejs-和-npm)

#### 2.1.3 安装项目依赖

```bash
# 进入小程序目录
cd <repo-root>/miniprogram

# 安装依赖
npm install
```

### 2.2 配置小程序

#### 2.2.1 获取小程序 AppID

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入"开发" -> "开发设置"
3. 记录 AppID

#### 2.2.2 配置服务器域名

在微信公众平台配置以下域名：

| 类型 | 域名 | 说明 |
|------|------|------|
| request 域名 | `https://api.sleep-lamp.com` | HTTPS API 请求 |
| socket 域名 | `wss://api.sleep-lamp.com` | WebSocket 连接 |
| uploadFile 域名 | `https://api.sleep-lamp.com` | 文件上传 |
| downloadFile 域名 | `https://api.sleep-lamp.com` | 文件下载 |

#### 2.2.3 配置项目

修改 `miniprogram/src/utils/constants.ts`:

```typescript
// API 基础 URL（生产环境）
export const API_BASE_URL = 'https://<your-domain>/api'

// WebSocket 基础 URL（生产环境）
export const WS_BASE_URL = 'wss://api.sleep-lamp.com/ws'

// 小程序 AppID
export const APP_ID = 'your-wechat-app-id'
```

修改 `miniprogram/project.config.json`:

```json
{
  "appid": "your-wechat-app-id",
  "projectname": "智能睡眠监测台灯",
  "description": "智能睡眠监测台灯小程序",
  "setting": {
    "urlCheck": true,
    "es6": true,
    "postcss": true,
    "minified": true
  }
}
```

### 2.3 开发和调试

#### 2.3.1 开发模式

```bash
# 启动开发服务器（支持热重载）
npm run dev:weapp
```

#### 2.3.2 使用微信开发者工具

1. 打开微信开发者工具
2. 选择"导入项目"
3. 选择项目目录：`d:\sleep202603\miniprogram`
4. 填写 AppID
5. 点击"导入"

#### 2.3.3 调试技巧

- **查看日志**: 使用 `console.log()` 输出日志，在开发者工具的"控制台"查看
- **网络请求**: 在"网络"面板查看 API 请求
- **性能分析**: 使用"性能"面板分析性能
- **真机调试**: 点击"真机调试"按钮，扫码在手机上调试

### 2.4 构建和发布

#### 2.4.1 生产构建

```bash
# 构建小程序
npm run build:weapp
```

构建产物在 `miniprogram/dist` 目录。

#### 2.4.2 上传代码

1. 在微信开发者工具中，点击"上传"按钮
2. 填写版本号（如：1.0.0）
3. 填写项目备注
4. 点击"上传"

#### 2.4.3 提交审核

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入"版本管理" -> "开发版本"
3. 找到刚上传的版本，点击"提交审核"
4. 填写审核信息：
   - 功能页面：首页、历史数据、睡眠报告等
   - 测试账号：提供测试账号
   - 其他说明：简要说明小程序功能
5. 提交审核

#### 2.4.4 发布上线

审核通过后：

1. 在微信公众平台进入"版本管理" -> "审核版本"
2. 点击"发布"按钮
3. 确认发布信息
4. 小程序正式上线

### 2.5 版本管理

#### 2.5.1 版本号规范

采用语义化版本号：`主版本.次版本.修订版本`

- **主版本**: 不兼容的 API 修改
- **次版本**: 向下兼容的功能性新增
- **修订版本**: 向下兼容的问题修正

示例：
- `1.0.0` - 首次发布
- `1.1.0` - 新增功能
- `1.1.1` - Bug 修复
- `2.0.0` - 重大更新

#### 2.5.2 灰度发布

1. 在微信公众平台进入"版本管理" -> "线上版本"
2. 点击"全量发布" -> "分阶段发布"
3. 设置发布比例（如：10%、30%、50%、100%）
4. 观察数据，逐步扩大发布范围

#### 2.5.3 回滚

如果发现问题需要回滚：

1. 在微信公众平台进入"版本管理" -> "线上版本"
2. 点击"回退"按钮
3. 选择要回退的版本
4. 确认回退

### 2.6 性能优化

#### 2.6.1 代码分包

在 `project.config.json` 中配置分包：

```json
{
  "subPackages": [
    {
      "root": "pages/history",
      "name": "history",
      "pages": [
        "pages/history/index"
      ]
    },
    {
      "root": "pages/sleep-report",
      "name": "sleep-report",
      "pages": [
        "pages/sleep-report/index"
      ]
    }
  ]
}
```

#### 2.6.2 资源优化

- **图片压缩**: 使用 TinyPNG 等工具压缩图片
- **按需加载**: 使用 `require()` 动态加载资源
- **CDN 加速**: 将静态资源上传到 CDN

#### 2.6.3 代码优化

- **Tree Shaking**: 移除未使用的代码
- **代码压缩**: 启用代码压缩
- **懒加载**: 使用 `import()` 动态导入

---

## 3. 固件烧录指南

### 3.1 开发环境准备

#### 3.1.1 安装 ESP-IDF

**方法一：使用安装器（推荐）**

1. 访问 [ESP-IDF 官网](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/get-started/index.html)
2. 下载 ESP-IDF v5.4.1 安装器
3. 运行安装器，选择安装路径
4. 安装完成后，打开 ESP-IDF 5.4.1 Command Prompt

**方法二：手动安装**

```bash
# 克隆 ESP-IDF 仓库
git clone --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
git checkout v5.4.1
git submodule update --init --recursive

# 安装依赖
./install.sh esp32s3

# 设置环境变量
. ./export.sh
```

#### 3.1.2 安装 VSCode 和 ESP-IDF 插件

1. 安装 [Visual Studio Code](https://code.visualstudio.com/)
2. 打开 VSCode，进入扩展商店
3. 搜索并安装 "ESP-IDF" 插件
4. 配置 ESP-IDF 插件：
   - ESP-IDF 路径：指向 ESP-IDF 安装目录
   - ESP-IDF 版本：5.4.1

#### 3.1.3 硬件准备

- **开发板**: ESP32-S3 开发板
- **USB 数据线**: 支持 USB 2.0 的数据线
- **串口驱动**: CP210x 或 CH340 驱动（根据开发板型号）

### 3.2 配置项目

#### 3.2.1 打开项目

1. 打开 VSCode
2. 选择"文件" -> "打开文件夹"
3. 选择 `d:\sleep202603\firmware` 目录

#### 3.2.2 配置目标芯片

1. 按 `F1` 打开命令面板
2. 输入 "ESP-IDF: Set Target"
3. 选择 "ESP32-S3"

#### 3.2.3 配置项目参数

1. 按 `F1` 打开命令面板
2. 输入 "ESP-IDF: Configuration Menu"
3. 在配置菜单中修改以下参数：

**关键配置项：**

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `CONFIG_IDF_TARGET` | `ESP32-S3` | 目标芯片 |
| `CONFIG_ESPTOOLPY_BAUD` | `921600` | 串口波特率 |
| `CONFIG_ESPTOOLPY_FLASHSIZE` | `8MB` | Flash 大小 |
| `CONFIG_PARTITION_TABLE_SINGLE_APP` | `y` | 单分区表 |
| `CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ` | `240` | CPU 频率 |
| `CONFIG_SPIRAM` | `y` | 启用 PSRAM |
| `CONFIG_SPIRAM_MODE_OCT` | `y` | PSRAM 八线模式 |

### 3.3 编译固件

#### 3.3.1 使用 VSCode 编译

1. 按 `F1` 打开命令面板
2. 输入 "ESP-IDF: Build Project"
3. 等待编译完成

#### 3.3.2 使用命令行编译

```bash
# 进入项目目录
cd <repo-root>/firmware

# 设置 ESP-IDF 环境变量
. $HOME/esp/esp-idf/export.sh

# 编译项目
idf.py build
```

#### 3.3.3 编译产物

编译成功后，固件文件位于：

```
build/
├── firmware.bin          # 主固件
└── bootloader.bin        # 引导加载程序
```

### 3.4 烧录固件

#### 3.4.1 连接硬件

1. 使用 USB 数据线连接 ESP32-S3 开发板到电脑
2. 打开设备管理器，确认 COM 端口号（如 COM3）

#### 3.4.2 使用 VSCode 烧录

1. 按 `F1` 打开命令面板
2. 输入 "ESP-IDF: Flash Device"
3. 选择 COM 端口
4. 选择烧录波特率（推荐 921600）
5. 等待烧录完成

#### 3.4.3 使用命令行烧录

```bash
# 烧录固件
idf.py -p COM3 -b 921600 flash

# 烧录并监控输出
idf.py -p COM3 -b 921600 flash monitor
```

#### 3.4.4 烧录参数说明

| 参数 | 说明 | 推荐值 |
|------|------|--------|
| `-p` | 串口端口 | COM3 |
| `-b` | 烧录波特率 | 921600 |
| `flash` | 烧录固件 | - |
| `monitor` | 监控串口输出 | - |

### 3.5 监控和调试

#### 3.5.1 查看串口输出

**使用 VSCode:**
1. 按 `F1` 打开命令面板
2. 输入 "ESP-IDF: Open Monitor"
3. 选择 COM 端口

**使用命令行:**
```bash
idf.py -p COM3 monitor
```

#### 3.5.2 常用调试命令

```bash
# 清除 Flash 并烧录
idf.py -p COM3 erase-flash flash

# 烧录特定分区
idf.py -p COM3 partition_table flash

# 查看分区表
idf.py partition_table

# 查看项目配置
idf.py show-config

# 性能分析
idf.py performance-analysis
```

#### 3.5.3 日志级别

在代码中使用 `ESP_LOGx` 宏输出日志：

```c
ESP_LOGE(TAG, "错误信息");
ESP_LOGW(TAG, "警告信息");
ESP_LOGI(TAG, "一般信息");
ESP_LOGD(TAG, "调试信息");
ESP_LOGV(TAG, "详细信息");
```

### 3.6 OTA 升级

#### 3.6.1 配置 OTA

在 `sdkconfig.defaults` 中添加：

```ini
# OTA 配置
CONFIG_OTA_SUPPORT=y
CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y
CONFIG_BOOTLOADER_WDT_ENABLE=y
```

#### 3.6.2 实现 OTA 升级

固件端实现 OTA 升级逻辑：

```c
// OTA 升级示例
esp_err_t ota_update(const char *ota_url) {
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

#### 3.6.3 OTA 升级流程

1. 后端推送 OTA 升级通知到 MQTT 主题
2. 固件接收通知，下载新固件
3. 验证固件完整性
4. 写入新固件到 Flash
5. 重启设备

### 3.7 生产烧录

#### 3.7.1 批量烧录

使用 ESPTool 批量烧录：

```bash
# 批量烧录脚本
for port in COM3 COM4 COM5; do
    idf.py -p $port -b 921600 flash
done
```

#### 3.7.2 生成烧录文件

```bash
# 合并所有分区为单个 bin 文件
idf.py merge-bin

# 输出文件：build/firmware-combined.bin
```

#### 3.7.3 烧录记录

记录每次烧录的信息：

| 烧录日期 | 固件版本 | 设备序列号 | 烧录人员 | 备注 |
|----------|----------|------------|----------|------|
| 2024-01-01 | 1.0.0 | SN001 | 张三 | 首次烧录 |
| 2024-01-15 | 1.1.0 | SN001 | 张三 | OTA 升级 |

---

## 4. 常见问题

### 4.1 后端部署问题

#### Q1: Docker 服务启动失败

**问题**: `docker compose up -d` 报错

**解决方案**:
```bash
# 检查 Docker 状态
sudo systemctl status docker

# 重启 Docker
sudo systemctl restart docker

# 查看详细日志
docker compose logs
```

#### Q2: 数据库连接失败

**问题**: `Connection refused` 或 `Authentication failed`

**解决方案**:
```bash
# 检查 TimescaleDB 状态
docker compose ps timescaledb

# 检查数据库日志
docker compose logs timescaledb

# 验证连接
docker exec -it sleep-lamp-timescaledb psql -U hxt -d sleep_lamp
```

#### Q3: Redis 连接失败

**问题**: `Redis connection refused`

**解决方案**:
```bash
# 检查 Redis 状态
docker compose ps redis

# 测试 Redis 连接
docker exec -it sleep-lamp-redis redis-cli -a "${REDIS_PASSWORD}" PING
```

#### Q4: MQTT 连接失败

**问题**: `MQTT connection failed`

**解决方案**:
```bash
# 检查 EMQX 状态
docker compose ps emqx

# 访问 EMQX Dashboard
# http://localhost:18083

# 检查 MQTT 连接配置
# 确认 .env 中的 MQTT_BROKER_URL 正确
```

#### Q5: 端口被占用

**问题**: `Error: listen EADDRINUSE: address already in use :::3000`

**解决方案**:
```bash
# 查找占用端口的进程
netstat -ano | findstr :3000

# 杀死进程（Windows）
taskkill /PID <PID> /F

# 杀死进程（Linux/Mac）
kill -9 <PID>
```

### 4.2 小程序发布问题

#### Q1: 上传失败

**问题**: 微信开发者工具上传失败

**解决方案**:
1. 检查网络连接
2. 确认 AppID 正确
3. 清除缓存：工具 -> 清除缓存
4. 重新构建：`npm run build:weapp`

#### Q2: 审核被拒

**问题**: 小程序审核不通过

**解决方案**:
1. 仔细阅读审核反馈
2. 修改不符合规范的内容
3. 补充必要的资质证明
4. 重新提交审核

#### Q3: 真机调试失败

**问题**: 真机调试无法连接

**解决方案**:
1. 确保手机和电脑在同一网络
2. 检查防火墙设置
3. 重启微信开发者工具
4. 重新扫码连接

#### Q4: API 请求失败

**问题**: 小程序无法请求后端 API

**解决方案**:
1. 检查服务器域名配置
2. 确认后端服务正常运行
3. 检查网络连接
4. 查看控制台错误信息

### 4.3 固件烧录问题

#### Q1: 串口连接失败

**问题**: `Failed to connect to serial port`

**解决方案**:
1. 检查 USB 线是否连接
2. 安装正确的串口驱动
3. 确认 COM 端口号
4. 尝试降低波特率

#### Q2: 烧录超时

**问题**: `Timed out waiting for packet header`

**解决方案**:
1. 检查 USB 线质量
2. 降低烧录波特率（如 115200）
3. 按住开发板上的 BOOT 键再烧录
4. 尝试先擦除 Flash：`idf.py erase-flash`

#### Q3: 编译错误

**问题**: 编译过程中出现错误

**解决方案**:
```bash
# 清理构建文件
idf.py fullclean

# 重新配置
idf.py reconfigure

# 重新编译
idf.py build
```

#### Q4: 运行时崩溃

**问题**: 固件运行时重启或崩溃

**解决方案**:
1. 查看串口输出，定位错误
2. 检查内存使用情况
3. 检查栈溢出
4. 使用 GDB 调试

### 4.4 性能优化问题

#### Q1: 后端响应慢

**解决方案**:
1. 启用数据库索引
2. 使用 Redis 缓存
3. 优化 SQL 查询
4. 使用连接池

#### Q2: 小程序加载慢

**解决方案**:
1. 启用代码分包
2. 压缩图片资源
3. 使用 CDN 加速
4. 懒加载非关键资源

#### Q3: 固件功耗高

**解决方案**:
1. 使用低功耗模式
2. 降低 CPU 频率
3. 优化传感器采样频率
4. 使用深度睡眠

---

## 附录

### A. 环境变量清单

| 变量名 | 说明 | 默认值 | 必填 |
|--------|------|--------|------|
| PORT | 服务端口 | 3000 | 否 |
| NODE_ENV | 运行环境 | development | 否 |
| DATABASE_URL | 数据库连接字符串 | - | 是 |
| REDIS_HOST | Redis 主机 | localhost | 否 |
| REDIS_PORT | Redis 端口 | 6379（容器内）；根 Compose 暴露为宿主机 6380 | 否 |
| REDIS_PASSWORD | Redis 密码 | - | 否 |
| JWT_SECRET | JWT 密钥 | - | 是 |
| JWT_EXPIRES_IN | JWT 过期时间 | 2h | 否 |
| MQTT_BROKER_URL | MQTT Broker 地址 | - | 是 |
| WECHAT_APP_ID | 微信 AppID | - | 是 |
| WECHAT_APP_SECRET | 微信 AppSecret | - | 是 |

### B. 端口清单

| 服务 | 端口 | 协议 | 说明 |
|------|------|------|------|
| 后端 API | 3000 | HTTP | RESTful API |
| WebSocket | 3000 | WS | WebSocket 服务 |
| TimescaleDB | 5433 | TCP | PostgreSQL 数据库 |
| Redis | 6380 | TCP | Redis 缓存 |
| MQTT Broker | 1883 | TCP | MQTT 消息队列 |
| EMQX Dashboard | 18083 | HTTP | EMQX 管理界面 |

### C. 目录结构

部署相关主路径如下；完整 owner 与门禁以 `.harness/wiki/service-catalog.md` 为准：

- `backend/`：业务 API、Prisma 与后端容器配置。
- `services/`：遥测、实时处理、特征与 Agent 等独立服务。
- `platform/`：Kubernetes、Helm、Terraform、可观测性和验证资产。
- `src/`：Web/Capacitor 源码，构建产物写入根 `dist/`。
- `miniprogram/`：微信小程序源码与构建配置。
- `firmware/`：设备源码；当前无板级部署验证。
- `docker-compose.yml`：根本地依赖编排；`platform/local/` 提供企业组件本地编排。

`dist/`、`build/`、`data/` 和依赖目录是本地产物或运行状态，不是交付源码入口。

### D. 参考文档

- [ESP-IDF 编程指南](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/)
- [NestJS 文档](https://docs.nestjs.com/)
- [Taro 文档](https://taro-docs.jd.com/)
- [Prisma 文档](https://www.prisma.io/docs)
- [TimescaleDB 文档](https://docs.timescale.com/)
- [EMQX 文档](https://www.emqx.io/docs/)

---

**文档版本**: 1.0.0
**最后更新**: 2024-01-01
**维护者**: Backend Architect
