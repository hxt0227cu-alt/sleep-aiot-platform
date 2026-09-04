/**
 * @file radar_test_example.cpp
 * @brief R60ABD1雷达驱动测试示例
 * @details 演示如何初始化雷达、接收数据并在串口终端显示
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * 
 * 烧录方法：
 * 1. 使用PlatformIO上传固件
 * 2. 打开串口监视器（波特率：115200）
 * 3. 查看雷达数据输出
 */

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "radar_driver.h"
#include "config.h"

//=============================================================================
// 宏定义
//=============================================================================

#define TEST_TASK_STACK_SIZE    4096    // 测试任务堆栈大小
#define TEST_TASK_PRIORITY      2       // 测试任务优先级
#define DISPLAY_INTERVAL_MS     1000    // 数据显示间隔（1秒）

//=============================================================================
// 全局变量
//=============================================================================

static TaskHandle_t g_testTaskHandle = NULL;    // 测试任务句柄

// 数据存储
static volatile bool g_hasPresence = false;         // 是否有人
static volatile bool g_hasHeartRate = false;        // 是否有心率数据
static volatile bool g_hasBreathRate = false;       // 是否有呼吸数据
static volatile bool g_hasSleepState = false;       // 是否有睡眠状态

static volatile uint8_t g_heartRate = 0;            // 心率值
static volatile uint8_t g_breathRate = 0;           // 呼吸率
static volatile uint8_t g_sleepState = 0;           // 睡眠状态

static volatile uint32_t g_totalFrames = 0;         // 总帧数
static volatile uint32_t g_lastDisplayTime = 0;       // 上次显示时间

//=============================================================================
// 回调函数
//=============================================================================

/**
 * @brief 雷达数据回调函数
 * @param type 数据类型
 * @param data 数据指针
 * @param user_data 用户数据
 */
static void onRadarData(radar_data_type_t type, const radar_data_union_t* data, void* user_data) {
    (void)user_data;
    
    g_totalFrames++;
    
    switch (type) {
        case RADAR_DATA_TYPE_PRESENCE:
            g_hasPresence = (data->presence.presence == R60ABD1_PRESENCE_DETECTED);
            break;
            
        case RADAR_DATA_TYPE_HEART_RATE:
            g_hasHeartRate = true;
            g_heartRate = data->heart_rate.heart_rate;
            break;
            
        case RADAR_DATA_TYPE_BREATH_RATE:
            g_hasBreathRate = true;
            g_breathRate = data->breath_rate.breath_rate;
            break;
            
        case RADAR_DATA_TYPE_SLEEP_STATE:
            g_hasSleepState = true;
            g_sleepState = data->sleep_state.sleep_state;
            break;
            
        default:
            break;
    }
}

/**
 * @brief 雷达事件回调函数
 * @param state 雷达状态
 * @param error 错误码
 * @param user_data 用户数据
 */
static void onRadarEvent(radar_state_t state, radar_error_t error, void* user_data) {
    (void)user_data;
    
    const char* stateStr = "Unknown";
    switch (state) {
        case RADAR_STATE_UNINITIALIZED: stateStr = "Uninitialized"; break;
        case RADAR_STATE_INITIALIZED:     stateStr = "Initialized"; break;
        case RADAR_STATE_RUNNING:       stateStr = "Running"; break;
        case RADAR_STATE_STOPPED:       stateStr = "Stopped"; break;
        case RADAR_STATE_ERROR:         stateStr = "Error"; break;
    }
    
    Serial.printf("[雷达事件] 状态: %s, 错误码: %d\n", stateStr, error);
}

//=============================================================================
// 测试任务
//=============================================================================

/**
 * @brief 数据显示任务
 * @details 定期在串口终端显示雷达数据
 */
static void displayTask(void* pvParameters) {
    (void)pvParameters;
    
    Serial.println("\n========================================");
    Serial.println("   R60ABD1 雷达数据监视器");
    Serial.println("========================================\n");
    
    while (1) {
        uint32_t currentTime = millis();
        
        // 每秒显示一次数据
        if (currentTime - g_lastDisplayTime >= DISPLAY_INTERVAL_MS) {
            g_lastDisplayTime = currentTime;
            
            Serial.println("----------------------------------------");
            Serial.printf("总帧数: %d\n", g_totalFrames);
            Serial.printf("有人存在: %s\n", g_hasPresence ? "是" : "否");
            
            if (g_hasHeartRate) {
                Serial.printf("心率: %d BPM\n", g_heartRate);
            } else {
                Serial.println("心率: --");
            }
            
            if (g_hasBreathRate) {
                Serial.printf("呼吸率: %d 次/分钟\n", g_breathRate);
            } else {
                Serial.println("呼吸率: --");
            }
            
            if (g_hasSleepState) {
                const char* sleepStr = "未知";
                switch (g_sleepState) {
                    case R60ABD1_SLEEP_DEEP:  sleepStr = "深睡"; break;
                    case R60ABD1_SLEEP_LIGHT: sleepStr = "浅睡"; break;
                    case R60ABD1_SLEEP_AWAKE: sleepStr = "清醒"; break;
                    case R60ABD1_SLEEP_NONE:  sleepStr = "无"; break;
                }
                Serial.printf("睡眠状态: %s\n", sleepStr);
            } else {
                Serial.println("睡眠状态: --");
            }
            
            Serial.println("----------------------------------------\n");
        }
        
        vTaskDelay(pdMS_TO_TICKS(100)); // 100ms检查一次
    }
}

//=============================================================================
// Arduino 入口函数
//=============================================================================

void setup() {
    // 初始化串口
    Serial.begin(115200);
    while (!Serial) {
        ; // 等待串口就绪
    }
    
    delay(1000); // 等待串口稳定
    
    Serial.println("\n========================================");
    Serial.println("   R60ABD1 雷达驱动测试程序");
    Serial.println("   版本: 1.0.0");
    Serial.println("========================================\n");
    
    // 初始化雷达配置
    radar_config_t config = {
        .presence_enable = true,
        .breath_enable = true,
        .heart_rate_enable = true,
        .sleep_enable = true,
        .enable_raw_data = false,
        .enable_waveform = false,
        .low_breath_threshold = 10,
        .struggle_sensitivity = 1,
        .nobody_timeout = 30,
        .sleep_cutoff_time = 60,
        .data_timeout_ms = 5000
    };
    
    // 注册回调函数
    radar_register_data_callback(onRadarData, NULL);
    radar_register_event_callback(onRadarEvent, NULL);
    
    // 初始化雷达
    Serial.println("正在初始化雷达...");
    radar_error_t err = radar_init(&config);
    if (err != RADAR_ERR_NONE) {
        Serial.printf("雷达初始化失败! 错误码: %d\n", err);
        return;
    }
    Serial.println("雷达初始化成功!");
    
    // 启动雷达
    Serial.println("正在启动雷达数据采集...");
    err = radar_start();
    if (err != RADAR_ERR_NONE) {
        Serial.printf("雷达启动失败! 错误码: %d\n", err);
        return;
    }
    Serial.println("雷达数据采集已启动!");
    
    // 创建数据显示任务
    BaseType_t result = xTaskCreatePinnedToCore(
        displayTask,
        "DisplayTask",
        TEST_TASK_STACK_SIZE,
        NULL,
        TEST_TASK_PRIORITY,
        &g_testTaskHandle,
        0  // 在Core 0上运行
    );
    
    if (result != pdPASS) {
        Serial.println("创建显示任务失败!");
        return;
    }
    
    Serial.println("\n========================================");
    Serial.println("   系统启动完成!");
    Serial.println("   正在接收雷达数据...");
    Serial.println("========================================\n");
}

void loop() {
    // Arduino主循环
    // 实际工作由FreeRTOS任务处理
    vTaskDelay(pdMS_TO_TICKS(1000));
}
