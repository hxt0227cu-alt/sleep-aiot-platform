/**
 * @file main.cpp
 * @brief ESP32-S3 智能睡眠监测台灯固件主程序
 * @details 固件主入口，负责系统初始化、任务调度和主循环
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 * 
 * @par 硬件平台:
 * - ESP32-S3-WROOM-1 (双核 240MHz, 8MB PSRAM)
 * 
 * @par 外设:
 * - R60ABD1 60GHz 毫米波雷达 (心率和呼吸检测)
 * - SIM800C GSM模块 (短信/电话告警)
 * - MAX98357A I2S 功放 (音频播放)
 * - ICS-43434 I2S 麦克风 (音频采集)
 * - 双色温LED灯 (PWM调光)
 * - 负离子发生器
 */

#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "sdkconfig.h"
#include "esp_system.h"
#include "esp_err.h"
#include "esp_flash.h"
#include "esp_chip_info.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_psram.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "cJSON.h"

#include "config.h"
#include "wifi_manager.h"
#include "mqtt_client.h"
#include "radar_driver.h"
#include "led_driver.h"
#include "audio_driver.h"
#include "data_report.h"
#include "light_control.h"
#include "alarm_service.h"
#include "ota_service.h"
#include "app_sleep.h"
#include "potentiometer_driver.h"
#include "microphone_driver.h"
#include "local_voice_command.h"
#include "provisioning_service.h"
#include "white_noise_player.h"
#include "touch_control.h"

static const char* TAG = "MAIN";

typedef struct {
    char command[64];
    char payload[MQTT_MAX_PAYLOAD_LEN + 1];
    char command_id[64];
} queued_command_t;

//=============================================================================
// 前置声明 - 任务函数
//=============================================================================
static void mainTask(void *pvParameters);
static void wifiTask(void *pvParameters);
static void mqttTask(void *pvParameters);
static void radarTask(void *pvParameters);
static void telemetryTask(void *pvParameters);
static void commandTask(void *pvParameters);
static void voiceTask(void *pvParameters);

//=============================================================================
// 前置声明 - 系统初始化函数
//=============================================================================
static bool systemInit(void);
static bool nvsInit(void);
static bool gpioInit(void);
static bool serialInit(void);
static bool createTasks(void);
static void enterSafeMode(const char* reason);

//=============================================================================
// 前置声明 - 工具函数
//=============================================================================
static void printSystemInfo(void);
static void printResetReason(void);
static void watchdogInit(void);
static void feedWatchdog(void);
static void radarDataCallback(radar_data_type_t type, const radar_data_union_t* data, void* user_data);
static void mqttEventCallback(mqtt_event_t event, void* data, void* user_data);
static void potentiometerChangedCallback(const potentiometer_state_t* state, void* user_data);
static void voiceCommandCallback(const char* command, const char* params_json, void* user_data);
static void voiceEventCallback(local_voice_event_t event, const char* detail, void* user_data);
static void touchControlCallback(const touch_control_event_t* event, void* user_data);
static void applyTouchLightScene(uint8_t scene_index);
static bool processCommand(const char* command, const char* payload);
static bool processAudioCommand(const char* payload);
static bool processVoiceQueryCommand(const char* payload);
static int buildTelemetryJson(char* buffer, size_t buffer_size);
static void getDeviceId(char* buffer, size_t buffer_size);
static void buildDeviceTopic(char* buffer, size_t buffer_size, const char* suffix);
static bool extractCommandFromMessage(const mqtt_message_t* msg, queued_command_t* out);
static bool handleVoiceQueryResponse(const mqtt_message_t* msg);
static bool publishVoiceQueryRequest(
    const char* query,
    const char* query_type,
    const char* report_date,
    const char* source
);
static void publishCommandResponse(const char* command_id, const char* command, bool success, const char* message);
static void publishDeviceStatus(void);
static void setVoiceError(const char* message);

//=============================================================================
// 全局变量
//=============================================================================

// 系统状态
volatile bool g_systemReady = false;
volatile bool g_wifiConnected = false;
volatile bool g_mqttConnected = false;
volatile bool g_radarReady = false;
volatile bool g_dataReportReady = false;
volatile bool g_lightControlReady = false;
volatile bool g_alarmServiceReady = false;
volatile bool g_potentiometerReady = false;
volatile bool g_voiceReady = false;
volatile bool g_audioReady = false;
volatile bool g_touchReady = false;
static char g_lightSource[16] = "boot";
static char g_audioSource[16] = "boot";
static bool g_voiceAudioDucked = false;
static char g_voiceError[96] = "";
static char g_voiceQueryStatus[24] = "idle";
static char g_voiceQueryText[128] = "";
static char g_voiceQueryDate[16] = "";
static char g_voiceQueryAnswer[256] = "";
static uint64_t g_voiceQueryUpdatedAt = 0;

// 任务句柄
static TaskHandle_t g_mainTaskHandle = NULL;
static TaskHandle_t g_wifiTaskHandle = NULL;
static TaskHandle_t g_mqttTaskHandle = NULL;
static TaskHandle_t g_radarTaskHandle = NULL;
static TaskHandle_t g_telemetryTaskHandle = NULL;
static TaskHandle_t g_commandTaskHandle = NULL;
static TaskHandle_t g_voiceTaskHandle = NULL;

// 队列和信号量
static SemaphoreHandle_t g_i2cMutex = NULL;
static SemaphoreHandle_t g_spiMutex = NULL;
static QueueHandle_t g_commandQueue = NULL;
static QueueHandle_t g_telemetryQueue = NULL;

// 看门狗句柄
static esp_task_wdt_user_handle_t g_wdtHandle = NULL;

//=============================================================================
// ESP-IDF 入口函数
//=============================================================================

/**
 * @brief ESP-IDF 应用主入口
 * @details 系统启动后首先执行，完成硬件初始化和任务创建
 */
extern "C" void app_main(void) {
    // 初始化串口（用于早期日志输出）
    serialInit();
    
    ESP_LOGI(TAG, "============================================");
    ESP_LOGI(TAG, "   智能睡眠监测台灯固件 v%s", FIRMWARE_VERSION_STR);
    ESP_LOGI(TAG, "============================================");
    
    // 打印系统信息
    printSystemInfo();
    printResetReason();
    
    // 初始化看门狗
    watchdogInit();
    
    // 系统初始化
    if (!systemInit()) {
        ESP_LOGE(TAG, "系统初始化失败，进入安全模式");
        enterSafeMode("系统初始化失败");
        return;
    }
    
    // 创建任务
    if (!createTasks()) {
        ESP_LOGE(TAG, "任务创建失败，进入安全模式");
        enterSafeMode("任务创建失败");
        return;
    }
    
    g_systemReady = true;
    ESP_LOGI(TAG, "系统初始化完成，所有任务已启动");
    ESP_LOGI(TAG, "============================================");
    
    // 主循环不做具体工作，由 FreeRTOS 任务处理
    for (;;) {
        feedWatchdog();
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

//=============================================================================
// 系统初始化函数实现
//=============================================================================

/**
 * @brief 系统初始化
 * @return true 初始化成功, false 初始化失败
 */
static bool systemInit(void) {
    if (!nvsInit()) {
        ESP_LOGE(TAG, "NVS initialization failed");
        return false;
    }
    ESP_LOGI(TAG, "开始系统初始化...");
    
    // GPIO 初始化
    if (!gpioInit()) {
        ESP_LOGE(TAG, "GPIO初始化失败");
        return false;
    }
    
    // 创建同步原语
    g_i2cMutex = xSemaphoreCreateMutex();
    g_spiMutex = xSemaphoreCreateMutex();
    
    if (g_i2cMutex == NULL || g_spiMutex == NULL) {
        ESP_LOGE(TAG, "互斥锁创建失败");
        return false;
    }
    
    // 创建队列
    g_commandQueue = xQueueCreate(10, sizeof(queued_command_t));
    g_telemetryQueue = xQueueCreate(50, sizeof(uint32_t));

    if (!provisioning_service_init()) {
        ESP_LOGE(TAG, "Provisioning service init failed");
        return false;
    }

    if (!wifi_manager_init()) {
        ESP_LOGE(TAG, "Early WiFi manager init failed");
        return false;
    }

    if (g_commandQueue == NULL || g_telemetryQueue == NULL) {
        ESP_LOGE(TAG, "队列创建失败");
        return false;
    }
    
    // 初始化数据上报服务
    if (data_report_init(NULL) != DATA_REPORT_ERR_NONE) {
        ESP_LOGE(TAG, "数据上报服务初始化失败");
        return false;
    }
    if (data_report_start() != DATA_REPORT_ERR_NONE) {
        ESP_LOGE(TAG, "数据上报服务启动失败");
        return false;
    }
    g_dataReportReady = true;
    
    // 初始化灯光控制服务
    if (light_control_init() != LIGHT_ERR_NONE) {
        ESP_LOGE(TAG, "灯光控制服务初始化失败");
        return false;
    }
    g_lightControlReady = true;

    if (white_noise_player_init()) {
        g_audioReady = true;
    } else {
        ESP_LOGW(TAG, "White noise player init failed; audio commands will be unavailable");
    }

    potentiometer_driver_set_callback(potentiometerChangedCallback, NULL);
    if (!potentiometer_driver_init() || !potentiometer_driver_start()) {
        ESP_LOGE(TAG, "Potentiometer driver init/start failed");
        return false;
    }
    g_potentiometerReady = true;

    touch_control_set_event_callback(touchControlCallback, NULL);
    if (touch_control_init() && touch_control_start()) {
        g_touchReady = true;
    } else {
        ESP_LOGW(TAG, "Touch control init/start failed");
    }

    // 初始化报警服务
    if (alarm_service_init(NULL) != ALARM_ERR_NONE) {
        ESP_LOGE(TAG, "报警服务初始化失败");
        return false;
    }
    g_alarmServiceReady = true;
    
    // 初始化OTA服务
    if (ota_service_init(NULL) != OTA_ERR_NONE) {
        ESP_LOGE(TAG, "OTA服务初始化失败");
        return false;
    }

    if (app_sleep_init(NULL) != APP_SLEEP_ERR_NONE) {
        ESP_LOGE(TAG, "睡眠监测应用初始化失败");
        return false;
    }

    if (app_sleep_start() != APP_SLEEP_ERR_NONE) {
        ESP_LOGE(TAG, "睡眠监测应用启动失败");
        return false;
    }

    ESP_LOGI(TAG, "系统初始化完成");
    return true;
}

/**
 * @brief GPIO 初始化
 * @return true 初始化成功, false 初始化失败
 */
static bool nvsInit(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS needs erase/reinit: %s", esp_err_to_name(err));
        ESP_ERROR_CHECK_WITHOUT_ABORT(nvs_flash_erase());
        err = nvs_flash_init();
    }

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_flash_init failed: %s", esp_err_to_name(err));
        return false;
    }

    ESP_LOGI(TAG, "NVS initialized");
    return true;
}

static bool gpioInit(void) {
    ESP_LOGI(TAG, "初始化GPIO...");
    
    // 配置GPIO
    gpio_config_t io_conf = {};
    
    // 状态指示灯 - 输出
    io_conf.intr_type = GPIO_INTR_DISABLE;
#if STATUS_LED_PIN >= 0
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pin_bit_mask = (1ULL << STATUS_LED_PIN);
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    gpio_config(&io_conf);
    gpio_set_level(STATUS_LED_PIN, 1);
#endif
    
    // 蜂鸣器 - 输出
#if BUZZER_PIN >= 0
    io_conf.pin_bit_mask = (1ULL << BUZZER_PIN);
    gpio_config(&io_conf);
    gpio_set_level(BUZZER_PIN, 0);
#endif
    
    // LED使能引脚 - 输出
#if LED_EN_PIN >= 0
    io_conf.pin_bit_mask = (1ULL << LED_EN_PIN);
    gpio_config(&io_conf);
    gpio_set_level(LED_EN_PIN, 0);
#endif
    
    // 负离子发生器 - 输出
#if ANION_PWR_PIN >= 0
    io_conf.pin_bit_mask = (1ULL << ANION_PWR_PIN);
    gpio_config(&io_conf);
    gpio_set_level(ANION_PWR_PIN, 0);  // 默认关闭
    
    // GSM电源控制 - 输出
#endif
#if GSM_PWR_PIN >= 0
    io_conf.pin_bit_mask = (1ULL << GSM_PWR_PIN);
    gpio_config(&io_conf);
    gpio_set_level(GSM_PWR_PIN, 0);
    
    // GSM复位 - 输出
#endif
#if GSM_RST_PIN >= 0
    io_conf.pin_bit_mask = (1ULL << GSM_RST_PIN);
    gpio_config(&io_conf);
    gpio_set_level(GSM_RST_PIN, 1);  // 默认不复位
    
    // 启动按键 - 输入，带上拉
#endif
    io_conf.mode = GPIO_MODE_INPUT;
    io_conf.pin_bit_mask = (1ULL << BOOT_KEY_PIN);
    io_conf.pull_up_en = GPIO_PULLUP_ENABLE;
    gpio_config(&io_conf);
    
    ESP_LOGI(TAG, "GPIO初始化完成");
    return true;
}

/**
 * @brief 串口初始化
 * @return true 初始化成功, false 初始化失败
 */
static bool serialInit(void) {
    // ESP-IDF 默认已初始化串口，这里可以配置额外的串口
    return true;
}

//=============================================================================
// 任务创建函数实现
//=============================================================================

/**
 * @brief 创建所有 FreeRTOS 任务
 * @return true 创建成功, false 创建失败
 */
static bool createTasks(void) {
    ESP_LOGI(TAG, "创建FreeRTOS任务...");
    
    BaseType_t result;
    
    // 主任务 - 高优先级
    result = xTaskCreatePinnedToCore(
        mainTask,
        "MainTask",
        TASK_STACK_SIZE_MAIN,
        NULL,
        TASK_PRIORITY_HIGH,
        &g_mainTaskHandle,
        1  // 在Core 1上运行
    );
    if (result != pdPASS) {
        ESP_LOGE(TAG, "主任务创建失败");
        return false;
    }
    
    // WiFi任务 - 高优先级
    result = xTaskCreatePinnedToCore(
        wifiTask,
        "WiFiTask",
        TASK_STACK_SIZE_WIFI,
        NULL,
        TASK_PRIORITY_HIGH,
        &g_wifiTaskHandle,
        0  // 在Core 0上运行
    );
    if (result != pdPASS) {
        ESP_LOGE(TAG, "WiFi任务创建失败");
        return false;
    }
    
    // MQTT任务 - 正常优先级
    result = xTaskCreatePinnedToCore(
        mqttTask,
        "MQTTTask",
        TASK_STACK_SIZE_MQTT,
        NULL,
        TASK_PRIORITY_NORMAL,
        &g_mqttTaskHandle,
        1
    );
    if (result != pdPASS) {
        ESP_LOGE(TAG, "MQTT任务创建失败");
        return false;
    }
    
    // 雷达任务 - 高优先级（实时性要求高）
    result = xTaskCreatePinnedToCore(
        radarTask,
        "RadarTask",
        TASK_STACK_SIZE_RADAR,
        NULL,
        TASK_PRIORITY_HIGH,
        &g_radarTaskHandle,
        1
    );
    if (result != pdPASS) {
        ESP_LOGE(TAG, "雷达任务创建失败");
        return false;
    }
    
    // 遥测任务 - 低优先级
    result = xTaskCreatePinnedToCore(
        telemetryTask,
        "TelemetryTask",
        TASK_STACK_SIZE_TELEMETRY,
        NULL,
        TASK_PRIORITY_LOW,
        &g_telemetryTaskHandle,
        0
    );
    if (result != pdPASS) {
        ESP_LOGE(TAG, "遥测任务创建失败");
        return false;
    }
    
    // 命令处理任务 - 正常优先级
    result = xTaskCreatePinnedToCore(
        commandTask,
        "CommandTask",
        TASK_STACK_SIZE_MAIN / 2,
        NULL,
        TASK_PRIORITY_NORMAL,
        &g_commandTaskHandle,
        0
    );
    if (result != pdPASS) {
        ESP_LOGE(TAG, "命令任务创建失败");
        return false;
    }

    result = xTaskCreatePinnedToCore(
        voiceTask,
        "VoiceTask",
        4096,
        NULL,
        TASK_PRIORITY_LOW,
        &g_voiceTaskHandle,
        0
    );
    if (result != pdPASS) {
        ESP_LOGE(TAG, "语音任务创建失败");
        return false;
    }
    
    ESP_LOGI(TAG, "所有任务创建成功，共8个任务");
    return true;
}

//=============================================================================
// 任务函数实现 - 占位符
//=============================================================================

/**
 * @brief 主任务
 * @details 负责系统状态监控、看门狗喂养和任务间协调
 */
static void mainTask(void *pvParameters) {
    ESP_LOGI(TAG, "主任务启动");
    
    TickType_t xLastWakeTime = xTaskGetTickCount();
    const TickType_t xFrequency = pdMS_TO_TICKS(1000);  // 1秒周期
    
    for (;;) {
        // 周期性执行
        vTaskDelayUntil(&xLastWakeTime, xFrequency);
        
        // 喂看门狗
        feedWatchdog();

        static uint32_t bootKeyPressedMs = 0;
        static bool provisioningLongPressHandled = false;
        if (gpio_get_level(BOOT_KEY_PIN) == 0) {
            bootKeyPressedMs += 1000;
            if (!provisioningLongPressHandled && bootKeyPressedMs >= 5000) {
                provisioningLongPressHandled = true;
                ESP_LOGW(TAG, "BOOT key held for 5s: clear WiFi config and enter provisioning mode");
                wifi_manager_clear_config();
                provisioning_service_clear_bind_token();
                provisioning_service_start(PROVISIONING_REASON_BUTTON_RESET);
            }
        } else {
            bootKeyPressedMs = 0;
            provisioningLongPressHandled = false;
        }
        
        // 打印系统状态（每每30秒）
        static uint32_t statusCounter = 0;
        if (++statusCounter >= 30) {
            statusCounter = 0;
            ESP_LOGI(TAG, "系统状态 - WiFi:%s MQTT:%s 雷达:%s 堆栈:%d",
                  g_wifiConnected ? "OK" : "NG",
                  g_mqttConnected ? "OK" : "NG",
                  g_radarReady ? "OK" : "NG",
                  uxTaskGetStackHighWaterMark(NULL));
        }
        
        // 状态指示灯闪烁
        static bool ledState = false;
        ledState = !ledState;
#if STATUS_LED_PIN >= 0
        gpio_set_level(STATUS_LED_PIN, ledState ? 1 : 0);
#endif
    }
}

/**
 * @brief WiFi任务
 * @details 负责WiFi连接管理和重连
 */
static void wifiTask(void *pvParameters) {
    ESP_LOGI(TAG, "WiFi任务启动");
    
    // 初始化WiFi管理器
    if (!wifi_manager_init()) {
        ESP_LOGE(TAG, "WiFi管理器初始化失败");
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    }
    
    // 尝试连接保存的WiFi配置
    if (wifi_manager_load_config()) {
        ESP_LOGI(TAG, "尝试连接保存的WiFi...");
        for (int attempt = 1; attempt <= 5 && !g_wifiConnected; ++attempt) {
            ESP_LOGI(TAG, "Saved WiFi connect attempt %d/5", attempt);
            if (wifi_manager_connect(NULL, NULL, WIFI_CONNECT_TIMEOUT_MS)) {
                g_wifiConnected = true;
                ESP_LOGI(TAG, "WiFi连接成功");
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(1500));
        }
        if (!g_wifiConnected) {
            ESP_LOGW(TAG, "Saved WiFi connect failed, entering BLE/SoftAP provisioning and SmartConfig fallback");
            provisioning_service_start(PROVISIONING_REASON_WIFI_FAILED);
            wifi_manager_start_smartconfig(SMARTCONFIG_TIMEOUT_MS);
        }
    } else {
        ESP_LOGI(TAG, "No saved WiFi config, entering BLE/SoftAP provisioning and SmartConfig fallback");
        provisioning_service_start(PROVISIONING_REASON_BOOT_NO_WIFI);
        wifi_manager_start_smartconfig(SMARTCONFIG_TIMEOUT_MS);
    }
    
    // WiFi状态监控循环
    for (;;) {
        if (wifi_manager_is_connected()) {
            g_wifiConnected = true;
        } else {
            g_wifiConnected = false;
            
            // 尝试重连
            if (wifi_manager_load_config()) {
                ESP_LOGI(TAG, "尝试重连WiFi...");
                if (wifi_manager_connect(NULL, NULL, WIFI_CONNECT_TIMEOUT_MS)) {
                    g_wifiConnected = true;
                }
            } else if (!provisioning_service_is_running()) {
                provisioning_service_start(PROVISIONING_REASON_BOOT_NO_WIFI);
            }
        }
        
        vTaskDelay(pdMS_TO_TICKS(WIFI_RECONNECT_INTERVAL_MS));
    }
}

/**
 * @brief MQTT任务
 * @details 负责MQTT连接、消息订阅和发布
 */
static void mqttTask(void *pvParameters) {
    ESP_LOGI(TAG, "MQTT任务启动");
    
    // 等待WiFi连接
    while (!g_wifiConnected) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    
    // 初始化MQTT配置
    mqtt_config_t mqttConfig;
    memset(&mqttConfig, 0, sizeof(mqttConfig));
    strncpy(mqttConfig.broker_host, MQTT_BROKER_HOST, sizeof(mqttConfig.broker_host) - 1);
    mqttConfig.broker_port = MQTT_BROKER_PORT;
    strncpy(mqttConfig.username, MQTT_USERNAME, sizeof(mqttConfig.username) - 1);
    strncpy(mqttConfig.password, MQTT_PASSWORD, sizeof(mqttConfig.password) - 1);
    mqttConfig.keepalive_seconds = MQTT_KEEPALIVE_SEC;
    mqttConfig.clean_session = true;
    getDeviceId(mqttConfig.client_id, sizeof(mqttConfig.client_id));
    
    // 初始化MQTT客户端
    if (!mqtt_client_init(&mqttConfig)) {
        ESP_LOGE(TAG, "MQTT客户端初始化失败");
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    }
    
    // 启动MQTT任务
    if (!mqtt_client_start_task()) {
        ESP_LOGE(TAG, "启动MQTT任务失败");
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    }
    
    // 连接MQTT
    while (!mqtt_client_connect(MQTT_CONNECT_TIMEOUT_MS)) {
        ESP_LOGE(TAG, "MQTT连接失败，5秒后重试: %s", mqtt_client_get_last_error());
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
    
    g_mqttConnected = true;
    ESP_LOGI(TAG, "MQTT任务已启动");
    
    // MQTT主循环
    for (;;) {
        if (mqtt_client_is_connected()) {
            g_mqttConnected = true;
        } else {
            g_mqttConnected = false;
            
            // 尝试重连
            ESP_LOGW(TAG, "MQTT断开，尝试重连...");
            if (mqtt_client_reconnect()) {
                g_mqttConnected = true;
                ESP_LOGI(TAG, "MQTT重连成功");
            } else {
                ESP_LOGE(TAG, "MQTT重连失败: %s", mqtt_client_get_last_error());
            }
        }
        
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

/**
 * @brief 本地语音任务
 * @details 等待系统资源趋于稳定后再加载ESP-SR，避免启动期抢占WiFi内部RAM
 */
static void voiceTask(void *pvParameters) {
    (void)pvParameters;
    ESP_LOGI(TAG, "语音任务等待系统稳定后启动");

    uint32_t waited_ms = 0;
    while (!g_wifiConnected && waited_ms < 15000) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        waited_ms += 1000;
    }

    if (g_wifiConnected) {
        ESP_LOGI(TAG, "WiFi ready after %lu ms, continue local voice init", (unsigned long)waited_ms);
    } else {
        ESP_LOGW(TAG, "WiFi still offline after %lu ms, continue local voice init anyway", (unsigned long)waited_ms);
    }

    vTaskDelay(pdMS_TO_TICKS(1000));

    ESP_LOGI(TAG, "开始初始化本地ESP-SR语音命令");
    if (local_voice_command_init()) {
        local_voice_command_set_callback(voiceCommandCallback, NULL);
        local_voice_command_set_event_callback(voiceEventCallback, NULL);
        mic_config_t mic_config = {};
        mic_config.mode = MIC_MODE_HPM;
        mic_config.sample_rate = MIC_SAMPLE_RATE_HPM;
        mic_config.bits_per_sample = MIC_BITS_PER_SAMPLE;
        mic_config.channels = MIC_CHANNEL_NUM;
        mic_config.buffer_size = MIC_BUFFER_SIZE;
        mic_config.enable_noise_gate = true;
        mic_config.noise_gate_threshold = 10;
        mic_config.enable_high_pass = true;
        if (microphone_init(&mic_config) == MIC_ERR_NONE) {
            microphone_set_data_callback(local_voice_command_mic_callback, NULL);
            if (microphone_start() == MIC_ERR_NONE) {
                g_voiceReady = true;
                setVoiceError("");
                ESP_LOGI(TAG, "本地ESP-SR语音命令已启动");
            } else {
                setVoiceError("microphone_start_failed");
                ESP_LOGW(TAG, "Local voice microphone start failed; MQTT/manual control still active");
            }
        } else {
            setVoiceError("microphone_init_failed");
            ESP_LOGW(TAG, "Local voice microphone init failed; MQTT/manual control still active");
        }
    } else {
        char voice_error[sizeof(g_voiceError)] = "";
        local_voice_command_get_last_error(voice_error, sizeof(voice_error));
        setVoiceError(voice_error[0] != '\0' ? voice_error : "local_voice_init_failed");
        ESP_LOGW(TAG, "Local voice command init failed; MQTT/manual control still active");
    }

    vTaskDelete(NULL);
}

/**
 * @brief 雷达任务
 * @details 负责雷达数据采集和处理
 */
static void radarTask(void *pvParameters) {
    ESP_LOGI(TAG, "雷达任务启动");
    
    // 初始化雷达配置
    radar_config_t radarConfig;
    memset(&radarConfig, 0, sizeof(radarConfig));
    radarConfig.presence_enable = true;
    radarConfig.breath_enable = true;
    radarConfig.heart_rate_enable = true;
    radarConfig.sleep_enable = true;
    radarConfig.data_timeout_ms = 5000;
    
    // 初始化雷达驱动
    if (radar_init(&radarConfig) != RADAR_ERR_NONE) {
        ESP_LOGE(TAG, "雷达驱动初始化失败");
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    }

    radar_register_data_callback(radarDataCallback, NULL);
    radar_set_function_switch(R60ABD1_CTRL_PRESENCE, true);
    radar_set_function_switch(R60ABD1_CTRL_BREATHING, true);
    radar_set_function_switch(R60ABD1_CTRL_HEARTRATE, true);
    radar_set_function_switch(R60ABD1_CTRL_SLEEP, true);
    
    // 启动雷达驱动
    if (radar_start() != RADAR_ERR_NONE) {
        ESP_LOGE(TAG, "雷达驱动启动失败");
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    }
    
    g_radarReady = true;
    ESP_LOGI(TAG, "雷达任务已启动");
    
    // 雷达主循环
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(RADAR_SAMPLE_INTERVAL_MS));
    }
}

/**
 * @brief 遥测任务
 * @details 负责周期性上报设备状态和传感器数据
 */
static void telemetryTask(void *pvParameters) {
    ESP_LOGI(TAG, "遥测任务启动");
    
    // 仅等待雷达就绪；MQTT 不通时保留任务循环，连接恢复后自动开始上报
    while (!g_radarReady) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    
    // 遥测数据缓冲区
    char telemetryBuffer[MQTT_MAX_PAYLOAD_LEN];
    
    // 构建遥测主题
    char telemetryTopic[MQTT_MAX_TOPIC_LEN];
    buildDeviceTopic(telemetryTopic, sizeof(telemetryTopic), MQTT_TOPIC_TELEMETRY);
    
    ESP_LOGI(TAG, "遥测任务开始运行，主题: %s", telemetryTopic);
    
    // 遥测主循环
    for (;;) {
        if (g_mqttConnected && g_radarReady) {
            // 构建遥测数据
            int json_len = buildTelemetryJson(telemetryBuffer, sizeof(telemetryBuffer));
            
            if (json_len > 0) {
                // 发布遥测数据
                if (mqtt_client_publish_string(telemetryTopic, telemetryBuffer, MQTT_QOS_1, false)) {
                    ESP_LOGD(TAG, "遥测数据发布成功");
                } else {
                    ESP_LOGW(TAG, "遥测数据发布失败");
                }
            } else {
                ESP_LOGW(TAG, "遥测数据构建失败");
            }

            static uint8_t statusPublishCounter = 0;
            if (++statusPublishCounter >= 6) {
                statusPublishCounter = 0;
                publishDeviceStatus();
            }
        }
        
        vTaskDelay(pdMS_TO_TICKS(TELEMETRY_INTERVAL_MS));
    }
}

/**
 * @brief 处理MQTT命令
 * @param command 命令类型
 * @param payload 命令负载
 */
static bool processCommand(const char* command, const char* payload) {
    ESP_LOGI(TAG, "处理命令: %s", command);
    
    if (strcmp(command, "light_control") == 0) {
        cJSON* root = cJSON_Parse(payload);
        if (root != NULL) {
            light_config_t current = {};
            light_control_get_config(&current);
            cJSON* power = cJSON_GetObjectItem(root, "power");
            if (power == NULL) {
                power = cJSON_GetObjectItem(root, "on");
            }
            cJSON* brightness = cJSON_GetObjectItem(root, "brightness");
            cJSON* color_temp = cJSON_GetObjectItem(root, "color_temp");
            cJSON* brightness_delta = cJSON_GetObjectItem(root, "brightness_delta");
            cJSON* color_temp_delta = cJSON_GetObjectItem(root, "color_temp_delta");
            cJSON* scene = cJSON_GetObjectItem(root, "scene");
            cJSON* source = cJSON_GetObjectItem(root, "source");

            if (cJSON_IsString(source) && source->valuestring != NULL) {
                strncpy(g_lightSource, source->valuestring, sizeof(g_lightSource) - 1);
                g_lightSource[sizeof(g_lightSource) - 1] = '\0';
            } else {
                strncpy(g_lightSource, "app", sizeof(g_lightSource) - 1);
            }

            if (cJSON_IsString(scene) && scene->valuestring != NULL) {
                if (strcmp(scene->valuestring, "reading") == 0) {
                    light_control_on();
                    light_control_set_brightness_color(90, 5000);
                } else if (strcmp(scene->valuestring, "sleep") == 0) {
                    light_control_on();
                    light_control_set_brightness_color(25, 2700);
                } else if (strcmp(scene->valuestring, "night") == 0) {
                    light_control_on();
                    light_control_set_brightness_color(10, 2700);
                }
            }
            
            if (power != NULL && (cJSON_IsBool(power) || cJSON_IsNumber(power))) {
                bool enabled = cJSON_IsTrue(power) ||
                               (cJSON_IsNumber(power) && cJSON_GetNumberValue(power) > 0);
                if (enabled) {
                    light_control_on();
                } else {
                    light_control_off();
                }
            }
            
            if (brightness != NULL && cJSON_IsNumber(brightness)) {
                light_control_set_brightness((uint8_t)cJSON_GetNumberValue(brightness));
            } else if (brightness_delta != NULL && cJSON_IsNumber(brightness_delta)) {
                int next = (int)current.brightness + (int)cJSON_GetNumberValue(brightness_delta);
                if (next < LED_BRIGHTNESS_MIN) next = LED_BRIGHTNESS_MIN;
                if (next > LED_BRIGHTNESS_MAX) next = LED_BRIGHTNESS_MAX;
                if (next == 0) {
                    light_control_off();
                } else {
                    light_control_on();
                    light_control_set_brightness((uint8_t)next);
                }
            }
            
            if (color_temp != NULL && cJSON_IsNumber(color_temp)) {
                light_control_set_color_temp((uint16_t)cJSON_GetNumberValue(color_temp));
            } else if (color_temp_delta != NULL && cJSON_IsNumber(color_temp_delta)) {
                int next = (int)current.color_temp + (int)cJSON_GetNumberValue(color_temp_delta);
                if (next < LED_COLOR_TEMP_MIN) next = LED_COLOR_TEMP_MIN;
                if (next > LED_COLOR_TEMP_MAX) next = LED_COLOR_TEMP_MAX;
                light_control_set_color_temp((uint16_t)next);
            }
            
            cJSON_Delete(root);
            return true;
        }
        return false;
    } else if (strcmp(command, "audio_control") == 0 ||
               strcmp(command, "white_noise_control") == 0) {
        return processAudioCommand(payload);
    } else if (strcmp(command, "voice_query") == 0) {
        return processVoiceQueryCommand(payload);
    } else if (strcmp(command, "anion_control") == 0 || strcmp(command, "an_control") == 0) {
        cJSON* root = cJSON_Parse(payload);
        if (root != NULL) {
            cJSON* power = cJSON_GetObjectItem(root, "power");
            if (power == NULL) {
                power = cJSON_GetObjectItem(root, "on");
            }
            if (power != NULL && (cJSON_IsBool(power) || cJSON_IsNumber(power))) {
                bool enabled = cJSON_IsTrue(power) ||
                               (cJSON_IsNumber(power) && cJSON_GetNumberValue(power) > 0);
#if ANION_PWR_PIN >= 0
                gpio_set_level(ANION_PWR_PIN, enabled ? 1 : 0);
#else
                ESP_LOGW(TAG, "Anion control pin is not configured");
#endif
            }
            cJSON_Delete(root);
            return true;
        }
        return false;
    } else if (strcmp(command, "ota_upgrade") == 0) {
        ESP_LOGI(TAG, "收到OTA升级命令");
        cJSON* root = cJSON_Parse(payload);
        if (root == NULL) {
            ESP_LOGE(TAG, "OTA升级参数不是有效JSON");
            return false;
        }

        cJSON* url = cJSON_GetObjectItem(root, "url");
        cJSON* version = cJSON_GetObjectItem(root, "version");
        cJSON* checksum = cJSON_GetObjectItem(root, "checksum");
        if (checksum == NULL) {
            checksum = cJSON_GetObjectItem(root, "md5");
        }

        bool ok = false;
        if (cJSON_IsString(url) && cJSON_IsString(version)) {
            const char* md5 = cJSON_IsString(checksum) ? checksum->valuestring : NULL;
            ok = (ota_service_start(url->valuestring, version->valuestring, md5) == OTA_ERR_NONE);
        } else {
            ESP_LOGE(TAG, "OTA升级参数缺少url或version");
        }

        cJSON_Delete(root);
        return ok;
    } else if (strcmp(command, "query_status") == 0) {
        ESP_LOGI(TAG, "收到状态查询命令");
        publishDeviceStatus();
        return true;
    } else {
        ESP_LOGW(TAG, "未知命令: %s", command);
    }

    return false;
}

static bool processAudioCommand(const char* payload) {
    if (!g_audioReady) {
        ESP_LOGW(TAG, "Audio player is not ready");
        return false;
    }

    cJSON* root = cJSON_Parse(payload != NULL ? payload : "{}");
    if (root == NULL) {
        return false;
    }

    cJSON* source = cJSON_GetObjectItem(root, "source");
    if (cJSON_IsString(source) && source->valuestring != NULL) {
        strncpy(g_audioSource, source->valuestring, sizeof(g_audioSource) - 1);
        g_audioSource[sizeof(g_audioSource) - 1] = '\0';
    } else {
        strncpy(g_audioSource, "app", sizeof(g_audioSource) - 1);
        g_audioSource[sizeof(g_audioSource) - 1] = '\0';
    }

    cJSON* action = cJSON_GetObjectItem(root, "action");
    cJSON* sound = cJSON_GetObjectItem(root, "sound");
    cJSON* volume = cJSON_GetObjectItem(root, "volume");
    cJSON* power = cJSON_GetObjectItem(root, "power");
    if (power == NULL) {
        power = cJSON_GetObjectItem(root, "on");
    }
    if (sound == NULL) {
        sound = cJSON_GetObjectItem(root, "noise");
    }
    if (sound == NULL) {
        sound = cJSON_GetObjectItem(root, "type");
    }
    if (sound == NULL) {
        sound = cJSON_GetObjectItem(root, "name");
    }

    bool should_stop = false;
    bool should_play = false;
    if (cJSON_IsString(action) && action->valuestring != NULL) {
        should_stop = strcasecmp(action->valuestring, "stop") == 0 ||
                      strcasecmp(action->valuestring, "off") == 0 ||
                      strcasecmp(action->valuestring, "pause") == 0;
        should_play = strcasecmp(action->valuestring, "play") == 0 ||
                      strcasecmp(action->valuestring, "on") == 0;
    }

    if (power != NULL && (cJSON_IsBool(power) || cJSON_IsNumber(power))) {
        bool enabled = cJSON_IsTrue(power) ||
                       (cJSON_IsNumber(power) && cJSON_GetNumberValue(power) > 0);
        should_play = enabled;
        should_stop = !enabled;
    }

    bool ok = false;
    if (should_stop) {
        white_noise_player_stop();
        ok = true;
    } else {
        white_noise_state_t state = {};
        white_noise_player_get_state(&state);
        uint8_t next_volume = state.volume > 0 ? state.volume : WHITE_NOISE_DEFAULT_VOLUME;
        if (cJSON_IsNumber(volume)) {
            int vol = (int)cJSON_GetNumberValue(volume);
            if (vol < 0) vol = 0;
            if (vol > 100) vol = 100;
            next_volume = (uint8_t)vol;
        }

        if (should_play || cJSON_IsString(sound)) {
            const char* sound_name = cJSON_IsString(sound) ? sound->valuestring : state.sound;
            if (sound_name != NULL && sound_name[0] != '\0') {
                ok = white_noise_player_play(sound_name, next_volume);
            }
        } else if (cJSON_IsNumber(volume)) {
            white_noise_player_set_volume(next_volume);
            ok = true;
        }
    }

    cJSON_Delete(root);
    return ok;
}

static bool processVoiceQueryCommand(const char* payload) {
    cJSON* root = cJSON_Parse(payload != NULL ? payload : "{}");
    if (root == NULL) {
        return false;
    }

    cJSON* query = cJSON_GetObjectItem(root, "query");
    cJSON* query_type = cJSON_GetObjectItem(root, "query_type");
    cJSON* report_date = cJSON_GetObjectItem(root, "report_date");
    cJSON* source = cJSON_GetObjectItem(root, "source");

    const char* next_query =
        cJSON_IsString(query) && query->valuestring != NULL
            ? query->valuestring
            : "我昨天晚上睡得怎么样？";
    const char* next_query_type =
        cJSON_IsString(query_type) && query_type->valuestring != NULL
            ? query_type->valuestring
            : "sleep_report";
    const char* next_report_date =
        cJSON_IsString(report_date) && report_date->valuestring != NULL
            ? report_date->valuestring
            : "yesterday";
    const char* next_source =
        cJSON_IsString(source) && source->valuestring != NULL
            ? source->valuestring
            : "voice";

    strncpy(g_voiceQueryText, next_query, sizeof(g_voiceQueryText) - 1);
    g_voiceQueryText[sizeof(g_voiceQueryText) - 1] = '\0';
    strncpy(g_voiceQueryDate, next_report_date, sizeof(g_voiceQueryDate) - 1);
    g_voiceQueryDate[sizeof(g_voiceQueryDate) - 1] = '\0';
    strncpy(g_voiceQueryStatus, "pending", sizeof(g_voiceQueryStatus) - 1);
    g_voiceQueryStatus[sizeof(g_voiceQueryStatus) - 1] = '\0';
    g_voiceQueryAnswer[0] = '\0';
    g_voiceQueryUpdatedAt = (uint64_t)(esp_timer_get_time() / 1000);

    bool ok = false;
    if (!g_mqttConnected) {
        strncpy(g_voiceQueryStatus, "offline", sizeof(g_voiceQueryStatus) - 1);
        g_voiceQueryStatus[sizeof(g_voiceQueryStatus) - 1] = '\0';
        strncpy(g_voiceQueryAnswer, "device_offline", sizeof(g_voiceQueryAnswer) - 1);
        g_voiceQueryAnswer[sizeof(g_voiceQueryAnswer) - 1] = '\0';
    } else {
        ok = publishVoiceQueryRequest(
            next_query,
            next_query_type,
            next_report_date,
            next_source
        );
        if (!ok) {
            strncpy(g_voiceQueryStatus, "publish_failed", sizeof(g_voiceQueryStatus) - 1);
            g_voiceQueryStatus[sizeof(g_voiceQueryStatus) - 1] = '\0';
            strncpy(g_voiceQueryAnswer, "publish_failed", sizeof(g_voiceQueryAnswer) - 1);
            g_voiceQueryAnswer[sizeof(g_voiceQueryAnswer) - 1] = '\0';
        }
    }

    cJSON_Delete(root);
    return ok;
}

static bool publishVoiceQueryRequest(
    const char* query,
    const char* query_type,
    const char* report_date,
    const char* source
) {
    if (!g_mqttConnected) {
        return false;
    }

    char topic[MQTT_MAX_TOPIC_LEN];
    char deviceId[MQTT_MAX_CLIENT_ID_LEN];
    char queryId[64];
    getDeviceId(deviceId, sizeof(deviceId));
    buildDeviceTopic(topic, sizeof(topic), "/voice/query");
    snprintf(queryId, sizeof(queryId), "vq_%llu", (unsigned long long)(esp_timer_get_time() / 1000));

    cJSON* root = cJSON_CreateObject();
    cJSON* data = cJSON_CreateObject();
    if (root == NULL || data == NULL) {
        cJSON_Delete(root);
        cJSON_Delete(data);
        return false;
    }

    cJSON_AddStringToObject(root, "messageId", queryId);
    cJSON_AddNumberToObject(root, "timestamp", esp_timer_get_time() / 1000);
    cJSON_AddStringToObject(root, "deviceId", deviceId);
    cJSON_AddStringToObject(root, "type", "voice/query");

    cJSON_AddStringToObject(data, "queryId", queryId);
    cJSON_AddStringToObject(data, "query", query != NULL ? query : "");
    cJSON_AddStringToObject(data, "queryType", query_type != NULL ? query_type : "sleep_report");
    cJSON_AddStringToObject(data, "reportDate", report_date != NULL ? report_date : "yesterday");
    cJSON_AddStringToObject(data, "source", source != NULL ? source : "voice");
    cJSON_AddItemToObject(root, "data", data);

    char* json = cJSON_PrintUnformatted(root);
    bool ok = false;
    if (json != NULL) {
        ok = mqtt_client_publish_string(topic, json, MQTT_QOS_1, false);
        free(json);
    }

    cJSON_Delete(root);
    return ok;
}

static void applyTouchLightScene(uint8_t scene_index) {
    light_control_on();
    switch (scene_index % 3) {
        case 0:
            light_control_set_brightness_color(100, LED_COLOR_TEMP_MAX);
            break;
        case 1:
            light_control_set_brightness_color(100, LED_COLOR_TEMP_MIN);
            break;
        default:
            light_control_set_brightness_color(100, (LED_COLOR_TEMP_MIN + LED_COLOR_TEMP_MAX) / 2);
            break;
    }
}

static void applyTouchVolumeStep(int delta) {
    if (!g_audioReady) {
        return;
    }

    white_noise_state_t state = {};
    white_noise_player_get_state(&state);

    int next_volume = state.volume > 0 ? state.volume : WHITE_NOISE_DEFAULT_VOLUME;
    next_volume += delta;
    if (next_volume < 0) {
        next_volume = 0;
    }
    if (next_volume > 100) {
        next_volume = 100;
    }

    white_noise_player_set_volume((uint8_t)next_volume);
    strncpy(g_audioSource, "touch", sizeof(g_audioSource) - 1);
    g_audioSource[sizeof(g_audioSource) - 1] = '\0';
    ESP_LOGI(TAG, "Touch volume adjusted to %d", next_volume);
}

static void touchControlCallback(const touch_control_event_t* event, void* user_data) {
    (void)user_data;
    if (event == NULL) {
        return;
    }

    switch (event->type) {
        case TOUCH_CONTROL_EVENT_LIGHT_SCENE:
            strncpy(g_lightSource, "touch", sizeof(g_lightSource) - 1);
            g_lightSource[sizeof(g_lightSource) - 1] = '\0';
            applyTouchLightScene(event->scene_index);
            break;

        case TOUCH_CONTROL_EVENT_NOISE_PLAY:
            if (g_audioReady && event->sound != NULL) {
                white_noise_state_t state = {};
                white_noise_player_get_state(&state);
                uint8_t volume = state.volume > 0 ? state.volume : WHITE_NOISE_DEFAULT_VOLUME;
                if (white_noise_player_play(event->sound, volume)) {
                    strncpy(g_audioSource, "touch", sizeof(g_audioSource) - 1);
                    g_audioSource[sizeof(g_audioSource) - 1] = '\0';
                }
            }
            break;

        case TOUCH_CONTROL_EVENT_NOISE_STOP:
            if (g_audioReady) {
                white_noise_player_stop();
                strncpy(g_audioSource, "touch", sizeof(g_audioSource) - 1);
                g_audioSource[sizeof(g_audioSource) - 1] = '\0';
            }
            break;

        case TOUCH_CONTROL_EVENT_VOLUME_UP:
            applyTouchVolumeStep(TOUCH_VOLUME_STEP);
            break;

        case TOUCH_CONTROL_EVENT_VOLUME_DOWN:
            applyTouchVolumeStep(-TOUCH_VOLUME_STEP);
            break;

        default:
            break;
    }
}

static void potentiometerChangedCallback(const potentiometer_state_t* state, void* user_data) {
    (void)user_data;
    if (state == NULL) {
        return;
    }
    strncpy(g_lightSource, "manual", sizeof(g_lightSource) - 1);
    g_lightSource[sizeof(g_lightSource) - 1] = '\0';
}

static void voiceEventCallback(local_voice_event_t event, const char* detail, void* user_data) {
    (void)user_data;

    switch (event) {
        case LOCAL_VOICE_EVENT_WAKE_WORD: {
            white_noise_state_t audio_state = {};
            if (g_audioReady) {
                white_noise_player_get_state(&audio_state);
                if (audio_state.playing) {
                    white_noise_player_set_ducking(true, WHITE_NOISE_VOICE_DUCK_VOLUME);
                    g_voiceAudioDucked = true;
                }
            }
            setVoiceError("");
            break;
        }

        case LOCAL_VOICE_EVENT_COMMAND_TIMEOUT:
            if (g_voiceAudioDucked) {
                white_noise_player_set_ducking(false, WHITE_NOISE_VOICE_DUCK_VOLUME);
                g_voiceAudioDucked = false;
            }
            break;

        case LOCAL_VOICE_EVENT_ERROR:
            setVoiceError(detail != NULL ? detail : "voice_runtime_error");
            break;

        case LOCAL_VOICE_EVENT_COMMAND_DETECTED:
        default:
            break;
    }
}

static void voiceCommandCallback(const char* command, const char* params_json, void* user_data) {
    (void)user_data;
    if (command == NULL || params_json == NULL) {
        return;
    }
    if (strcmp(command, "light_control") == 0) {
        strncpy(g_lightSource, "voice", sizeof(g_lightSource) - 1);
        g_lightSource[sizeof(g_lightSource) - 1] = '\0';
    }
    if (strcmp(command, "audio_control") == 0 || strcmp(command, "white_noise_control") == 0) {
        strncpy(g_audioSource, "voice", sizeof(g_audioSource) - 1);
        g_audioSource[sizeof(g_audioSource) - 1] = '\0';
    }
    processCommand(command, params_json);
    if (g_voiceAudioDucked) {
        white_noise_player_set_ducking(false, WHITE_NOISE_VOICE_DUCK_VOLUME);
        g_voiceAudioDucked = false;
    }
}

/**
 * @brief MQTT事件回调
 * @param event 事件类型
 * @param data 事件数据
 * @param user_data 用户数据
 */
static void mqttEventCallback(mqtt_event_t event, void* data, void* user_data) {
    (void)user_data;
    
    switch (event) {
        case MQTT_CLIENT_EVENT_CONNECTED:
            ESP_LOGI(TAG, "MQTT已连接");
            g_mqttConnected = true;
            break;
            
        case MQTT_CLIENT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "MQTT已断开");
            g_mqttConnected = false;
            break;
            
        case MQTT_CLIENT_EVENT_MESSAGE: {
            mqtt_message_t* msg = (mqtt_message_t*)data;
            if (msg != NULL && strstr(msg->topic, "/voice/response") != NULL) {
                handleVoiceQueryResponse(msg);
                break;
            }
            queued_command_t queuedCommand;
            memset(&queuedCommand, 0, sizeof(queuedCommand));

            if (!extractCommandFromMessage(msg, &queuedCommand)) {
                ESP_LOGW(TAG, "无法解析命令消息: %s", msg != NULL ? msg->topic : "(null)");
                break;
            }

            ESP_LOGI(TAG, "收到命令: %s, 负载: %s", queuedCommand.command, queuedCommand.payload);

            if (xQueueSend(g_commandQueue, &queuedCommand, pdMS_TO_TICKS(100)) != pdTRUE) {
                ESP_LOGW(TAG, "命令队列已满");
                publishCommandResponse(queuedCommand.command_id, queuedCommand.command, false, "command queue full");
            }
            break;
        }
            
        default:
            break;
    }
}

/**
 * @brief 命令处理任务
 * @details 负责处理来自MQTT的控制命令
 */
static void commandTask(void *pvParameters) {
    ESP_LOGI(TAG, "命令任务启动");
    
    // 注册MQTT事件回调
    mqtt_client_set_event_callback(mqttEventCallback, NULL);

    bool subscribed = false;
    
    // 命令处理循环
    for (;;) {
        if (g_mqttConnected && !subscribed) {
            char commandTopic[MQTT_MAX_TOPIC_LEN];
            char otaCommandTopic[MQTT_MAX_TOPIC_LEN];
            char legacyCommandTopic[MQTT_MAX_TOPIC_LEN];
            char voiceResponseTopic[MQTT_MAX_TOPIC_LEN];
            char deviceId[MQTT_MAX_CLIENT_ID_LEN];

            getDeviceId(deviceId, sizeof(deviceId));
            buildDeviceTopic(commandTopic, sizeof(commandTopic), MQTT_TOPIC_COMMAND);
            buildDeviceTopic(otaCommandTopic, sizeof(otaCommandTopic), "/ota/command");
            buildDeviceTopic(voiceResponseTopic, sizeof(voiceResponseTopic), "/voice/response");
            snprintf(legacyCommandTopic, sizeof(legacyCommandTopic), "sleep/%s/command", deviceId);

            bool commandSubscribed = mqtt_client_subscribe(commandTopic, MQTT_QOS_1);
            bool otaSubscribed = mqtt_client_subscribe(otaCommandTopic, MQTT_QOS_1);
            bool legacySubscribed = mqtt_client_subscribe(legacyCommandTopic, MQTT_QOS_1);
            bool voiceResponseSubscribed = mqtt_client_subscribe(voiceResponseTopic, MQTT_QOS_1);

            subscribed = commandSubscribed && otaSubscribed && legacySubscribed && voiceResponseSubscribed;
            if (subscribed) {
                ESP_LOGI(TAG, "命令主题订阅完成: %s, %s, %s",
                         commandTopic, otaCommandTopic, legacyCommandTopic);
            } else {
                ESP_LOGW(TAG, "命令主题订阅未完全成功，稍后重试");
            }
        } else if (!g_mqttConnected) {
            subscribed = false;
        }

        queued_command_t queuedCommand;
        if (xQueueReceive(g_commandQueue, &queuedCommand, pdMS_TO_TICKS(100)) == pdTRUE) {
            ESP_LOGI(TAG, "处理命令: %s", queuedCommand.command);
            bool ok = processCommand(queuedCommand.command, queuedCommand.payload);
            publishCommandResponse(
                queuedCommand.command_id,
                queuedCommand.command,
                ok,
                ok ? "ok" : "command failed"
            );
        }
        
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    ESP_LOGI(TAG, "命令任务结束");
    vTaskDelete(NULL);
}

//=============================================================================
// 工具函数实现
//=============================================================================

/**
 * @brief 构建遥测数据JSON
 * @param buffer 输出缓冲区
 * @param buffer_size 缓冲区大小
 * @return 成功返回JSON字符串长度，失败返回0
 */
static int buildTelemetryJson(char* buffer, size_t buffer_size) {
    cJSON* root = cJSON_CreateObject();
    if (root == NULL) {
        ESP_LOGE(TAG, "创建JSON对象失败");
        return 0;
    }
    
    cJSON* data = cJSON_CreateObject();
    if (data == NULL) {
        ESP_LOGE(TAG, "创建数据对象失败");
        cJSON_Delete(root);
        return 0;
    }
    
    uint32_t timestamp = esp_timer_get_time() / 1000;
    char deviceId[MQTT_MAX_CLIENT_ID_LEN];
    getDeviceId(deviceId, sizeof(deviceId));

    cJSON_AddNumberToObject(root, "timestamp", timestamp);
    cJSON_AddStringToObject(root, "deviceId", deviceId);
    cJSON_AddStringToObject(root, "device_id", deviceId);
    cJSON_AddStringToObject(root, "type", "telemetry");
    
    app_sleep_realtime_data_t realtime_data;
    if (app_sleep_get_realtime_data(&realtime_data) == APP_SLEEP_ERR_NONE) {
        cJSON_AddNumberToObject(data, "timestamp", timestamp);
        if (realtime_data.heart_rate_valid) {
            cJSON_AddNumberToObject(data, "heartRate", realtime_data.heart_rate);
            cJSON_AddNumberToObject(data, "heart_rate", realtime_data.heart_rate);
        }
        if (realtime_data.breathing_rate_valid) {
            cJSON_AddNumberToObject(data, "breathingRate", realtime_data.breathing_rate);
            cJSON_AddNumberToObject(data, "breathing_rate", realtime_data.breathing_rate);
        }
        if (realtime_data.movement_valid) {
            cJSON_AddNumberToObject(data, "bodyMovement", realtime_data.movement_level);
            cJSON_AddNumberToObject(data, "body_movement", realtime_data.movement_level);
            cJSON_AddNumberToObject(data, "movement_level", realtime_data.movement_level);
        }
        if (realtime_data.sleep_state_valid) {
            cJSON_AddNumberToObject(data, "sleepState", realtime_data.sleep_state);
            cJSON_AddNumberToObject(data, "sleep_state", realtime_data.sleep_state);
        }
        if (realtime_data.presence_valid) {
            cJSON_AddNumberToObject(data, "presence", realtime_data.presence);
        }
        if (realtime_data.distance_valid) {
            cJSON_AddNumberToObject(data, "distance", realtime_data.distance_cm);
            cJSON_AddNumberToObject(data, "distance_cm", realtime_data.distance_cm);
        }
    }

    radar_stats_t radar_stats = {};
    radar_get_stats(&radar_stats);
    cJSON* radar = cJSON_CreateObject();
    if (radar != NULL) {
        cJSON_AddNumberToObject(radar, "state", radar_get_state());
        cJSON_AddNumberToObject(radar, "total_frames", radar_stats.total_frames);
        cJSON_AddNumberToObject(radar, "valid_frames", radar_stats.valid_frames);
        cJSON_AddNumberToObject(radar, "error_frames", radar_stats.error_frames);
        cJSON_AddNumberToObject(radar, "last_frame_time", radar_stats.last_frame_time);
        cJSON_AddItemToObject(root, "radar", radar);
    }

    light_config_t light_config = {};
    light_control_get_config(&light_config);
    cJSON* light = cJSON_CreateObject();
    if (light != NULL) {
        cJSON_AddBoolToObject(light, "power", light_config.power);
        cJSON_AddNumberToObject(light, "brightness", light_config.brightness);
        cJSON_AddNumberToObject(light, "color_temp", light_config.color_temp);
        cJSON_AddStringToObject(light, "source", g_lightSource);
        cJSON_AddItemToObject(root, "light", light);
        cJSON_AddItemToObject(data, "light", cJSON_Duplicate(light, true));
    }

    white_noise_state_t audio_state = {};
    white_noise_player_get_state(&audio_state);
    cJSON* audio = cJSON_CreateObject();
    if (audio != NULL) {
        cJSON_AddBoolToObject(audio, "playing", audio_state.playing);
        cJSON_AddStringToObject(audio, "sound", audio_state.sound);
        cJSON_AddNumberToObject(audio, "volume", audio_state.volume);
        cJSON_AddStringToObject(audio, "source", g_audioSource);
        cJSON_AddItemToObject(root, "audio", audio);
        cJSON_AddItemToObject(data, "audio", cJSON_Duplicate(audio, true));
    }

    char wake_word[32] = "";
    char last_voice_command[32] = "";
    char local_voice_error[96] = "";
    local_voice_command_get_wake_word(wake_word, sizeof(wake_word));
    local_voice_command_get_last_command(last_voice_command, sizeof(last_voice_command));
    local_voice_command_get_last_error(local_voice_error, sizeof(local_voice_error));
    const char* effective_voice_error =
        g_voiceError[0] != '\0' ? g_voiceError : local_voice_error;
    cJSON* voice = cJSON_CreateObject();
    if (voice != NULL) {
        cJSON_AddBoolToObject(voice, "offline_voice_ready", g_voiceReady && local_voice_command_is_ready());
        cJSON_AddStringToObject(voice, "wake_word", wake_word);
        cJSON_AddStringToObject(voice, "last_voice_command", last_voice_command);
        cJSON_AddStringToObject(voice, "voice_error", effective_voice_error);
        cJSON_AddBoolToObject(voice, "command_window", local_voice_command_is_command_window_active());
        cJSON_AddStringToObject(voice, "online_query_status", g_voiceQueryStatus);
        cJSON_AddStringToObject(voice, "online_query_text", g_voiceQueryText);
        cJSON_AddStringToObject(voice, "online_query_date", g_voiceQueryDate);
        cJSON_AddStringToObject(voice, "online_query_answer", g_voiceQueryAnswer);
        cJSON_AddNumberToObject(voice, "online_query_updated_at", (double)g_voiceQueryUpdatedAt);
        cJSON_AddItemToObject(root, "voice", voice);
        cJSON_AddItemToObject(data, "voice", cJSON_Duplicate(voice, true));
    }
    cJSON_AddBoolToObject(data, "offline_voice_ready", g_voiceReady && local_voice_command_is_ready());
    cJSON_AddStringToObject(data, "wake_word", wake_word);
    cJSON_AddStringToObject(data, "last_voice_command", last_voice_command);
    cJSON_AddStringToObject(data, "voice_error", effective_voice_error);
    cJSON_AddStringToObject(data, "online_query_status", g_voiceQueryStatus);
    cJSON_AddStringToObject(data, "online_query_text", g_voiceQueryText);
    cJSON_AddStringToObject(data, "online_query_date", g_voiceQueryDate);
    cJSON_AddStringToObject(data, "online_query_answer", g_voiceQueryAnswer);
    
    app_sleep_statistics_t stats;
    if (app_sleep_get_statistics(&stats) == APP_SLEEP_ERR_NONE) {
        cJSON* stats_obj = cJSON_CreateObject();
        if (stats_obj != NULL) {
            cJSON_AddNumberToObject(stats_obj, "heart_rate_avg", stats.heart_rate_avg);
            cJSON_AddNumberToObject(stats_obj, "breathing_rate_avg", stats.breathing_rate_avg);
            cJSON_AddNumberToObject(stats_obj, "turn_over_count", stats.turn_over_count);
            cJSON_AddNumberToObject(stats_obj, "sleep_score", stats.sleep_score);
            cJSON_AddNumberToObject(data, "sleepScore", stats.sleep_score);
            cJSON_AddNumberToObject(data, "sleep_score", stats.sleep_score);
            cJSON_AddItemToObject(root, "statistics", stats_obj);
        }
    }
    
    cJSON_AddItemToObject(root, "data", data);
    
    char* json_str = cJSON_PrintUnformatted(root);
    if (json_str == NULL) {
        ESP_LOGE(TAG, "生成JSON字符串失败");
        cJSON_Delete(root);
        return 0;
    }
    
    size_t json_len = strlen(json_str);
    if (json_len >= buffer_size) {
        ESP_LOGE(TAG, "JSON数据过长: %zu >= %zu", json_len, buffer_size);
        free(json_str);
        cJSON_Delete(root);
        return 0;
    }
    
    strcpy(buffer, json_str);
    free(json_str);
    cJSON_Delete(root);
    
    return json_len;
}

static bool copyJsonStringField(cJSON* object, const char* key, char* dest, size_t dest_size) {
    if (object == NULL || key == NULL || dest == NULL || dest_size == 0) {
        return false;
    }

    cJSON* item = cJSON_GetObjectItem(object, key);
    if (!cJSON_IsString(item) || item->valuestring == NULL) {
        return false;
    }

    strncpy(dest, item->valuestring, dest_size - 1);
    dest[dest_size - 1] = '\0';
    return true;
}

static bool handleVoiceQueryResponse(const mqtt_message_t* msg) {
    if (msg == NULL) {
        return false;
    }

    size_t payload_len = msg->payload_len;
    if (payload_len > MQTT_MAX_PAYLOAD_LEN) {
        payload_len = MQTT_MAX_PAYLOAD_LEN;
    }

    char payload[MQTT_MAX_PAYLOAD_LEN + 1];
    memcpy(payload, msg->payload, payload_len);
    payload[payload_len] = '\0';

    cJSON* root = cJSON_Parse(payload);
    if (root == NULL) {
        return false;
    }

    cJSON* data = cJSON_GetObjectItem(root, "data");
    if (!cJSON_IsObject(data)) {
        data = root;
    }

    char next_status[sizeof(g_voiceQueryStatus)] = "";
    char next_answer[sizeof(g_voiceQueryAnswer)] = "";
    char next_query[sizeof(g_voiceQueryText)] = "";
    char next_date[sizeof(g_voiceQueryDate)] = "";

    copyJsonStringField(data, "status", next_status, sizeof(next_status));
    copyJsonStringField(data, "answer", next_answer, sizeof(next_answer));
    copyJsonStringField(data, "query", next_query, sizeof(next_query));
    copyJsonStringField(data, "reportDate", next_date, sizeof(next_date));

    if (next_status[0] == '\0') {
        strncpy(next_status, "completed", sizeof(next_status) - 1);
        next_status[sizeof(next_status) - 1] = '\0';
    }
    if (next_answer[0] == '\0') {
        copyJsonStringField(data, "error", next_answer, sizeof(next_answer));
    }
    if (next_query[0] != '\0') {
        strncpy(g_voiceQueryText, next_query, sizeof(g_voiceQueryText) - 1);
        g_voiceQueryText[sizeof(g_voiceQueryText) - 1] = '\0';
    }
    if (next_date[0] != '\0') {
        strncpy(g_voiceQueryDate, next_date, sizeof(g_voiceQueryDate) - 1);
        g_voiceQueryDate[sizeof(g_voiceQueryDate) - 1] = '\0';
    }

    strncpy(g_voiceQueryStatus, next_status, sizeof(g_voiceQueryStatus) - 1);
    g_voiceQueryStatus[sizeof(g_voiceQueryStatus) - 1] = '\0';
    strncpy(g_voiceQueryAnswer, next_answer, sizeof(g_voiceQueryAnswer) - 1);
    g_voiceQueryAnswer[sizeof(g_voiceQueryAnswer) - 1] = '\0';
    g_voiceQueryUpdatedAt = (uint64_t)(esp_timer_get_time() / 1000);

    cJSON_Delete(root);
    return true;
}

static void getDeviceId(char* buffer, size_t buffer_size) {
    if (buffer == NULL || buffer_size == 0) {
        return;
    }

    uint8_t mac[6] = {0};
    esp_err_t err = esp_read_mac(mac, ESP_MAC_WIFI_STA);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "读取MAC地址失败: %s", esp_err_to_name(err));
    }

    snprintf(buffer, buffer_size, "%s%02X%02X%02X%02X%02X%02X",
             MQTT_CLIENT_ID_PREFIX,
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

static void buildDeviceTopic(char* buffer, size_t buffer_size, const char* suffix) {
    if (buffer == NULL || buffer_size == 0) {
        return;
    }

    char deviceId[MQTT_MAX_CLIENT_ID_LEN];
    getDeviceId(deviceId, sizeof(deviceId));
    snprintf(buffer, buffer_size, "%s%s%s",
             MQTT_TOPIC_PREFIX,
             deviceId,
             suffix != NULL ? suffix : "");
}

static bool extractCommandFromMessage(const mqtt_message_t* msg, queued_command_t* out) {
    if (msg == NULL || out == NULL) {
        return false;
    }

    memset(out, 0, sizeof(queued_command_t));

    size_t payload_len = msg->payload_len;
    if (payload_len > MQTT_MAX_PAYLOAD_LEN) {
        payload_len = MQTT_MAX_PAYLOAD_LEN;
    }

    char payload[MQTT_MAX_PAYLOAD_LEN + 1];
    memcpy(payload, msg->payload, payload_len);
    payload[payload_len] = '\0';

    cJSON* root = cJSON_Parse(payload);
    if (root == NULL) {
        ESP_LOGW(TAG, "命令JSON解析失败: %s", payload);
        return false;
    }

    cJSON* data = cJSON_GetObjectItem(root, "data");
    if (!cJSON_IsObject(data)) {
        data = root;
    }

    if (!copyJsonStringField(data, "commandId", out->command_id, sizeof(out->command_id)) &&
        !copyJsonStringField(root, "commandId", out->command_id, sizeof(out->command_id)) &&
        !copyJsonStringField(root, "messageId", out->command_id, sizeof(out->command_id))) {
        copyJsonStringField(data, "messageId", out->command_id, sizeof(out->command_id));
    }

    bool has_command =
        copyJsonStringField(data, "command", out->command, sizeof(out->command)) ||
        copyJsonStringField(root, "command", out->command, sizeof(out->command));

    if (!has_command && strstr(msg->topic, "/ota/command") != NULL) {
        strncpy(out->command, "ota_upgrade", sizeof(out->command) - 1);
        has_command = true;
    }

    if (!has_command) {
        cJSON_Delete(root);
        return false;
    }

    cJSON* params = cJSON_GetObjectItem(data, "params");
    if (params == NULL) {
        params = cJSON_GetObjectItem(root, "params");
    }
    if (params == NULL && strcmp(out->command, "ota_upgrade") == 0) {
        params = data;
    }

    if (params != NULL) {
        char* params_json = cJSON_PrintUnformatted(params);
        if (params_json != NULL) {
            strncpy(out->payload, params_json, sizeof(out->payload) - 1);
            out->payload[sizeof(out->payload) - 1] = '\0';
            free(params_json);
        }
    }

    if (out->payload[0] == '\0') {
        strncpy(out->payload, "{}", sizeof(out->payload) - 1);
    }

    cJSON_Delete(root);
    return true;
}

static void publishCommandResponse(const char* command_id, const char* command, bool success, const char* message) {
    if (!g_mqttConnected) {
        return;
    }

    char topic[MQTT_MAX_TOPIC_LEN];
    char deviceId[MQTT_MAX_CLIENT_ID_LEN];
    char messageId[64];
    getDeviceId(deviceId, sizeof(deviceId));
    buildDeviceTopic(topic, sizeof(topic), "/command/response");
    snprintf(messageId, sizeof(messageId), "rsp_%llu", (unsigned long long)(esp_timer_get_time() / 1000));

    cJSON* root = cJSON_CreateObject();
    cJSON* data = cJSON_CreateObject();
    cJSON* result = cJSON_CreateObject();
    if (root == NULL || data == NULL || result == NULL) {
        cJSON_Delete(root);
        cJSON_Delete(data);
        cJSON_Delete(result);
        return;
    }

    cJSON_AddStringToObject(root, "messageId", messageId);
    cJSON_AddNumberToObject(root, "timestamp", esp_timer_get_time() / 1000);
    cJSON_AddStringToObject(root, "deviceId", deviceId);
    cJSON_AddStringToObject(root, "type", "command/response");

    cJSON_AddStringToObject(data, "commandId", (command_id != NULL && command_id[0] != '\0') ? command_id : messageId);
    cJSON_AddStringToObject(data, "status", success ? "success" : "error");
    cJSON_AddStringToObject(result, "command", command != NULL ? command : "");
    cJSON_AddStringToObject(result, "message", message != NULL ? message : "");
    cJSON_AddItemToObject(data, "result", result);
    cJSON_AddItemToObject(root, "data", data);

    char* json = cJSON_PrintUnformatted(root);
    if (json != NULL) {
        mqtt_client_publish_string(topic, json, MQTT_QOS_1, false);
        free(json);
    }

    cJSON_Delete(root);
}

static void publishDeviceStatus(void) {
    if (!g_mqttConnected) {
        return;
    }

    char topic[MQTT_MAX_TOPIC_LEN];
    char deviceId[MQTT_MAX_CLIENT_ID_LEN];
    getDeviceId(deviceId, sizeof(deviceId));
    buildDeviceTopic(topic, sizeof(topic), MQTT_TOPIC_STATUS);

    cJSON* root = cJSON_CreateObject();
    cJSON* data = cJSON_CreateObject();
    if (root == NULL || data == NULL) {
        cJSON_Delete(root);
        cJSON_Delete(data);
        return;
    }

    uint64_t now_ms = (uint64_t)(esp_timer_get_time() / 1000);
    cJSON_AddNumberToObject(root, "timestamp", now_ms);
    cJSON_AddStringToObject(root, "deviceId", deviceId);
    cJSON_AddStringToObject(root, "type", "status");

    cJSON_AddBoolToObject(data, "online", true);
    cJSON_AddStringToObject(data, "status", g_systemReady ? "online" : "booting");
    cJSON_AddNumberToObject(data, "lastSeen", now_ms);
    cJSON_AddStringToObject(data, "firmwareVersion", FIRMWARE_VERSION_STR);
    cJSON_AddNumberToObject(data, "uptime", now_ms / 1000);

    char bindToken[PROVISIONING_BIND_TOKEN_MAX_LEN] = {0};
    if (provisioning_service_get_bind_token(bindToken, sizeof(bindToken))) {
        cJSON_AddStringToObject(data, "bindToken", bindToken);
    }

    light_config_t light_config = {};
    light_control_get_config(&light_config);
    cJSON* light = cJSON_CreateObject();
    if (light != NULL) {
        cJSON_AddBoolToObject(light, "power", light_config.power);
        cJSON_AddNumberToObject(light, "brightness", light_config.brightness);
        cJSON_AddNumberToObject(light, "color_temp", light_config.color_temp);
        cJSON_AddStringToObject(light, "source", g_lightSource);
        cJSON_AddItemToObject(data, "light", light);
    }

    white_noise_state_t audio_state = {};
    white_noise_player_get_state(&audio_state);
    cJSON* audio = cJSON_CreateObject();
    if (audio != NULL) {
        cJSON_AddBoolToObject(audio, "playing", audio_state.playing);
        cJSON_AddStringToObject(audio, "sound", audio_state.sound);
        cJSON_AddNumberToObject(audio, "volume", audio_state.volume);
        cJSON_AddStringToObject(audio, "source", g_audioSource);
        cJSON_AddItemToObject(data, "audio", audio);
    }

    char wake_word[32] = "";
    char last_voice_command[32] = "";
    char local_voice_error[96] = "";
    local_voice_command_get_wake_word(wake_word, sizeof(wake_word));
    local_voice_command_get_last_command(last_voice_command, sizeof(last_voice_command));
    local_voice_command_get_last_error(local_voice_error, sizeof(local_voice_error));
    const char* effective_voice_error =
        g_voiceError[0] != '\0' ? g_voiceError : local_voice_error;
    cJSON* voice = cJSON_CreateObject();
    if (voice != NULL) {
        cJSON_AddBoolToObject(voice, "offline_voice_ready", g_voiceReady && local_voice_command_is_ready());
        cJSON_AddStringToObject(voice, "wake_word", wake_word);
        cJSON_AddStringToObject(voice, "last_voice_command", last_voice_command);
        cJSON_AddStringToObject(voice, "voice_error", effective_voice_error);
        cJSON_AddBoolToObject(voice, "command_window", local_voice_command_is_command_window_active());
        cJSON_AddStringToObject(voice, "online_query_status", g_voiceQueryStatus);
        cJSON_AddStringToObject(voice, "online_query_text", g_voiceQueryText);
        cJSON_AddStringToObject(voice, "online_query_date", g_voiceQueryDate);
        cJSON_AddStringToObject(voice, "online_query_answer", g_voiceQueryAnswer);
        cJSON_AddNumberToObject(voice, "online_query_updated_at", (double)g_voiceQueryUpdatedAt);
        cJSON_AddItemToObject(data, "voice", voice);
    }
    cJSON_AddBoolToObject(data, "offline_voice_ready", g_voiceReady && local_voice_command_is_ready());
    cJSON_AddStringToObject(data, "wake_word", wake_word);
    cJSON_AddStringToObject(data, "last_voice_command", last_voice_command);
    cJSON_AddStringToObject(data, "voice_error", effective_voice_error);
    cJSON_AddStringToObject(data, "online_query_status", g_voiceQueryStatus);
    cJSON_AddStringToObject(data, "online_query_text", g_voiceQueryText);
    cJSON_AddStringToObject(data, "online_query_date", g_voiceQueryDate);
    cJSON_AddStringToObject(data, "online_query_answer", g_voiceQueryAnswer);

    cJSON_AddItemToObject(root, "data", data);

    char* json = cJSON_PrintUnformatted(root);
    if (json != NULL) {
        mqtt_client_publish_string(topic, json, MQTT_QOS_1, false);
        free(json);
    }

    cJSON_Delete(root);
}

/**
 * @brief 打印系统信息
 */
static void printSystemInfo(void) {
    esp_chip_info_t chip_info;
    esp_chip_info(&chip_info);

    uint32_t flash_size = 0;
    esp_flash_get_size(NULL, &flash_size);
    
    ESP_LOGI(TAG, "芯片型号: %s", CONFIG_IDF_TARGET);
    ESP_LOGI(TAG, "CPU核心数: %d", chip_info.cores);
    ESP_LOGI(TAG, "CPU频率: %d MHz", CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ);
    ESP_LOGI(TAG, "Flash容量: %lu MB", (unsigned long)(flash_size / (1024 * 1024)));
    ESP_LOGI(TAG, "PSRAM容量: %lu MB", (unsigned long)(esp_psram_get_size() / (1024 * 1024)));
    ESP_LOGI(TAG, "可用堆栈: %lu bytes", (unsigned long)esp_get_free_heap_size());
    ESP_LOGI(TAG, "固件版本: v%s", FIRMWARE_VERSION_STR);
    ESP_LOGI(TAG, "编译时间: %s %s", __DATE__, __TIME__);
}

/**
 * @brief 打印复位原因
 */
static void printResetReason(void) {
    esp_reset_reason_t reason = esp_reset_reason();
    const char* reasonStr = "Unknown";
    
    switch (reason) {
        case ESP_RST_POWERON:   reasonStr = "Power-on"; break;
        case ESP_RST_EXT:       reasonStr = "External pin"; break;
        case ESP_RST_SW:        reasonStr = "Software"; break;
        case ESP_RST_PANIC:     reasonStr = "Exception/Panic"; break;
        case ESP_RST_INT_WDT:   reasonStr = "Interrupt watchdog"; break;
        case ESP_RST_TASK_WDT:  reasonStr = "Task watchdog"; break;
        case ESP_RST_WDT:       reasonStr = "Other watchdog"; break;
        case ESP_RST_DEEPSLEEP: reasonStr = "Deep sleep"; break;
        case ESP_RST_BROWNOUT:  reasonStr = "Brownout"; break;
        case ESP_RST_SDIO:      reasonStr = "SDIO"; break;
        default: break;
    }
    
    ESP_LOGI(TAG, "复位原因: %s (%d)", reasonStr, reason);
}

/**
 * @brief 初始化看门狗
 */
static void watchdogInit(void) {
    // 启用任务看门狗
    esp_task_wdt_config_t wdt_config = {};
    wdt_config.timeout_ms = 30000;
    wdt_config.idle_core_mask = (1 << portNUM_PROCESSORS) - 1;
    wdt_config.trigger_panic = true;

    esp_err_t err = esp_task_wdt_init(&wdt_config);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "看门狗初始化失败: %s", esp_err_to_name(err));
        return;
    }

    err = esp_task_wdt_add_user("main_loop", &g_wdtHandle);
    if (err != ESP_OK) {
        g_wdtHandle = NULL;
        ESP_LOGW(TAG, "看门狗用户注册失败: %s", esp_err_to_name(err));
        return;
    }

    ESP_LOGI(TAG, "看门狗初始化完成 (30秒超时)");
}

/**
 * @brief 喂养看门狗
 */
static void feedWatchdog(void) {
    if (g_wdtHandle != NULL) {
        esp_task_wdt_reset_user(g_wdtHandle);
    }
}

static void setVoiceError(const char* message) {
    if (message == NULL) {
        message = "";
    }
    strncpy(g_voiceError, message, sizeof(g_voiceError) - 1);
    g_voiceError[sizeof(g_voiceError) - 1] = '\0';
}

/**
 * @brief 进入安全模式
 * @param reason 进入安全模式的原因
 * @details 当系统初始化失败时，进入最小功能的安全模式
 */
static void enterSafeMode(const char* reason) {
    ESP_LOGE(TAG, "========================================");
    ESP_LOGE(TAG, "     进入安全模式");
    ESP_LOGE(TAG, "原因: %s", reason);
    ESP_LOGE(TAG, "========================================");
    
    // 关闭所有输出
#if STATUS_LED_PIN >= 0
    gpio_set_level(STATUS_LED_PIN, 0);
#endif
#if LED_EN_PIN >= 0
    gpio_set_level(LED_EN_PIN, 0);
#endif
#if ANION_PWR_PIN >= 0
    gpio_set_level(ANION_PWR_PIN, 0);
#endif
    
    // 快速闪烁状态灯表示安全模式
    for (;;) {
#if STATUS_LED_PIN >= 0
        gpio_set_level(STATUS_LED_PIN, 1);
#endif
        vTaskDelay(pdMS_TO_TICKS(200));
#if STATUS_LED_PIN >= 0
        gpio_set_level(STATUS_LED_PIN, 0);
#endif
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

/**
 * @brief 雷达数据回调
 */
static void radarDataCallback(radar_data_type_t type, const radar_data_union_t* data, void* user_data) {
    (void)user_data;
    
    switch (type) {
        case RADAR_DATA_TYPE_HEART_RATE:
            alarm_service_check_heart_rate(data->heart_rate.heart_rate);
            break;
            
        case RADAR_DATA_TYPE_BREATH_RATE:
            alarm_service_check_breathing_rate(data->breath_rate.breath_rate);
            break;
            
        case RADAR_DATA_TYPE_BODY_MOVEMENT:
            alarm_service_check_movement(data->body_movement.movement_level);
            break;
            
        default:
            break;
    }
    
    app_sleep_radar_callback(type, data, NULL);
    data_report_radar_callback(type, data, NULL);
}
