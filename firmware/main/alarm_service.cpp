/**
 * @file alarm_service.cpp
 * @brief 报警服务实现
 * @details 实现本地报警（蜂鸣器/LED）和远程报警（MQTT推送）
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 */

#include "alarm_service.h"
#include "mqtt_client.h"
#include "config.h"
#include <esp_log.h>
#include <cJSON.h>
#include <string.h>
#include <stdlib.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <driver/gpio.h>

static const char* TAG = "ALARM_SVC";

//=============================================================================
// 静态变量
//=============================================================================

static alarm_config_t s_config;
static alarm_record_t s_records[ALARM_MAX_ALARMS] = {};
static alarm_stats_t s_stats = {};
static SemaphoreHandle_t s_mutex = NULL;
static TaskHandle_t s_alarmTask = NULL;
static volatile bool s_taskRunning = false;
static alarm_callback_t s_callback = NULL;
static void* s_userData = NULL;
static bool s_initialized = false;
static bool s_alarmActive = false;

//=============================================================================
// 静态函数声明
//=============================================================================

static void alarmTask(void* pvParameters);
static void triggerLocalAlarm(alarm_level_t level);
static void triggerRemoteAlarm(const alarm_record_t* alarm);
static bool checkDedup(alarm_type_t type);
static const char* alarmTypeToString(alarm_type_t type);
static const char* alarmLevelToString(alarm_level_t level);

//=============================================================================
// API 实现
//=============================================================================

/**
 * @brief 初始化报警服务
 */
alarm_error_t alarm_service_init(const alarm_config_t* config) {
    ESP_LOGI(TAG, "初始化报警服务...");
    
    if (s_initialized) {
        ESP_LOGW(TAG, "报警服务已初始化");
        return ALARM_ERR_NONE;
    }
    
    if (config != NULL) {
        memcpy(&s_config, config, sizeof(alarm_config_t));
    } else {
        memset(&s_config, 0, sizeof(alarm_config_t));
        s_config.enable_local = true;
        s_config.enable_remote = true;
        s_config.enable_dedup = true;
        s_config.dedup_window_ms = ALARM_DEDUP_WINDOW_MS;
        s_config.heart_rate_high_threshold = ALARM_HEART_RATE_HIGH;
        s_config.heart_rate_low_threshold = ALARM_HEART_RATE_LOW;
        s_config.breathing_rate_high_threshold = ALARM_BREATHING_RATE_HIGH;
        s_config.breathing_rate_low_threshold = ALARM_BREATHING_RATE_LOW;
        s_config.no_movement_timeout_ms = ALARM_NO_BREATHING_TIME_MS;
    }
    
    memset(&s_stats, 0, sizeof(s_stats));
    memset(s_records, 0, sizeof(s_records));
    
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "创建互斥锁失败");
        return ALARM_ERR_INVALID_PARAM;
    }
    
    s_initialized = true;
    ESP_LOGI(TAG, "报警服务初始化完成");
    return ALARM_ERR_NONE;
}

/**
 * @brief 反初始化报警服务
 */
void alarm_service_deinit(void) {
    ESP_LOGI(TAG, "反初始化报警服务...");
    
    if (s_taskRunning) {
        s_taskRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_initialized = false;
    ESP_LOGI(TAG, "报警服务反初始化完成");
}

/**
 * @brief 触发报警
 */
alarm_error_t alarm_service_trigger(alarm_type_t type, alarm_level_t level, uint8_t value, const char* message) {
    if (!s_initialized) {
        return ALARM_ERR_NOT_INITIALIZED;
    }
    
    if (type <= ALARM_TYPE_NONE || type > ALARM_TYPE_SYSTEM_ERROR) {
        return ALARM_ERR_INVALID_PARAM;
    }
    
    if (s_config.enable_dedup && checkDedup(type)) {
        ESP_LOGD(TAG, "报警去重: 类型=%d", type);
        return ALARM_ERR_NONE;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    alarm_record_t* record = NULL;
    for (int i = 0; i < ALARM_MAX_ALARMS; i++) {
        if (s_records[i].state == ALARM_STATE_IDLE || s_records[i].state == ALARM_STATE_CLEARED) {
            record = &s_records[i];
            break;
        }
    }
    
    if (record == NULL) {
        xSemaphoreGive(s_mutex);
        ESP_LOGW(TAG, "报警记录已满");
        return ALARM_ERR_QUEUE_FULL;
    }
    
    memset(record, 0, sizeof(alarm_record_t));
    record->type = type;
    record->level = level;
    record->state = ALARM_STATE_TRIGGERED;
    record->timestamp = xTaskGetTickCount() / 1000;
    record->value = value;
    
    if (message != NULL) {
        strncpy(record->message, message, sizeof(record->message) - 1);
    } else {
        snprintf(record->message, sizeof(record->message), "%s", alarmTypeToString(type));
    }
    
    s_stats.total_triggered++;
    s_stats.by_type[type]++;
    s_stats.last_alarm_time = record->timestamp;
    
    xSemaphoreGive(s_mutex);
    
    if (s_config.enable_local) {
        triggerLocalAlarm(level);
    }
    
    if (s_config.enable_remote) {
        triggerRemoteAlarm(record);
    }
    
    if (s_callback != NULL) {
        s_callback(record, s_userData);
    }
    
    ESP_LOGW(TAG, "报警触发: 类型=%s, 级别=%s, 值=%d", 
             alarmTypeToString(type), alarmLevelToString(level), value);
    
    return ALARM_ERR_NONE;
}

/**
 * @brief 确认报警
 */
alarm_error_t alarm_service_acknowledge(int alarm_id) {
    if (!s_initialized || alarm_id < 0 || alarm_id >= ALARM_MAX_ALARMS) {
        return ALARM_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    if (s_records[alarm_id].state == ALARM_STATE_TRIGGERED) {
        s_records[alarm_id].state = ALARM_STATE_ACKNOWLEDGED;
        s_stats.total_acknowledged++;
    }
    
    xSemaphoreGive(s_mutex);
    
    return ALARM_ERR_NONE;
}

/**
 * @brief 清除报警
 */
alarm_error_t alarm_service_clear(int alarm_id) {
    if (!s_initialized || alarm_id < 0 || alarm_id >= ALARM_MAX_ALARMS) {
        return ALARM_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    if (s_records[alarm_id].state != ALARM_STATE_CLEARED) {
        s_records[alarm_id].state = ALARM_STATE_CLEARED;
        s_stats.total_cleared++;
    }
    
    xSemaphoreGive(s_mutex);
    
    return ALARM_ERR_NONE;
}

/**
 * @brief 清除所有报警
 */
alarm_error_t alarm_service_clear_all(void) {
    if (!s_initialized) {
        return ALARM_ERR_NOT_INITIALIZED;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    for (int i = 0; i < ALARM_MAX_ALARMS; i++) {
        if (s_records[i].state != ALARM_STATE_CLEARED) {
            s_records[i].state = ALARM_STATE_CLEARED;
            s_stats.total_cleared++;
        }
    }
    
    xSemaphoreGive(s_mutex);
    
    return ALARM_ERR_NONE;
}

/**
 * @brief 设置配置
 */
alarm_error_t alarm_service_set_config(const alarm_config_t* config) {
    if (!s_initialized || config == NULL) {
        return ALARM_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memcpy(&s_config, config, sizeof(alarm_config_t));
    xSemaphoreGive(s_mutex);
    
    return ALARM_ERR_NONE;
}

/**
 * @brief 获取当前配置
 */
void alarm_service_get_config(alarm_config_t* config) {
    if (config != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(config, &s_config, sizeof(alarm_config_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 获取报警记录
 */
int alarm_service_get_records(alarm_record_t* records, int max_count) {
    if (!s_initialized || records == NULL || max_count <= 0) {
        return 0;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    int count = 0;
    for (int i = 0; i < ALARM_MAX_ALARMS && count < max_count; i++) {
        if (s_records[i].state != ALARM_STATE_CLEARED) {
            memcpy(&records[count], &s_records[i], sizeof(alarm_record_t));
            count++;
        }
    }
    
    xSemaphoreGive(s_mutex);
    return count;
}

/**
 * @brief 获取统计信息
 */
void alarm_service_get_stats(alarm_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(stats, &s_stats, sizeof(alarm_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 设置报警回调
 */
void alarm_service_set_callback(alarm_callback_t callback, void* user_data) {
    s_callback = callback;
    s_userData = user_data;
}

/**
 * @brief 检查心率报警
 */
alarm_error_t alarm_service_check_heart_rate(uint8_t heart_rate) {
    if (!s_initialized) {
        return ALARM_ERR_NOT_INITIALIZED;
    }
    
    if (heart_rate > s_config.heart_rate_high_threshold) {
        return alarm_service_trigger(ALARM_TYPE_HEART_RATE_HIGH, ALARM_LEVEL_WARNING, 
                                   heart_rate, "心率过高");
    } else if (heart_rate > 0 && heart_rate < s_config.heart_rate_low_threshold) {
        return alarm_service_trigger(ALARM_TYPE_HEART_RATE_LOW, ALARM_LEVEL_CRITICAL, 
                                   heart_rate, "心率过低");
    }
    
    return ALARM_ERR_NONE;
}

/**
 * @brief 检查呼吸率报警
 */
alarm_error_t alarm_service_check_breathing_rate(uint8_t breathing_rate) {
    if (!s_initialized) {
        return ALARM_ERR_NOT_INITIALIZED;
    }
    
    if (breathing_rate > s_config.breathing_rate_high_threshold) {
        return alarm_service_trigger(ALARM_TYPE_BREATHING_RATE_HIGH, ALARM_LEVEL_WARNING, 
                                   breathing_rate, "呼吸率过高");
    } else if (breathing_rate > 0 && breathing_rate < s_config.breathing_rate_low_threshold) {
        return alarm_service_trigger(ALARM_TYPE_BREATHING_RATE_LOW, ALARM_LEVEL_CRITICAL, 
                                   breathing_rate, "呼吸率过低");
    }
    
    return ALARM_ERR_NONE;
}

/**
 * @brief 检查体动报警
 */
alarm_error_t alarm_service_check_movement(uint8_t movement_level) {
    if (!s_initialized) {
        return ALARM_ERR_NOT_INITIALIZED;
    }
    
    if (movement_level == 0) {
        return alarm_service_trigger(ALARM_TYPE_NO_MOVEMENT, ALARM_LEVEL_WARNING, 
                                   0, "无体动");
    }
    
    return ALARM_ERR_NONE;
}

//=============================================================================
// 静态函数实现
//=============================================================================

/**
 * @brief 报警任务
 */
static void alarmTask(void* pvParameters) {
    (void)pvParameters;
    
    ESP_LOGI(TAG, "报警任务启动");
    
    while (s_taskRunning) {
        vTaskDelay(pdMS_TO_TICKS(100));
        
        if (s_alarmActive) {
            static bool ledState = false;
            ledState = !ledState;
#if STATUS_LED_PIN >= 0
            gpio_set_level(STATUS_LED_PIN, ledState ? 1 : 0);
#endif
#if BUZZER_PIN >= 0
            gpio_set_level(BUZZER_PIN, ledState ? 1 : 0);
#endif
        }
    }
    
    ESP_LOGI(TAG, "报警任务结束");
    vTaskDelete(NULL);
}

/**
 * @brief 触发本地报警
 */
static void triggerLocalAlarm(alarm_level_t level) {
    s_alarmActive = true;
    
    if (!s_taskRunning) {
        BaseType_t result = xTaskCreatePinnedToCore(
            alarmTask,
            "AlarmTask",
            4096,
            NULL,
            TASK_PRIORITY_HIGH,
            &s_alarmTask,
            0
        );
        
        if (result == pdPASS) {
            s_taskRunning = true;
        }
    }
    
    ESP_LOGW(TAG, "本地报警触发: 级别=%s", alarmLevelToString(level));
}

/**
 * @brief 触发远程报警
 */
static void triggerRemoteAlarm(const alarm_record_t* alarm) {
    if (!mqtt_client_is_connected()) {
        ESP_LOGW(TAG, "MQTT未连接，无法发送远程报警");
        return;
    }
    
    cJSON* root = cJSON_CreateObject();
    if (root == NULL) {
        return;
    }
    
    cJSON_AddStringToObject(root, "device_id", "lamp_001");
    cJSON_AddNumberToObject(root, "timestamp", alarm->timestamp);
    cJSON_AddStringToObject(root, "alarm_type", alarmTypeToString(alarm->type));
    cJSON_AddStringToObject(root, "alarm_level", alarmLevelToString(alarm->level));
    cJSON_AddNumberToObject(root, "value", alarm->value);
    cJSON_AddStringToObject(root, "message", alarm->message);
    
    char* json_str = cJSON_Print(root);
    cJSON_Delete(root);
    
    if (json_str == NULL) {
        return;
    }
    
    bool success = mqtt_client_publish_string("sleep/lamp_001/alarm", json_str, 
                                          MQTT_QOS_1, false);
    
    if (success) {
        ESP_LOGI(TAG, "远程报警发送成功");
    } else {
        ESP_LOGE(TAG, "远程报警发送失败");
    }
    
    free(json_str);
}

/**
 * @brief 检查去重
 */
static bool checkDedup(alarm_type_t type) {
    uint32_t currentTime = xTaskGetTickCount() / 1000;
    
    for (int i = 0; i < ALARM_MAX_ALARMS; i++) {
        if (s_records[i].type == type && 
            s_records[i].state == ALARM_STATE_TRIGGERED &&
            (currentTime - s_records[i].timestamp) < (s_config.dedup_window_ms / 1000)) {
            return true;
        }
    }
    
    return false;
}

/**
 * @brief 报警类型转字符串
 */
static const char* alarmTypeToString(alarm_type_t type) {
    switch (type) {
        case ALARM_TYPE_HEART_RATE_HIGH: return "heart_rate_high";
        case ALARM_TYPE_HEART_RATE_LOW: return "heart_rate_low";
        case ALARM_TYPE_BREATHING_RATE_HIGH: return "breathing_rate_high";
        case ALARM_TYPE_BREATHING_RATE_LOW: return "breathing_rate_low";
        case ALARM_TYPE_NO_MOVEMENT: return "no_movement";
        case ALARM_TYPE_APNEA: return "apnea";
        case ALARM_TYPE_SLEEP_ABNORMAL: return "sleep_abnormal";
        case ALARM_TYPE_SYSTEM_ERROR: return "system_error";
        default: return "unknown";
    }
}

/**
 * @brief 报警级别转字符串
 */
static const char* alarmLevelToString(alarm_level_t level) {
    switch (level) {
        case ALARM_LEVEL_INFO: return "info";
        case ALARM_LEVEL_WARNING: return "warning";
        case ALARM_LEVEL_CRITICAL: return "critical";
        default: return "unknown";
    }
}
