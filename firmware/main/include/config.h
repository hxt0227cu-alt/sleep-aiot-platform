/**
 * @file config.h
 * @brief 系统配置文件
 * @details 定义硬件引脚、通信参数、任务优先级等全局配置
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 * 
 * @par 修改记录:
 * <table>
 * <tr><th>日期 <th>版本 <th>作者 <th>描述
 * <tr><td>2024-01 <td>1.0.0 <td>团队 <td>初始版本
 * </table>
 */

#ifndef __CONFIG_H__
#define __CONFIG_H__

#include "esp_log.h"
#include "driver/gpio.h"
#include "driver/i2s.h"
#include "driver/uart.h"
#include "driver/adc.h"

#ifdef __cplusplus
extern "C" {
#endif

//=============================================================================
// 版本信息
//=============================================================================
#define FIRMWARE_VERSION_MAJOR      1           ///< 主版本号
#define FIRMWARE_VERSION_MINOR      0           ///< 次版本号
#define FIRMWARE_VERSION_PATCH      0           ///< 修订版本号
#define FIRMWARE_VERSION_STR        "1.0.0"     ///< 版本号字符串

//=============================================================================
// 调试配置
//=============================================================================
#define DEBUG_ENABLE                1           ///< 调试功能使能
#define DEBUG_SERIAL_BAUD           115200      ///< 调试串口波特率

#if DEBUG_ENABLE
  #define LOG_LEVEL                 3           ///< 日志级别: 0=ERROR, 1=WARN, 2=INFO, 3=DEBUG
  #define log_e(tag, format, ...)   ESP_LOGE(tag, format, ##__VA_ARGS__)
  #define log_w(tag, format, ...)   ESP_LOGW(tag, format, ##__VA_ARGS__)
  #define log_i(tag, format, ...)   ESP_LOGI(tag, format, ##__VA_ARGS__)
  #define log_d(tag, format, ...)   ESP_LOGD(tag, format, ##__VA_ARGS__)
#else
  #define LOG_LEVEL                 0
  #define log_e(tag, format, ...)
  #define log_w(tag, format, ...)
  #define log_i(tag, format, ...)
  #define log_d(tag, format, ...)
#endif

//=============================================================================
// 引脚定义 - R60ABD1 毫米波雷达 (UART2)
//=============================================================================
#define RADAR_UART_NUM              UART_NUM_2  ///< 雷达使用的UART端口
#define RADAR_UART_TX_PIN           GPIO_NUM_17 ///< 雷达UART发送引脚
#define RADAR_UART_RX_PIN           GPIO_NUM_18 ///< 雷达UART接收引脚
#define RADAR_UART_CTS_PIN          GPIO_NUM_19 ///< 雷达UART流控引脚
#define RADAR_UART_BAUD             115200      ///< 雷达串口波特率
#define RADAR_UART_BUF_SIZE         512         ///< 雷达串口缓冲区大小

//=============================================================================
// 引脚定义 - MAX98357A 音频功放 (I2S0)
//=============================================================================
#define AMP_I2S_NUM                 I2S_NUM_0   ///< 功放使用的I2S端口
#define AMP_I2S_BCLK_PIN            GPIO_NUM_7  ///< BCLK, netlist net BCLK/U1.7
#define AMP_I2S_WS_PIN              GPIO_NUM_15 ///< WS, shared with ICS-43434_WS/U1.8
#define AMP_I2S_SD_PIN              GPIO_NUM_6  ///< MAX98357 DIN, netlist DIN/U1.6
#define AMP_I2S_SAMPLE_RATE         44100       ///< I2S采样率
#define AMP_I2S_BITS_PER_SAMPLE     16          ///< I2S位深度
#define AMP_I2S_CHANNEL_NUM         2           ///< I2S通道数

//=============================================================================
// 引脚定义 - ICS-43434 麦克风 (I2S1)
//=============================================================================
#define MIC_I2S_NUM                 I2S_NUM_1   ///< 麦克风使用的I2S端口
#define MIC_I2S_SCK_PIN             GPIO_NUM_7  ///< BCLK, netlist net BCLK/U1.7
#define MIC_I2S_WS_PIN              GPIO_NUM_15 ///< WS, netlist ICS-43434_WS/U1.8
#define MIC_I2S_SD_PIN              GPIO_NUM_16 ///< SD, netlist ICS-43434_SD/U1.9
#define MIC_I2S_SAMPLE_RATE         16000       ///< 麦克风采样率(语音识别)
#define MIC_I2S_BITS_PER_SAMPLE     24          ///< 麦克风位深度
#define MIC_I2S_CHANNEL_NUM         1           ///< 麦克风通道数

//=============================================================================
// 引脚定义 - SIM800C GSM模块 (UART1)
//=============================================================================
#define GSM_UART_NUM                UART_NUM_1  ///< GSM使用的UART端口
#define GSM_UART_TX_PIN             GPIO_NUM_47 ///< ESP TX -> SIM800C_RXD, netlist U1.24
#define GSM_UART_RX_PIN             GPIO_NUM_46 ///< ESP RX <- SIM800C_TXD, netlist U1.16
#define GSM_PWR_PIN                 (-1)        ///< Optional; not present in current netlist
#define GSM_RST_PIN                 (-1)        ///< Optional; not present in current netlist
#define GSM_UART_BAUD               115200      ///< GSM串口波特率
#define GSM_UART_BUF_SIZE           512         ///< GSM串口缓冲区大小

//=============================================================================
// 引脚定义 - LED调光 (PWM)
//=============================================================================
#define LED_PWM_COLD_PIN            GPIO_NUM_2  ///< PWM_COLD, netlist U1.38
#define LED_PWM_WARM_PIN            GPIO_NUM_1  ///< PWM_WARM, netlist U1.39
#define LED_EN_PIN                  (-1)        ///< No LED enable net in Netlist_Schematic2_2026-04-24.tel
#define LED_PWM_FREQUENCY         5000        ///< PWM频率(Hz)
#define LED_PWM_RESOLUTION        10          ///< PWM分辨率(位)
#define LED_PWM_COLD_CHANNEL      0           ///< 冷色温PWM通道
#define LED_PWM_WARM_CHANNEL      1           ///< 暖色温PWM通道
#define LED_COLOR_TEMP_MIN        2700        ///< 最小色温(K)
#define LED_COLOR_TEMP_MAX        6500        ///< 最大色温(K)
#define LED_BRIGHTNESS_MIN        0           ///< 最小亮度
#define LED_BRIGHTNESS_MAX        100         ///< 最大亮度

//=============================================================================
// Potentiometer ADC inputs - Netlist_Schematic2_2026-04-24.tel
//=============================================================================
#define ADC_LIGHT_PIN               GPIO_NUM_5  ///< ADC_LIGHT, netlist U1.5
#define ADC_MUSIC_PIN               GPIO_NUM_4  ///< Reserved ADC input, netlist U1.4
#define ADC_LIGHT_CHANNEL           ADC1_CHANNEL_4
#define ADC_MUSIC_CHANNEL           ADC1_CHANNEL_3
#define POT_SAMPLE_INTERVAL_MS      120
#define POT_CHANGE_DEADBAND         2

//=============================================================================
// Capacitive touch inputs - Netlist_Schematic2_2026-04-24.tel
//=============================================================================
#define TOUCH_LIGHT_SCENE_PAD       9           ///< TOUCH9, GPIO9, light scene cycle
#define TOUCH_NOISE_RAIN_PAD        10          ///< TOUCH10, GPIO10
#define TOUCH_NOISE_WIND_PAD        11          ///< TOUCH11, GPIO11
#define TOUCH_NOISE_BIRD_PAD        12          ///< TOUCH12, GPIO12
#define TOUCH_NOISE_THUNDER_PAD     13          ///< TOUCH13, GPIO13
#define TOUCH_NOISE_STOP_PAD        14          ///< TOUCH14, GPIO14
#define TOUCH_SAMPLE_INTERVAL_MS    40
#define TOUCH_DEBOUNCE_MS           260
#define TOUCH_LONG_PRESS_MS         900
#define TOUCH_BASELINE_SETTLE_MS    300
#define TOUCH_BASELINE_SAMPLES      16
#define TOUCH_MIN_DELTA             120
#define TOUCH_VOLUME_STEP           10

//=============================================================================
// 引脚定义 - 负离子发生器
//=============================================================================
#define ANION_PWR_PIN               (-1)        ///< Optional; GPIO11 is TOUCH11 in current netlist

//=============================================================================
// White noise files in SPIFFS storage partition
//=============================================================================
#define WHITE_NOISE_BASE_PATH       "/storage/audio"
#define WHITE_NOISE_SAMPLE_RATE     22050
#define WHITE_NOISE_BITS_PER_SAMPLE 16
#define WHITE_NOISE_CHANNELS        1
#define WHITE_NOISE_CHUNK_FRAMES    512
#define WHITE_NOISE_DEFAULT_VOLUME  80
#define WHITE_NOISE_VOICE_DUCK_VOLUME 25

//=============================================================================
// 引脚定义 - 系统控制
//=============================================================================
#define BOOT_KEY_PIN                GPIO_NUM_0  ///< 启动按键引脚
#define STATUS_LED_PIN              (-1)        ///< Optional status LED, not present in current netlist
#define BUZZER_PIN                  (-1)        ///< Optional buzzer, not present in current netlist

//=============================================================================
// WiFi配置
//=============================================================================
#define WIFI_SSID_MAX_LEN           32          ///< WiFi SSID最大长度
#define WIFI_PASS_MAX_LEN           64          ///< WiFi密码最大长度
#define WIFI_CONNECT_TIMEOUT_MS     30000       ///< WiFi连接超时时间(ms)
#define WIFI_RECONNECT_INTERVAL_MS  5000        ///< WiFi重连间隔(ms)
#define WIFI_AP_SSID_PREFIX         "SleepLamp_"  ///< AP模式SSID前缀
#define WIFI_AP_PASSWORD            "12345678"  ///< AP模式密码
#define WIFI_AP_IP                  "192.168.4.1" ///< AP模式IP地址

//=============================================================================
// MQTT配置
//=============================================================================
#define MQTT_BROKER_HOST            "192.168.31.46"     ///< MQTT服务器地址
#define MQTT_BROKER_PORT            1883                ///< MQTT服务器端口
#define MQTT_CLIENT_ID_PREFIX       "sleep_lamp_"       ///< 客户端ID前缀
#define MQTT_USERNAME               ""                  ///< MQTT用户名
#define MQTT_PASSWORD               ""                  ///< MQTT密码
#define MQTT_KEEPALIVE_SEC          30                  ///< KeepAlive时间(s)
#define MQTT_CONNECT_TIMEOUT_MS     10000               ///< 连接超时(ms)
#define MQTT_RECONNECT_INTERVAL_MS  5000                ///< 重连间隔(ms)
#define MQTT_QOS                    1                   ///< QoS级别

// MQTT主题定义
#define MQTT_TOPIC_PREFIX           "device/"           ///< 主题前缀
#define MQTT_TOPIC_TELEMETRY        "/telemetry"          ///< 遥测数据主题
#define MQTT_TOPIC_COMMAND          "/command"          ///< 命令主题
#define MQTT_TOPIC_STATUS           "/status"           ///< 状态主题
#define MQTT_TOPIC_OTA              "/ota"                ///< OTA升级主题
#define MQTT_TOPIC_CONFIG           "/config"           ///< 配置主题

//=============================================================================
// FreeRTOS任务配置
//=============================================================================
#define TASK_PRIORITY_HIGHEST       10          ///< 最高优先级
#define TASK_PRIORITY_HIGH          8           ///< 高优先级
#define TASK_PRIORITY_NORMAL        5           ///< 正常优先级
#define TASK_PRIORITY_LOW           2           ///< 低优先级
#define TASK_PRIORITY_LOWEST        1           ///< 最低优先级

// 任务堆栈大小
#define TASK_STACK_SIZE_MAIN        8192        ///< 主任务堆栈大小
#define TASK_STACK_SIZE_WIFI        4096        ///< WiFi任务堆栈大小
#define TASK_STACK_SIZE_MQTT        4096        ///< MQTT任务堆栈大小
#define TASK_STACK_SIZE_RADAR       4096        ///< 雷达任务堆栈大小
#define TASK_STACK_SIZE_TELEMETRY   4096        ///< 遥测任务堆栈大小

// 任务延迟时间
#define TASK_DELAY_MS(ms)         vTaskDelay(pdMS_TO_TICKS(ms))

//=============================================================================
// OTA升级配置
//=============================================================================
#define OTA_SERVER_URL              "http://sleep-lamp.local:8080/firmware"  ///< OTA服务器地址
#define OTA_CHECK_INTERVAL_MS       3600000     ///< OTA检查间隔(ms), 默认1小时
#define OTA_RETRY_MAX             3           ///< OTA重试次数
#define OTA_CHUNK_SIZE            4096        ///< OTA下载分块大小
#define OTA_TIMEOUT_MS            300000      ///< OTA超时时间(ms), 5分钟

//=============================================================================
// 雷达数据采集配置
//=============================================================================
#define RADAR_SAMPLE_INTERVAL_MS    50          ///< 雷达采样间隔(ms), 20Hz
#define RADAR_DATA_BUFFER_SIZE      100         ///< 雷达数据缓冲区大小
#define RADAR_HEART_RATE_MIN        40          ///< 心率最小值
#define RADAR_HEART_RATE_MAX        180         ///< 心率最大值
#define RADAR_BREATHING_RATE_MIN    8           ///< 呼吸率最小值
#define RADAR_BREATHING_RATE_MAX    30          ///< 呼吸率最大值

//=============================================================================
// 遥测数据上报配置
//=============================================================================
#define TELEMETRY_INTERVAL_MS       5000        ///< 遥测数据上报间隔(ms), 默认5秒
#define TELEMETRY_BATCH_SIZE        10          ///< 遥测数据批量上报大小
#define TELEMETRY_BUFFER_SIZE       100         ///< 遥测数据缓冲区大小
#define TELEMETRY_MAX_RETRY         3           ///< 遥测数据最大重试次数

//=============================================================================
// 告警阈值配置
//=============================================================================
#define ALARM_HEART_RATE_LOW        50          ///< 心率过低阈值(bpm)
#define ALARM_HEART_RATE_HIGH       120         ///< 心率过高阈值(bpm)
#define ALARM_BREATHING_RATE_LOW    10          ///< 呼吸率过低阈值(次/分钟)
#define ALARM_BREATHING_RATE_HIGH   25          ///< 呼吸率过高阈值(次/分钟)
#define ALARM_NO_BREATHING_TIME_MS  20000       ///< 无呼吸告警时间(ms), 20秒

#ifdef __cplusplus
}
#endif

#endif /* __CONFIG_H__ */
