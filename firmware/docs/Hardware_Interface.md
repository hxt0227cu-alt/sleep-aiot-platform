# 智能睡眠仪台灯 - 硬件接口定义文档

## 一、硬件引脚分配

### 1.1 ESP32-S3 引脚定义

| 外设 | 引脚 | 功能 | 说明 |
|------|------|------|------|
| **R60ABD1 雷达** | | | |
| UART TX | GPIO17 | 雷达数据发送 | UART2_TXD |
| UART RX | GPIO18 | 雷达数据接收 | UART2_RXD |
| UART CTS | GPIO19 | 流控 | UART2_CTS |
| **MAX98357A 功放** | | | |
| I2S BCLK | GPIO12 | I2S位时钟 | I2S_BCLK |
| I2S WS | GPIO13 | I2S字选择 | I2S_WS |
| I2S SD | GPIO14 | I2S数据 | I2S_SD |
| **ICS-43434 麦克风** | | | |
| I2S SCK | GPIO15 | I2S时钟 | I2S_SCK |
| I2S WS | GPIO16 | I2S字选择 | I2S_WS |
| I2S SD | GPIO35 | I2S数据 | I2S_SD |
| **SIM800C GSM模块** | | | |
| UART TX | GPIO4 | GSM数据发送 | UART1_TXD |
| UART RX | GPIO5 | GSM数据接收 | UART1_RXD |
| GSM PWR | GPIO6 | GSM电源控制 | GPIO_OUTPUT |
| GSM RST | GPIO7 | GSM复位 | GPIO_OUTPUT |
| **LED调光** | | | |
| PWM COLD | GPIO8 | 冷色温PWM | LEDC_PWM_CHANNEL |
| PWM WARM | GPIO9 | 暖色温PWM | LEDW_PWM_CHANNEL |
| LED EN | GPIO10 | LED使能 | GPIO_OUTPUT |
| **负离子发生器** | | | |
| ANION PWR | GPIO11 | 负离子电源 | GPIO_OUTPUT |
| **系统控制** | | | |
| BOOT KEY | GPIO0 | 启动按键 | GPIO_INPUT_PULLUP |
| STATUS LED | GPIO2 | 状态指示灯 | GPIO_OUTPUT |
| BUZZER | GPIO3 | 蜂鸣器 | GPIO_OUTPUT |

### 1.2 外设接口定义

```c
#define RADAR_UART_NUM      UART_NUM_2
#define RADAR_UART_TX_PIN  GPIO_NUM_17
#define RADAR_UART_RX_PIN  GPIO_NUM_18
#define RADAR_UART_BAUD    115200

#define GSM_UART_NUM        UART_NUM_1
#define GSM_UART_TX_PIN     GPIO_NUM_4
#define GSM_UART_RX_PIN     GPIO_NUM_5
#define GSM_UART_BAUD       115200
#define GSM_PWR_PIN         GPIO_NUM_6
#define GSM_RST_PIN         GPIO_NUM_7

#define AMP_I2S_BCLK_PIN   GPIO_NUM_12
#define AMP_I2S_WS_PIN     GPIO_NUM_13
#define AMP_I2S_SD_PIN     GPIO_NUM_14
#define AMP_I2S_SCK_PIN     GPIO_NUM_12
#define AMP_I2S_WS_PIN     GPIO_NUM_13
#define AMP_I2S_SD_PIN     GPIO_NUM_14

#define MIC_I2S_SCK_PIN    GPIO_NUM_15
#define MIC_I2S_WS_PIN     GPIO_NUM_16
#define MIC_I2S_SD_PIN     GPIO_NUM_35

#define LED_PWM_COLD_PIN   GPIO_NUM_8
#define LED_PWM_WARM_PIN   GPIO_NUM_9
#define LED_EN_PIN         GPIO_NUM_10

#define ANION_PWR_PIN       GPIO_NUM_11

#define BOOT_KEY_PIN        GPIO_NUM_0
#define STATUS_LED_PIN       GPIO_NUM_2
#define BUZZER_PIN          GPIO_NUM_3
```

---

## 二、R60ABD1 毫米波雷达接口

### 2.1 UART通信协议

**波特率**: 115200
**数据位**: 8
**停止位**: 1
**校验位**: None
**流控**: 硬件流控

### 2.2 数据帧格式

#### 帧头帧 (0xAA 0x55)

| 字节 | 说明 |
|------|------|
| 0xAA | 帧头起始符 |
| 0x55 | 帧头起始符 |

#### 数据帧结构

```
[0xAA][0x55][CMD][LEN][DATA...][CRC]
```

| 字段 | 长度 | 说明 |
|------|--------|------|
| 帧头 | 2字节 | 0xAA 0x55 |
| CMD | 1字节 | 命令类型 |
| LEN | 2字节 | 数据长度（小端） |
| DATA | LEN字节 | 数据内容 |
| CRC | 2字节 | CRC16校验 |

### 2.3 命令定义

| CMD | 值 | 说明 | 数据格式 |
|-----|------|------|----------|
| CMD_GET_HEART_RATE | 0x01 | 获取心率 | 无 |
| CMD_GET_BREATHING_RATE | 0x02 | 获取呼吸率 | 无 |
| CMD_GET_BODY_MOVEMENT | 0x03 | 获取体动 | 无 |
| CMD_GET_SLEEP_STATE | 0x04 | 获取睡眠状态 | 无 |
| CMD_SET_SAMPLING_RATE | 0x05 | 设置采样率 | 1字节 |
| CMD_SET_DETECTION_RANGE | 0x06 | 设置检测范围 | 4字节 |
| CMD_GET_FIRMWARE_VERSION | 0x07 | 获取固件版本 | 无 |
| CMD_RESET_DEVICE | 0x08 | 复位设备 | 无 |

### 2.4 数据格式示例

#### 心率数据响应

```
CMD: 0x01
LEN: 0x00 0x04
DATA: [0x48][0x00][0x00][[0x00]
      心率值: 72 bpm
      状态: 正常
      置信度: 0%
CRC: 0x12 0x34
```

#### 呼吸率数据响应

```
CMD: 0x02
LEN: 0x00 0x04
DATA: [0x10][0x00][0x00][0x00]
      呼吸率: 16 次/分钟
      状态: 正常
      置信度: 0%
CRC: 0x56 0x78
```

#### 睡眠状态响应

```
CMD: 0x04
LEN: 0x00 0x03
DATA: [0x02][0x92][0x00]
      状态: 浅睡 (0x02)
      置信度: 92%
      保留: 0x00
CRC: 0x9A 0xBC
```

**睡眠状态值**:

| 值 | 状态 | 说明 |
|------|--------|------|
| 0x00 | 清醒 | 用户清醒 |
| 0x01 | 浅睡 | 浅度睡眠 |
| 0x02 | 深睡 | 深度睡眠 |
| 0x03 | REM | 快速眼动 |

### 2.5 驱动接口函数

```c
typedef struct {
    uint8_t cmd;
    uint16_t len;
    uint8_t *data;
    uint16_t crc;
} radar_frame_t;

esp_err_t radar_init(void);
esp_err_t radar_get_heart_rate(uint16_t *rate, uint8_t *confidence);
esp_err_t radar_get_breathing_rate(uint8_t *rate, uint8_t *confidence);
esp_err_t radar_get_body_movement(float *movement, uint8_t *confidence);
esp_err_t radar_get_sleep_state(uint8_t *state, uint8_t *confidence);
esp_err_t radar_set_sampling_rate(uint8_t rate);
esp_err_t radar_reset(void);
```

---

## 三、MAX98357A 音频功放接口

### 3.1 I2S配置接口

| 参数 | 值 | 说明 |
|------|------|------|
| 采样率 | 44100 Hz | 标准音频采样率 |
| 位深度 | 16位 | I2S标准 |
| 通道数 | 2通道 | 立体声 |
| 增益 | 9dB / 12dB / 15dB | 可配置增益 |

### 3.2 I2S DMA配置

```c
#define I2S_SAMPLE_RATE     44100
#define I2S_BITS_PER_SAMPLE  16
#define I2S_DMA_BUF_COUNT   1024
#define I2S_DMA_BUF_LEN    (I2S_DMA_BUF_COUNT * 2)
```

### 3.3 音频格式

| 格式 | 说明 |
|------|------|
| PCM | 原始PCM数据 | I2S直接输出 |
| MP3 | MP3编码 | 需要编码库 |
| AAC | AAC编码 | 需要编码库 |

### 3.4 驱动接口函数

```c
typedef enum {
    AUDIO_FORMAT_PCM = 0,
    AUDIO_FORMAT_MP3 = 1,
    AUDIO_FORMAT_AAC = 2
} audio_format_t;

typedef struct {
    uint8_t *data;
    size_t len;
    audio_format_t format;
} audio_frame_t;

esp_err_t amp_init(void);
esp_err_t amp_set_gain(uint8_t gain);
esp_err_t amp_play(const uint8_t *data, size_t len);
esp_err_t amp_stop(void);
esp_err_t amp_set_volume(uint8_t volume);
esp_err_t amp_get_volume(uint8_t *volume);
```

---

## 四、ICS-43434 麦克风接口

### 4.1 I2S配置接口

| 参数 | 值 | 说明 |
|------|------|------|
| 采样率 | 16000 Hz | 语音识别采样率 |
| 位深度 | 24位 | I2S标准 |
| 通道数 | 1通道 | 单声道 |

### 4.2 I2S DMA配置

```c
#define MIC_I2S_SAMPLE_RATE  16000
#define MIC_I2S_BITS_PER_SAMPLE  24
#define MIC_I2S_DMA_BUF_COUNT   512
#define MIC_I2S_DMA_BUF_LEN    (MIC_I2S_DMA_BUF_COUNT * 3)
```

### 4.3 音频数据格式

| 格式 | 说明 |
|------|------|
| 原始PCM | I2S原始数据 | 24位PCM |
| 降采样PCM | 降采样到16位 | 语音识别输入 |
| 归一化PCM | 归一化处理 | 提高识别准确率 |

### 4.4 驱动接口函数

```c
typedef struct {
    int16_t *data;
    size_t len;
    int16 sample_rate;
} mic_frame_t;

esp_err_t mic_init(void);
esp_err_t mic_start(void);
esp_err_t mic_stop(void);
esp_err_t mic_read_frame(mic_frame_t *frame);
esp_err_t mic_set_gain(uint8_t gain);
```

---

## 五、SIM800C GSM模块接口

### 5.1 UART通信协议

**波特率**: 115200
**数据位**: 8
**停止位**: 1
**校验位**: None

### 5.2 AT指令集

| 指令 | 说明 | 响应 |
|------|------|------|
| AT | 测试指令 | OK |
| ATE | 回显关闭 | OK |
| AT+CMGS | 获取模块信息 | +CMGS: SIM800C |
| AT+CSQ | 信号质量查询 | +CSQ: 25,99 |
| AT+CREG | 网络注册 | +CREG: 1,"cmnet" |
| AT+CGATT | 附着GPRS | +CGATT: 1,"cmnet" |
| AT+CIPSTART | 启动IP连接 | OK |
| AT+CIPSEND | 发送数据 | SEND OK |
| AT+CIPCLOSE | 关闭IP连接 | OK |
| AT+CMGF | 发送短信 | +CMGF: 0 |
| AT+CMGS | 发送GSM短信 | +CMGS: 0 |
| AT+CMGR | 读取短信 | +CMGR: ... |
| AT+CMGD | 删除短信 | OK |
| AT+CLCC | 拨打电话 | OK |
| AT+CCLK | 获取时间 | +CCLK: ... |

### 5.3 短信发送接口

```c
typedef struct {
    char phone[20];
    char content[160];
    uint8_t encoding;
} sms_message_t;

esp_err_t gsm_init(void);
esp_err_t gsm_send_sms(const sms_message_t *msg);
esp_err_t gsm_read_sms(uint8_t index, char *content);
esp_err_t gsm_delete_sms(uint8_t index);
esp_err_t gsm_get_signal_quality(int8_t *rssi, int8_t *ber);
```

### 5.4 电话拨打接口

```c
typedef struct {
    char phone[20];
    uint8_t duration;
} call_info_t;

esp_err_t gsm_make_call(const call_info_t *call);
esp_err_t gsm_hangup_call(void);
esp_err_t gsm_get_call_status(uint8_t *status);
```

**通话状态**:

| 状态 | 说明 |
|------|------|
| 0 | 空闲 | 无通话 |
| 1 | 呼叫中 | 正在拨号 |
| 2 | 通话中 | 已接通 |
| 3 | 挂断中 | 正在挂断 |

---

## 六、LED调光接口

### 6.1 PWM配置

| 参数 | 冷色温 | 暖色温 |
|------|--------|--------|
| PWM频率 | 5000 Hz | 5000 Hz |
| PWM分辨率 | 10位 | 0-1023 |
| 占空比范围 | 0-100% | 0-100% |

### 6.2 色温控制原理

**双色温LED实现**：
- 冷色温LED (2700K-4500K)
- 暖色温LED (4500K-6500K)
- 通过调节两个LED的占空比实现色温调节

**色温计算公式**：

```
目标色温 = 冷色温 * (1 - ratio) + 暖色温 * ratio
ratio = (目标色温 - 冷色温) / (暖色温 - 冷色温)
```

### 6.3 驱动接口函数

```c
typedef struct {
    bool power;
    uint8_t brightness;
    uint16_t color_temp;
} light_state_t;

esp_err_t light_init(void);
esp_err_t light_set_power(bool power);
esp_err_t light_set_brightness(uint8_t brightness);
esp_err_t light_set_color_temp(uint16_t color_temp);
esp_err_t light_set_state(const light_state_t *state);
esp_err_t light_get_state(light_state_t *state);
esp_err_t light_fade_to(uint8_t target_brightness, uint16_t duration_ms);
```

### 6.4 预设场景

| 场景 | 亮度 | 色温 | 说明 |
|------|------|------|------|
| SCENE_READING | 80% | 4000K | 阅读模式 |
| SCENE_NIGHT | 10% | 2700K | 夜间模式 |
| SCENE_FOCUS | 90% | 5000K | 专注模式 |
| SCENE_RELAX | 50% | 3000K | 放松模式 |

---

## 七、负离子发生器接口

### 7.1 控制接口

| 参数 | 值 | 说明 |
|------|------|------|
| 控制方式 | GPIO输出 | 简单开关控制 |
| 工作电压 | 12V DC | 外部供电 |
| 工作电流 | 约200mA | 负离子模块功耗 |

### 7.2 驱动接口函数

```c
esp_err_t anion_init(void);
esp_err_t anion_set_power(bool power);
esp_err_t anion_get_power(bool *power);
esp_err_t anion_set_timer(uint16_t duration_sec);
esp_err_t anion_stop_timer(void);
```

---

## 八、系统控制接口

### 8.1 电源管理

| 功能 | 说明 |
|------|------|
| 深度睡眠 | 降低CPU频率，关闭不必要外设 |
| 浅度睡眠 | 降低CPU频率，保持WiFi连接 |
| 正常模式 | 全速运行 |
| 看门狗 | 监控系统运行，异常时复位 |

### 8.2 驱动接口函数

```c
typedef enum {
    POWER_MODE_DEEP = 0,
    POWER_MODE_LIGHT = 1,
    POWER_MODE_NORMAL = 2
} power_mode_t;

esp_err_t system_init(void);
esp_err_t system_set_power_mode(power_mode_t mode);
esp_err_t system_get_power_mode(power_mode_t *mode);
esp_err_t system_reboot(void);
esp_err_t system_factory_reset(void);
esp_err_t system_get_info(system_info_t *info);
```

### 8.3 系统信息结构

```c
typedef struct {
    char chip_id[32];
    char firmware_version[20];
    uint32_t uptime;
    uint32_t free_heap;
    uint8_t cpu_usage;
    uint8_t wifi_rssi;
} system_info_t;
```

---

## 九、通信协议定义

### 9.1 UART通信

```c
#define UART_BUF_SIZE      256
#define UART_TIMEOUT_MS   1000

typedef struct {
    uint8_t *buf;
    size_t len;
    size_t pos;
} uart_buffer_t;

esp_err_t uart_init(uart_port_t uart_num, uint32_t baud_rate);
esp_err_t uart_send(const uint8_t *data, size_t len);
esp_err_t uart_recv(uint8_t *data, size_t max_len, size_t *recv_len, uint32_t timeout_ms);
esp_err_t uart_flush(void);
```

### 9.2 WiFi管理

```c
typedef struct {
    char ssid[32];
    char password[64];
    uint8_t channel;
    wifi_auth_mode_t auth_mode;
} wifi_config_t;

typedef enum {
    WIFI_STATUS_DISCONNECTED = 0,
    WIFI_STATUS_CONNECTING = 1,
    WIFI_STATUS_CONNECTED = 2,
    WIFI_STATUS_AP_MODE = 3
} wifi_status_t;

esp_err_t wifi_init(void);
esp_err_t wifi_connect(const wifi_config_t *config);
esp_err_t wifi_disconnect(void);
esp_err_t wifi_get_status(wifi_status_t *status);
esp_err_t wifi_get_rssi(int8_t *rssi);
esp_err_t wifi_smartconfig_start(void);
esp_err_t wifi_smartconfig_stop(void);
```

### 9.3 MQTT客户端

```c
#define MQTT_BROKER_URL    "mqtt.sleep-lamp.com"
#define MQTT_BROKER_PORT    8883
#define MQTT_KEEPALIVE      30
#define MQTT_RECONNECT_DELAY  5000

typedef enum {
    MQTT_STATUS_DISCONNECTED = 0,
    MQTT_STATUS_CONNECTING = 1,
    MQTT_STATUS_CONNECTED = 2
} mqtt_status_t;

esp_err_t mqtt_init(const char *client_id, const char *username, const char *password);
esp_err_t mqtt_connect(void);
esp_err_t mqtt_disconnect(void);
esp_err_t mqtt_publish(const char *topic, const char *payload, uint8_t qos);
esp_err_t mqtt_subscribe(const char *topic, uint8_t qos);
esp_err_t mqtt_get_status(mqtt_status_t *status);
```

---

## 十、OTA升级接口

### 10.1 OTA配置

| 参数 | 值 | 说明 |
|------|------|------|
| OTA URL | HTTPS地址 | 固件下载地址 |
| 最大固件大小 | 2MB | ESP32-S3 Flash限制 |
| 校验方式 | MD5 | 固件完整性校验 |
| 重试次数 | 3次 | 下载失败重试 |

### 10.2 驱动接口函数

```c
typedef struct {
    char version[20];
    char url[256];
    uint32_t size;
    char md5[33];
} ota_config_t;

typedef enum {
    OTA_STATUS_IDLE = 0,
    OTA_STATUS_CHECKING = 1,
    OTA_STATUS_DOWNLOADING = 2,
    OTA_STATUS_VERIFYING = 3,
    OTA_STATUS_FLASHING = 4,
    OTA_STATUS_REBOOTING = 5,
    OTA_STATUS_SUCCESS = 6,
    OTA_STATUS_FAILED = 7
} ota_status_t;

esp_err_t ota_init(void);
esp_err_t ota_check_update(const char *current_version, ota_config_t *config);
esp_err_t ota_start_update(const ota_config_t *config);
esp_err_t ota_get_status(ota_status_t *status);
esp_err_t ota_get_progress(uint8_t *progress);
esp_err_t ota_abort(void);
```

---

## 十一、错误码定义

```c
#define ESP_OK                    0
#define ESP_ERR_NO_MEM            1
#define ESP_ERR_INVALID_ARG       2
#define ESP_ERR_INVALID_STATE     3
#define ESP_ERR_TIMEOUT           4
#define ESP_ERR_NOT_FOUND         5
#define ESP_ERR_NOT_SUPPORTED     6
#define ESP_ERR_BUSY             7
#define ESP_ERR_FAIL             8
#define ESP_ERR_INVALID_CRC       9
#define ESP_ERR_INVALID_RESPONSE  10
```

---

## 十二、硬件初始化流程

### 12.1 启动流程

```
系统启动
  │
  ├─> 初始化GPIO
  │     ├─> 配置输出引脚
  │     ├─> 配置输入引脚
  │     └─> 设置初始电平
  │
  ├─> 初始化UART
  │     ├─> 配置UART1 (GSM)
  │     ├─> 配置UART2 (雷达)
  │     └─> 配置中断
  │
  ├─> 初始化I2S
  │     ├─> 配置功放I2S
  │     ├─> 配置麦克风I2S
  │     └─> 配置DMA
  │
  ├─> 初始化PWM
  │     └─> 配置LED PWM
  │
  ├─> 初始化WiFi
  │     ├─> 加载WiFi配置
  │     └─> 连接WiFi
  │
  ├─> 初始化MQTT
  │     └─> 连接MQTT Broker
  │
  ├─> 初始化雷达
  │     └─> 启动数据采集
  │
  └─> 启动FreeRTOS任务
        ├─> 雷达数据采集任务
        ├─> 网络管理任务
        ├─> 设备控制任务
        └─> OTA升级任务
```

### 12.2 初始化顺序

| 顺序 | 模块 | 依赖 |
|------|--------|------|
| 1 | GPIO | 无基他依赖 |
| 2 | UART | GPIO |
| 3 | I2S | GPIO, UART |
| 4 | PWM | GPIO |
| 5 | WiFi | GPIO, UART |
| 6 | MQTT | WiFi |
| 7 | 雷达 | UART |
| 8 | 功放 | I2S |
| 9 | 麦克风 | I2S |
| 10 | GSM | UART |
| 11 | LED | PWM |
| 12 | 负离子 | GPIO |

---

## 十三、性能优化建议

### 13.1 内存优化

| 优化项 | 说明 |
|--------|------|
| 使用PSRAM | 启用外部PSRAM，存储音频数据 |
| DMA传输 | 使用DMA传输I2S数据，减少CPU占用 |
| 静态分配 | 避免频繁动态分配内存 |
| 内存池 | 使用内存池管理小块内存 |

### 13.2 任务优先级

| 任务 | 优先级 | 堆栈大小 | 说明 |
|------|--------|----------|------|
| 雷达采集 | 5 | 4KB | 高优先级，实时性要求高 |
| 网络络理 | 4 | 8KB | 高优先级，保证通信稳定 |
| 设备控制 | 3 | 4KB | 中优先级 |
| OTA升级 | 2 | 8KB | 低优先级，后台任务 |
| 数据上报 | 3 | 4KB | 中优先级 |

### 13.3 中断优化

| 外设 | 中断优先级 | 说明 |
|------|----------|------|
| 雷达UART | 高 | 保证数据不丢失 |
| GSM UART | 中 | GSM通信优先级较低 |
| I2S DMA | 高 | 音频数据实时性 |
| GPIO | 低 | 按键等低优先级 |

---

## 十四、调试接口

### 14.1 日志输出

```c
typedef enum {
    LOG_LEVEL_DEBUG = 0,
    LOG_LEVEL_INFO = 1,
    LOG_LEVEL_WARN = 2,
    LOG_LEVEL_ERROR = 3,
    LOG_LEVEL_FATAL = 4
} log_level_t;

void log_init(log_level_t level);
void log_print(log_level_t level, const char *tag, const char *fmt, ...);
#define LOGD(tag, fmt, ...) log_print(LOG_LEVEL_DEBUG, tag, fmt, ##__VA_ARGS__)
#define LOGI(tag, fmt, ...) log_print(LOG_LEVEL_INFO, tag, fmt, ##__VA_ARGS__)
#define LOGW(tag, fmt, ...) log_print(LOG_LEVEL_WARN, tag, fmt, ##__VA_ARGS__)
#define LOGE(tag, fmt, ...) log_print(LOG_LEVEL_ERROR, tag, fmt, ##__VA_ARGS__)
```

### 14.2 性能监控

```c
typedef struct {
    uint32_t heap_free;
    uint32_t heap_min_free;
    uint32_t cpu_usage;
    uint32_t task_count;
    uint32_t uptime;
} perf_stats_t;

void perf_init(void);
void perf_update(void);
void perf_get_stats(perf_stats_t *stats);
void perf_print_stats(void);
```

---

## 十五、附录

### 15.1 常用宏定义

```c
#define MIN(a, b)           ((a) < (b) ? (a) : (b))
#define MAX(a, b)           ((a) > (b) ? (a) : (b))
#define CLAMP(val, min, max)  ((val) < (min) ? (min) : ((val) > (max) ? (max) : (val)))
#define ARRAY_SIZE(arr)      (sizeof(arr) / sizeof(arr[0]))
#define TICKS_TO_MS(ticks)   ((ticks) * portTICK_PERIOD_MS)
#define MS_TO_TICKS(ms)      ((ms) / portTICK_PERIOD_MS)
```

### 15.2 单位转换

| 单位 | 转换公式 |
|------|----------|
| ms to ticks | ticks = ms / portTICK_PERIOD_MS |
| ticks to ms | ms = ticks * portTICK_PERIOD_MS |
| brightness to duty | duty = brightness * 1023 / 100 |
| duty to brightness | brightness = duty * 100 / 1023 |
| color_temp to ratio | ratio = (temp - 2700) / (6500 - 2700) |
