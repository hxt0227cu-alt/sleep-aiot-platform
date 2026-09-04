/**
 * @file app_sleep.cpp
 * @brief 睡眠监测应用层实现
 * @details 负责睡眠数据采集、分析处理、异常检测、数据上报和睡眠质量评分
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#include <string.h>
#include <stdio.h>
#include <math.h>
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "cJSON.h"
#include "app_sleep.h"
#include "mqtt_client.h"
#include "alarm_service.h"
#include "config.h"

static const char* TAG = "APP_SLEEP";

//=============================================================================
// 全局变量
//=============================================================================

// 模块状态
static volatile bool g_initialized = false;
static volatile app_sleep_state_t g_state = APP_SLEEP_STATE_IDLE;

// 任务句柄
static TaskHandle_t g_task_handle = NULL;
static volatile bool g_task_running = false;

// 同步原语
static SemaphoreHandle_t g_mutex = NULL;

// 配置
static app_sleep_config_t g_config;

// 实时数据
static app_sleep_realtime_data_t g_realtime_data;

// 睡眠统计
static app_sleep_statistics_t g_statistics;

// 睡眠质量评分
static app_sleep_score_t g_sleep_score;

// 异常检测
static app_sleep_alarm_t g_alarm;

// 统计信息
static app_sleep_stats_t g_stats;

// 回调函数
static app_sleep_data_callback_t g_data_callback = NULL;
static void* g_data_callback_user_data = NULL;

static app_sleep_stats_callback_t g_stats_callback = NULL;
static void* g_stats_callback_user_data = NULL;

static app_sleep_score_callback_t g_score_callback = NULL;
static void* g_score_callback_user_data = NULL;

static app_sleep_alarm_callback_t g_alarm_callback = NULL;
static void* g_alarm_callback_user_data = NULL;

// 数据缓存
static app_sleep_realtime_data_t g_data_cache[APP_SLEEP_CACHE_SIZE];
static uint16_t g_cache_index = 0;

// 时间跟踪
static uint32_t g_last_analysis_time = 0;
static uint32_t g_last_report_time = 0;
static uint32_t g_last_score_update_time = 0;

// 睡眠阶段跟踪
static uint8_t g_last_sleep_state = R60ABD1_SLEEP_NONE;
static uint32_t g_sleep_state_start_time = 0;

//=============================================================================
// 内部函数声明
//=============================================================================
static void app_sleep_task(void* pvParameters);
static void process_radar_data(radar_data_type_t type, const radar_data_union_t* data);
static void analyze_sleep_data(void);
static void calculate_sleep_score(void);
static void detect_alarms(void);
static void report_data(void);
static void update_statistics(void);
static void get_device_id(char* buffer, size_t buffer_size);
static void reset_realtime_data(void);
static void reset_statistics(void);
static void reset_alarm(void);
static void reset_score(void);
static bool is_valid_heart_rate(uint8_t rate);
static bool is_valid_breathing_rate(uint8_t rate);
static uint8_t calculate_duration_score(uint32_t total_duration_sec);
static uint8_t calculate_deep_sleep_score(float deep_sleep_ratio);
static uint8_t calculate_continuity_score(uint8_t away_count, uint32_t away_duration_sec);
static uint8_t calculate_heart_rate_score(uint8_t avg, uint8_t min, uint8_t max);
static uint8_t calculate_breathing_score(uint8_t avg, uint8_t min, uint8_t max);
static uint8_t calculate_movement_score(uint8_t turn_over_count, uint8_t large_move_pct);
static sleep_quality_t determine_quality_level(uint8_t total_score);

//=============================================================================
// API 函数实现
//=============================================================================

/**
 * @brief 初始化睡眠监测应用层
 */
app_sleep_error_t app_sleep_init(const app_sleep_config_t* config) {
    ESP_LOGI(TAG, "初始化睡眠监测应用层 v%s", APP_SLEEP_VERSION_STR);
    
    if (g_initialized) {
        ESP_LOGW(TAG, "已经初始化");
        return APP_SLEEP_ERR_ALREADY_RUNNING;
    }
    
    g_mutex = xSemaphoreCreateMutex();
    if (g_mutex == NULL) {
        ESP_LOGE(TAG, "互斥锁创建失败");
        return APP_SLEEP_ERR_NO_MEMORY;
    }
    
    if (config != NULL) {
        memcpy(&g_config, config, sizeof(app_sleep_config_t));
    } else {
        // 使用默认配置
        memset(&g_config, 0, sizeof(app_sleep_config_t));
        g_config.enable_monitoring = true;
        g_config.enable_analysis = true;
        g_config.enable_report = true;
        g_config.enable_cache = true;
        g_config.enable_alarm = true;
        g_config.analysis_interval_ms = APP_SLEEP_ANALYSIS_INTERVAL_MS;
        g_config.report_interval_ms = APP_SLEEP_REPORT_INTERVAL_MS;
        g_config.cache_max_size = APP_SLEEP_CACHE_SIZE;
        g_config.heart_rate_high_threshold = ALARM_HEART_RATE_HIGH;
        g_config.heart_rate_low_threshold = ALARM_HEART_RATE_LOW;
        g_config.breathing_rate_high_threshold = ALARM_BREATHING_RATE_HIGH;
        g_config.breathing_rate_low_threshold = ALARM_BREATHING_RATE_LOW;
        g_config.no_movement_timeout_ms = ALARM_NO_BREATHING_TIME_MS;
    }
    
    // 重置数据结构
    reset_realtime_data();
    reset_statistics();
    reset_alarm();
    reset_score();
    
    // 重置统计信息
    memset(&g_stats, 0, sizeof(app_sleep_stats_t));
    
    g_initialized = true;
    g_state = APP_SLEEP_STATE_IDLE;
    
    ESP_LOGI(TAG, "睡眠监测应用层初始化完成");
    return APP_SLEEP_ERR_NONE;
}

/**
 * @brief 反初始化睡眠监测应用层
 */
void app_sleep_deinit(void) {
    ESP_LOGI(TAG, "反初始化睡眠监测应用层");
    
    if (!g_initialized) {
        return;
    }
    
    // 停止任务
    app_sleep_stop();
    
    if (g_mutex != NULL) {
        vSemaphoreDelete(g_mutex);
        g_mutex = NULL;
    }
    
    g_initialized = false;
    g_state = APP_SLEEP_STATE_IDLE;
    
    ESP_LOGI(TAG, "睡眠监测应用层反初始化完成");
}

/**
 * @brief 启动睡眠监测
 */
app_sleep_error_t app_sleep_start(void) {
    ESP_LOGI(TAG, "启动睡眠监测");
    
    if (!g_initialized) {
        ESP_LOGE(TAG, "未初始化");
        return APP_SLEEP_ERR_NOT_INITIALIZED;
    }
    
    if (g_state != APP_SLEEP_STATE_IDLE) {
        ESP_LOGW(TAG, "已经在运行");
        return APP_SLEEP_ERR_ALREADY_RUNNING;
    }
    
    BaseType_t result = xTaskCreatePinnedToCore(
        app_sleep_task,
        "SleepTask",
        APP_SLEEP_TASK_STACK_SIZE,
        NULL,
        APP_SLEEP_TASK_PRIORITY,
        &g_task_handle,
        1
    );
    
    if (result != pdPASS) {
        ESP_LOGE(TAG, "任务创建失败");
        return APP_SLEEP_ERR_NO_MEMORY;
    }
    
    g_state = APP_SLEEP_STATE_MONITORING;
    ESP_LOGI(TAG, "睡眠监测已启动");
    
    return APP_SLEEP_ERR_NONE;
}

/**
 * @brief 停止睡眠监测
 */
void app_sleep_stop(void) {
    ESP_LOGI(TAG, "停止睡眠监测");
    
    if (g_task_handle != NULL) {
        g_task_running = false;
        
        for (int i = 0; i < 10; i++) {
            if (eTaskGetState(g_task_handle) == eDeleted) {
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(50));
        }
        
        g_task_handle = NULL;
    }
    
    g_state = APP_SLEEP_STATE_IDLE;
    ESP_LOGI(TAG, "睡眠监测已停止");
}

/**
 * @brief 获取当前状态
 */
app_sleep_state_t app_sleep_get_state(void) {
    return g_state;
}

/**
 * @brief 设置配置
 */
app_sleep_error_t app_sleep_set_config(const app_sleep_config_t* config) {
    if (config == NULL) {
        return APP_SLEEP_ERR_INVALID_PARAM;
    }
    
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        memcpy(&g_config, config, sizeof(app_sleep_config_t));
        xSemaphoreGive(g_mutex);
        return APP_SLEEP_ERR_NONE;
    }
    
    return APP_SLEEP_ERR_TIMEOUT;
}

/**
 * @brief 获取当前配置
 */
void app_sleep_get_config(app_sleep_config_t* config) {
    if (config != NULL) {
        if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            memcpy(config, &g_config, sizeof(app_sleep_config_t));
            xSemaphoreGive(g_mutex);
        }
    }
}

/**
 * @brief 获取实时睡眠数据
 */
app_sleep_error_t app_sleep_get_realtime_data(app_sleep_realtime_data_t* data) {
    if (data == NULL) {
        return APP_SLEEP_ERR_INVALID_PARAM;
    }
    
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        memcpy(data, &g_realtime_data, sizeof(app_sleep_realtime_data_t));
        xSemaphoreGive(g_mutex);
        return APP_SLEEP_ERR_NONE;
    }
    
    return APP_SLEEP_ERR_TIMEOUT;
}

/**
 * @brief 获取睡眠统计
 */
app_sleep_error_t app_sleep_get_statistics(app_sleep_statistics_t* stats) {
    if (stats == NULL) {
        return APP_SLEEP_ERR_INVALID_PARAM;
    }
    
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        memcpy(stats, &g_statistics, sizeof(app_sleep_statistics_t));
        xSemaphoreGive(g_mutex);
        return APP_SLEEP_ERR_NONE;
    }
    
    return APP_SLEEP_ERR_TIMEOUT;
}

/**
 * @brief 获取睡眠质量评分
 */
app_sleep_error_t app_sleep_get_score(app_sleep_score_t* score) {
    if (score == NULL) {
        return APP_SLEEP_ERR_INVALID_PARAM;
    }
    
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        memcpy(score, &g_sleep_score, sizeof(app_sleep_score_t));
        xSemaphoreGive(g_mutex);
        return APP_SLEEP_ERR_NONE;
    }
    
    return APP_SLEEP_ERR_TIMEOUT;
}

/**
 * @brief 获取异常检测状态
 */
app_sleep_error_t app_sleep_get_alarm(app_sleep_alarm_t* alarm) {
    if (alarm == NULL) {
        return APP_SLEEP_ERR_INVALID_PARAM;
    }
    
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        memcpy(alarm, &g_alarm, sizeof(app_sleep_alarm_t));
        xSemaphoreGive(g_mutex);
        return APP_SLEEP_ERR_NONE;
    }
    
    return APP_SLEEP_ERR_TIMEOUT;
}

/**
 * @brief 手动触发数据分析
 */
app_sleep_error_t app_sleep_analyze_now(void) {
    if (!g_initialized) {
        return APP_SLEEP_ERR_NOT_INITIALIZED;
    }
    
    analyze_sleep_data();
    return APP_SLEEP_ERR_NONE;
}

/**
 * @brief 手动触发数据上报
 */
app_sleep_error_t app_sleep_report_now(void) {
    if (!g_initialized) {
        return APP_SLEEP_ERR_NOT_INITIALIZED;
    }
    
    report_data();
    return APP_SLEEP_ERR_NONE;
}

/**
 * @brief 重置睡眠统计
 */
app_sleep_error_t app_sleep_reset_statistics(void) {
    if (!g_initialized) {
        return APP_SLEEP_ERR_NOT_INITIALIZED;
    }
    
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        reset_statistics();
        reset_alarm();
        reset_score();
        xSemaphoreGive(g_mutex);
        return APP_SLEEP_ERR_NONE;
    }
    
    return APP_SLEEP_ERR_TIMEOUT;
}

/**
 * @brief 获取统计信息
 */
void app_sleep_get_stats(app_sleep_stats_t* stats) {
    if (stats != NULL) {
        if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            memcpy(stats, &g_stats, sizeof(app_sleep_stats_t));
            xSemaphoreGive(g_mutex);
        }
    }
}

/**
 * @brief 注册睡眠数据回调
 */
void app_sleep_register_data_callback(app_sleep_data_callback_t callback, void* user_data) {
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        g_data_callback = callback;
        g_data_callback_user_data = user_data;
        xSemaphoreGive(g_mutex);
    }
}

/**
 * @brief 注册睡眠统计回调
 */
void app_sleep_register_stats_callback(app_sleep_stats_callback_t callback, void* user_data) {
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        g_stats_callback = callback;
        g_stats_callback_user_data = user_data;
        xSemaphoreGive(g_mutex);
    }
}

/**
 * @brief 注册睡眠质量评分回调
 */
void app_sleep_register_score_callback(app_sleep_score_callback_t callback, void* user_data) {
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        g_score_callback = callback;
        g_score_callback_user_data = user_data;
        xSemaphoreGive(g_mutex);
    }
}

/**
 * @brief 注册异常报警回调
 */
void app_sleep_register_alarm_callback(app_sleep_alarm_callback_t callback, void* user_data) {
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        g_alarm_callback = callback;
        g_alarm_callback_user_data = user_data;
        xSemaphoreGive(g_mutex);
    }
}

/**
 * @brief 雷达数据回调（内部调用）
 */
void app_sleep_radar_callback(radar_data_type_t type, const radar_data_union_t* data, void* user_data) {
    (void)user_data;
    
    if (!g_initialized || g_state != APP_SLEEP_STATE_MONITORING) {
        return;
    }
    
    process_radar_data(type, data);
}

//=============================================================================
// 内部函数实现
//=============================================================================

/**
 * @brief 睡眠监测任务
 */
static void app_sleep_task(void* pvParameters) {
    (void)pvParameters;
    
    ESP_LOGI(TAG, "睡眠监测任务启动");
    
    TickType_t xLastWakeTime = xTaskGetTickCount();
    const TickType_t xFrequency = pdMS_TO_TICKS(100);
    
    uint64_t start_time_ms = (uint64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
    
    g_task_running = true;
    
    while (g_task_running) {
        vTaskDelayUntil(&xLastWakeTime, xFrequency);
        
        uint64_t current_time_ms = (uint64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
        
        bool enable_analysis = false;
        bool enable_report = false;
        bool enable_alarm = false;
        uint32_t analysis_interval_ms = 0;
        uint32_t report_interval_ms = 0;
        
        if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            g_stats.uptime_seconds = (uint32_t)((current_time_ms - start_time_ms) / 1000);
            enable_analysis = g_config.enable_analysis;
            enable_report = g_config.enable_report;
            enable_alarm = g_config.enable_alarm;
            analysis_interval_ms = g_config.analysis_interval_ms;
            report_interval_ms = g_config.report_interval_ms;
            xSemaphoreGive(g_mutex);
        }
        
        if (enable_analysis && 
            (current_time_ms - g_last_analysis_time >= analysis_interval_ms)) {
            g_last_analysis_time = (uint32_t)current_time_ms;
            analyze_sleep_data();
        }
        
        if (enable_report && 
            (current_time_ms - g_last_report_time >= report_interval_ms)) {
            g_last_report_time = (uint32_t)current_time_ms;
            report_data();
        }
        
        if ((current_time_ms - g_last_score_update_time >= APP_SLEEP_SCORE_UPDATE_INTERVAL_MS)) {
            g_last_score_update_time = (uint32_t)current_time_ms;
            calculate_sleep_score();
        }
        
        if (enable_alarm) {
            detect_alarms();
        }
    }
    
    ESP_LOGI(TAG, "睡眠监测任务退出");
    vTaskDelete(NULL);
}

/**
 * @brief 处理雷达数据
 */
static void process_radar_data(radar_data_type_t type, const radar_data_union_t* data) {
    if (data == NULL) {
        return;
    }
    
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "获取互斥锁超时，跳过数据处理");
        return;
    }
    
    g_stats.total_samples++;
    
    switch (type) {
        case RADAR_DATA_TYPE_HEART_RATE:
            if (is_valid_heart_rate(data->heart_rate.heart_rate)) {
                g_realtime_data.heart_rate = data->heart_rate.heart_rate;
                g_realtime_data.heart_rate_valid = true;
                g_realtime_data.timestamp = data->heart_rate.timestamp;
                g_stats.valid_samples++;
            }
            break;
            
        case RADAR_DATA_TYPE_BREATH_RATE:
            if (is_valid_breathing_rate(data->breath_rate.breath_rate)) {
                g_realtime_data.breathing_rate = data->breath_rate.breath_rate;
                g_realtime_data.breathing_rate_valid = true;
                g_realtime_data.timestamp = data->breath_rate.timestamp;
                g_stats.valid_samples++;
            }
            break;
            
        case RADAR_DATA_TYPE_BODY_MOVEMENT:
            g_realtime_data.movement_level = data->body_movement.movement_level;
            g_realtime_data.movement_valid = true;
            g_realtime_data.timestamp = data->body_movement.timestamp;
            g_stats.valid_samples++;
            break;
            
        case RADAR_DATA_TYPE_SLEEP_STATE:
            g_realtime_data.sleep_state = data->sleep_state.sleep_state;
            g_realtime_data.sleep_state_valid = true;
            g_realtime_data.timestamp = data->sleep_state.timestamp;
            g_stats.valid_samples++;
            break;
            
        case RADAR_DATA_TYPE_BED_STATUS:
            g_realtime_data.bed_state = data->bed_status.bed_state;
            g_realtime_data.bed_state_valid = true;
            g_realtime_data.timestamp = data->bed_status.timestamp;
            g_stats.valid_samples++;
            break;
            
        case RADAR_DATA_TYPE_PRESENCE:
            g_realtime_data.presence = data->presence.presence;
            g_realtime_data.presence_valid = true;
            g_realtime_data.timestamp = data->presence.timestamp;
            g_stats.valid_samples++;
            break;
            
        case RADAR_DATA_TYPE_BODY_DISTANCE:
            g_realtime_data.distance_cm = data->body_distance.distance_cm;
            g_realtime_data.distance_valid = true;
            g_realtime_data.timestamp = data->body_distance.timestamp;
            g_stats.valid_samples++;
            break;
            
        case RADAR_DATA_TYPE_SLEEP_COMPOSITE:
            if (data->sleep_composite.presence == R60ABD1_PRESENCE_DETECTED) {
                g_realtime_data.presence = 1;
                g_realtime_data.presence_valid = true;
            }
            if (is_valid_breathing_rate(data->sleep_composite.avg_breath)) {
                g_realtime_data.breathing_rate = data->sleep_composite.avg_breath;
                g_realtime_data.breathing_rate_valid = true;
            }
            if (is_valid_heart_rate(data->sleep_composite.avg_heart)) {
                g_realtime_data.heart_rate = data->sleep_composite.avg_heart;
                g_realtime_data.heart_rate_valid = true;
            }
            g_realtime_data.movement_level =
                (uint8_t)((data->sleep_composite.large_move_pct + data->sleep_composite.small_move_pct) > 100
                    ? 100
                    : (data->sleep_composite.large_move_pct + data->sleep_composite.small_move_pct));
            g_realtime_data.movement_valid = true;
            g_realtime_data.sleep_state = data->sleep_composite.sleep_state;
            g_realtime_data.sleep_state_valid = true;
            g_realtime_data.timestamp = data->sleep_composite.timestamp;
            g_stats.valid_samples++;
            break;
            
        default:
            break;
    }
    
    g_realtime_data.valid = true;
    g_stats.last_update_time = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    
    app_sleep_data_callback_t callback = g_data_callback;
    void* user_data = g_data_callback_user_data;
    
    if (g_config.enable_cache) {
        memcpy(&g_data_cache[g_cache_index], &g_realtime_data, sizeof(app_sleep_realtime_data_t));
        g_cache_index = (g_cache_index + 1) % APP_SLEEP_CACHE_SIZE;
    }
    
    app_sleep_realtime_data_t data_copy;
    memcpy(&data_copy, &g_realtime_data, sizeof(app_sleep_realtime_data_t));
    
    xSemaphoreGive(g_mutex);
    
    if (callback != NULL) {
        callback(&data_copy, user_data);
    }
}

/**
 * @brief 分析睡眠数据
 */
static void analyze_sleep_data(void) {
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "获取互斥锁超时，跳过数据分析");
        return;
    }
    
    g_state = APP_SLEEP_STATE_ANALYZING;
    
    update_statistics();
    
    g_stats.analysis_count++;
    g_state = APP_SLEEP_STATE_MONITORING;
    
    app_sleep_stats_callback_t callback = g_stats_callback;
    void* user_data = g_stats_callback_user_data;
    
    xSemaphoreGive(g_mutex);
    
    if (callback != NULL) {
        callback(&g_statistics, user_data);
    }
}

/**
 * @brief 计算睡眠质量评分
 */
static void calculate_sleep_score(void) {
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "获取互斥锁超时，跳过评分计算");
        return;
    }
    
    if (!g_statistics.valid) {
        xSemaphoreGive(g_mutex);
        return;
    }
    
    uint32_t total_duration_min = g_statistics.total_duration_sec / 60;
    g_sleep_score.duration_score = calculate_duration_score(g_statistics.total_duration_sec);
    
    float deep_sleep_ratio = 0.0f;
    if (total_duration_min > 0) {
        deep_sleep_ratio = (float)g_statistics.deep_sleep_duration_sec / (float)g_statistics.total_duration_sec;
    }
    g_sleep_score.deep_sleep_score = calculate_deep_sleep_score(deep_sleep_ratio);
    
    g_sleep_score.continuity_score = calculate_continuity_score(
        g_statistics.away_count, 
        g_statistics.away_duration_sec
    );
    
    g_sleep_score.heart_rate_score = calculate_heart_rate_score(
        g_statistics.heart_rate_avg,
        g_statistics.heart_rate_min,
        g_statistics.heart_rate_max
    );
    
    g_sleep_score.breathing_score = calculate_breathing_score(
        g_statistics.breathing_rate_avg,
        g_statistics.breathing_rate_min,
        g_statistics.breathing_rate_max
    );
    
    g_sleep_score.movement_score = calculate_movement_score(
        g_statistics.turn_over_count,
        0
    );
    
    g_sleep_score.total_score = (
        g_sleep_score.duration_score * 20 +
        g_sleep_score.deep_sleep_score * 25 +
        g_sleep_score.continuity_score * 15 +
        g_sleep_score.heart_rate_score * 15 +
        g_sleep_score.breathing_score * 15 +
        g_sleep_score.movement_score * 10
    ) / 100;
    
    g_sleep_score.quality_level = determine_quality_level(g_sleep_score.total_score);
    g_sleep_score.timestamp = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    g_sleep_score.valid = true;
    
    app_sleep_score_callback_t callback = g_score_callback;
    void* user_data = g_score_callback_user_data;
    
    xSemaphoreGive(g_mutex);
    
    if (callback != NULL) {
        callback(&g_sleep_score, user_data);
    }
}

/**
 * @brief 检测异常
 */
static void detect_alarms(void) {
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "获取互斥锁超时，跳过异常检测");
        return;
    }
    
    if (!g_realtime_data.valid) {
        xSemaphoreGive(g_mutex);
        return;
    }
    
    bool alarm_triggered = false;
    uint64_t current_time = (uint64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
    
    if (g_realtime_data.heart_rate_valid && 
        g_realtime_data.heart_rate > g_config.heart_rate_high_threshold) {
        if (!g_alarm.heart_rate_high) {
            g_alarm.heart_rate_high = true;
            alarm_triggered = true;
            ESP_LOGW(TAG, "心率过高: %d bpm", g_realtime_data.heart_rate);
        }
    } else {
        g_alarm.heart_rate_high = false;
    }
    
    if (g_realtime_data.heart_rate_valid && 
        g_realtime_data.heart_rate < g_config.heart_rate_low_threshold) {
        if (!g_alarm.heart_rate_low) {
            g_alarm.heart_rate_low = true;
            alarm_triggered = true;
            ESP_LOGW(TAG, "心率过低: %d bpm", g_realtime_data.heart_rate);
        }
    } else {
        g_alarm.heart_rate_low = false;
    }
    
    if (g_realtime_data.breathing_rate_valid && 
        g_realtime_data.breathing_rate > g_config.breathing_rate_high_threshold) {
        if (!g_alarm.breathing_rate_high) {
            g_alarm.breathing_rate_high = true;
            alarm_triggered = true;
            ESP_LOGW(TAG, "呼吸率过高: %d 次/分钟", g_realtime_data.breathing_rate);
        }
    } else {
        g_alarm.breathing_rate_high = false;
    }
    
    if (g_realtime_data.breathing_rate_valid && 
        g_realtime_data.breathing_rate < g_config.breathing_rate_low_threshold) {
        if (!g_alarm.breathing_rate_low) {
            g_alarm.breathing_rate_low = true;
            alarm_triggered = true;
            ESP_LOGW(TAG, "呼吸率过低: %d 次/分钟", g_realtime_data.breathing_rate);
        }
    } else {
        g_alarm.breathing_rate_low = false;
    }
    
    if (alarm_triggered) {
        g_alarm.last_alarm_time = (uint32_t)current_time;
        g_alarm.alarm_count++;
        g_stats.alarm_count++;
    }
    
    uint8_t heart_rate = g_realtime_data.heart_rate;
    bool heart_rate_valid = g_realtime_data.heart_rate_valid;
    uint8_t breathing_rate = g_realtime_data.breathing_rate;
    bool breathing_rate_valid = g_realtime_data.breathing_rate_valid;
    uint8_t movement_level = g_realtime_data.movement_level;
    bool movement_valid = g_realtime_data.movement_valid;
    
    app_sleep_alarm_callback_t callback = g_alarm_callback;
    void* user_data = g_alarm_callback_user_data;
    
    xSemaphoreGive(g_mutex);
    
    if (alarm_triggered && callback != NULL) {
        callback(&g_alarm, user_data);
    }
    
    if (heart_rate_valid) {
        alarm_service_check_heart_rate(heart_rate);
    }
    if (breathing_rate_valid) {
        alarm_service_check_breathing_rate(breathing_rate);
    }
    if (movement_valid) {
        alarm_service_check_movement(movement_level);
    }
}

static void get_device_id(char* buffer, size_t buffer_size) {
    if (buffer == NULL || buffer_size == 0) {
        return;
    }

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(buffer, buffer_size, "%s%02X%02X%02X%02X%02X%02X",
             MQTT_CLIENT_ID_PREFIX,
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

/**
 * @brief 上报数据到MQTT
 */
static void report_data(void) {
    if (!mqtt_client_is_connected()) {
        ESP_LOGW(TAG, "MQTT未连接，跳过数据上报");
        return;
    }
    
    if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "获取互斥锁超时，跳过数据上报");
        return;
    }
    
    if (!g_realtime_data.valid) {
        xSemaphoreGive(g_mutex);
        ESP_LOGD(TAG, "No valid radar data yet, skip sleep data report");
        return;
    }

    g_state = APP_SLEEP_STATE_REPORTING;
    
    cJSON* root = cJSON_CreateObject();
    if (root == NULL) {
        ESP_LOGE(TAG, "JSON创建失败");
        g_state = APP_SLEEP_STATE_MONITORING;
        xSemaphoreGive(g_mutex);
        return;
    }

    cJSON* payload = cJSON_CreateObject();
    if (payload == NULL) {
        ESP_LOGE(TAG, "JSON数据对象创建失败");
        cJSON_Delete(root);
        g_state = APP_SLEEP_STATE_MONITORING;
        xSemaphoreGive(g_mutex);
        return;
    }

    char deviceId[MQTT_MAX_CLIENT_ID_LEN];
    get_device_id(deviceId, sizeof(deviceId));
    cJSON_AddNumberToObject(root, "timestamp", g_realtime_data.timestamp);
    cJSON_AddStringToObject(root, "deviceId", deviceId);
    cJSON_AddStringToObject(root, "type", "data");
    cJSON_AddNumberToObject(payload, "timestamp", g_realtime_data.timestamp);
    
    cJSON* realtime = cJSON_CreateObject();
    if (realtime != NULL) {
        cJSON_AddNumberToObject(realtime, "timestamp", g_realtime_data.timestamp);
        if (g_realtime_data.heart_rate_valid) {
            cJSON_AddNumberToObject(realtime, "heart_rate", g_realtime_data.heart_rate);
            cJSON_AddNumberToObject(payload, "heartRate", g_realtime_data.heart_rate);
            cJSON_AddNumberToObject(payload, "heart_rate", g_realtime_data.heart_rate);
        }
        if (g_realtime_data.breathing_rate_valid) {
            cJSON_AddNumberToObject(realtime, "breathing_rate", g_realtime_data.breathing_rate);
            cJSON_AddNumberToObject(payload, "breathingRate", g_realtime_data.breathing_rate);
            cJSON_AddNumberToObject(payload, "breathing_rate", g_realtime_data.breathing_rate);
        }
        if (g_realtime_data.movement_valid) {
            cJSON_AddNumberToObject(realtime, "movement_level", g_realtime_data.movement_level);
            cJSON_AddNumberToObject(payload, "bodyMovement", g_realtime_data.movement_level);
            cJSON_AddNumberToObject(payload, "body_movement", g_realtime_data.movement_level);
        }
        if (g_realtime_data.sleep_state_valid) {
            cJSON_AddNumberToObject(realtime, "sleep_state", g_realtime_data.sleep_state);
            cJSON_AddNumberToObject(payload, "sleepState", g_realtime_data.sleep_state);
            cJSON_AddNumberToObject(payload, "sleep_state", g_realtime_data.sleep_state);
        }
        if (g_realtime_data.bed_state_valid) {
            cJSON_AddNumberToObject(realtime, "bed_state", g_realtime_data.bed_state);
        }
        if (g_realtime_data.presence_valid) {
            cJSON_AddNumberToObject(realtime, "presence", g_realtime_data.presence);
            cJSON_AddNumberToObject(payload, "presence", g_realtime_data.presence);
        }
        cJSON_AddItemToObject(payload, "realtime", realtime);
    }
    
    if (g_statistics.valid) {
        cJSON* stats = cJSON_CreateObject();
        if (stats != NULL) {
            cJSON_AddNumberToObject(stats, "total_duration_sec", g_statistics.total_duration_sec);
            cJSON_AddNumberToObject(stats, "awake_duration_sec", g_statistics.awake_duration_sec);
            cJSON_AddNumberToObject(stats, "light_sleep_duration_sec", g_statistics.light_sleep_duration_sec);
            cJSON_AddNumberToObject(stats, "deep_sleep_duration_sec", g_statistics.deep_sleep_duration_sec);
            cJSON_AddNumberToObject(stats, "heart_rate_avg", g_statistics.heart_rate_avg);
            cJSON_AddNumberToObject(stats, "breathing_rate_avg", g_statistics.breathing_rate_avg);
            cJSON_AddNumberToObject(stats, "turn_over_count", g_statistics.turn_over_count);
            cJSON_AddNumberToObject(stats, "away_count", g_statistics.away_count);
            cJSON_AddItemToObject(payload, "statistics", stats);
        }
    }
    
    if (g_sleep_score.valid) {
        cJSON* score = cJSON_CreateObject();
        if (score != NULL) {
            cJSON_AddNumberToObject(score, "total_score", g_sleep_score.total_score);
            cJSON_AddNumberToObject(score, "quality_level", g_sleep_score.quality_level);
            cJSON_AddNumberToObject(score, "duration_score", g_sleep_score.duration_score);
            cJSON_AddNumberToObject(score, "deep_sleep_score", g_sleep_score.deep_sleep_score);
            cJSON_AddNumberToObject(score, "continuity_score", g_sleep_score.continuity_score);
            cJSON_AddNumberToObject(score, "heart_rate_score", g_sleep_score.heart_rate_score);
            cJSON_AddNumberToObject(score, "breathing_score", g_sleep_score.breathing_score);
            cJSON_AddNumberToObject(score, "movement_score", g_sleep_score.movement_score);
            cJSON_AddNumberToObject(payload, "sleepScore", g_sleep_score.total_score);
            cJSON_AddNumberToObject(payload, "sleep_score", g_sleep_score.total_score);
            cJSON_AddItemToObject(payload, "sleep_score_detail", score);
        }
    }
    
    cJSON_AddItemToObject(root, "data", payload);
    
    g_state = APP_SLEEP_STATE_MONITORING;
    xSemaphoreGive(g_mutex);
    
    char* json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    
    if (json_str != NULL) {
        char topic[128];
        snprintf(topic, sizeof(topic), "sleep/%s/data", deviceId);
        
        if (mqtt_client_publish_string(topic, json_str, MQTT_QOS_1, false)) {
            ESP_LOGD(TAG, "数据上报成功");
            if (xSemaphoreTake(g_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                g_stats.report_count++;
                xSemaphoreGive(g_mutex);
            }
        } else {
            ESP_LOGE(TAG, "数据上报失败");
        }
        
        cJSON_free(json_str);
    }
}

/**
 * @brief 更新统计数据
 */
static void update_statistics(void) {
    if (!g_realtime_data.valid) {
        return;
    }
    
    uint64_t current_time = (uint64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
    
    // 初始化睡眠开始时间
    if (g_statistics.start_time == 0) {
        g_statistics.start_time = current_time;
    }
    
    // 更新总时长
    g_statistics.total_duration_sec = (current_time - g_statistics.start_time) / 1000;
    
    // 更新心率统计
    if (g_realtime_data.heart_rate_valid) {
        if (g_statistics.heart_rate_count == 0) {
            g_statistics.heart_rate_min = g_realtime_data.heart_rate;
            g_statistics.heart_rate_max = g_realtime_data.heart_rate;
        } else {
            if (g_realtime_data.heart_rate < g_statistics.heart_rate_min) {
                g_statistics.heart_rate_min = g_realtime_data.heart_rate;
            }
            if (g_realtime_data.heart_rate > g_statistics.heart_rate_max) {
                g_statistics.heart_rate_max = g_realtime_data.heart_rate;
            }
        }
        g_statistics.heart_rate_sum += g_realtime_data.heart_rate;
        g_statistics.heart_rate_count++;
        g_statistics.heart_rate_avg = g_statistics.heart_rate_sum / g_statistics.heart_rate_count;
    }
    
    // 更新呼吸率统计
    if (g_realtime_data.breathing_rate_valid) {
        if (g_statistics.breathing_rate_count == 0) {
            g_statistics.breathing_rate_min = g_realtime_data.breathing_rate;
            g_statistics.breathing_rate_max = g_realtime_data.breathing_rate;
        } else {
            if (g_realtime_data.breathing_rate < g_statistics.breathing_rate_min) {
                g_statistics.breathing_rate_min = g_realtime_data.breathing_rate;
            }
            if (g_realtime_data.breathing_rate > g_statistics.breathing_rate_max) {
                g_statistics.breathing_rate_max = g_realtime_data.breathing_rate;
            }
        }
        g_statistics.breathing_rate_sum += g_realtime_data.breathing_rate;
        g_statistics.breathing_rate_count++;
        g_statistics.breathing_rate_avg = g_statistics.breathing_rate_sum / g_statistics.breathing_rate_count;
    }
    
    // 更新体动统计
    if (g_realtime_data.movement_valid) {
        g_statistics.movement_sum += g_realtime_data.movement_level;
        g_statistics.movement_count++;
        g_statistics.movement_avg = g_statistics.movement_sum / g_statistics.movement_count;
        
        if (g_realtime_data.movement_level > 50) {
            g_statistics.large_move_count++;
        } else if (g_realtime_data.movement_level > 20) {
            g_statistics.small_move_count++;
        }
    }
    
    // 更新睡眠状态时长
    if (g_realtime_data.sleep_state_valid) {
        // 检测睡眠状态变化
        if (g_realtime_data.sleep_state != g_last_sleep_state) {
            // 更新上一个状态的时长
            if (g_sleep_state_start_time > 0) {
                uint32_t duration = (current_time - g_sleep_state_start_time) / 1000;
                
                switch (g_last_sleep_state) {
                    case R60ABD1_SLEEP_AWAKE:
                        g_statistics.awake_duration_sec += duration;
                        break;
                    case R60ABD1_SLEEP_LIGHT:
                        g_statistics.light_sleep_duration_sec += duration;
                        break;
                    case R60ABD1_SLEEP_DEEP:
                        g_statistics.deep_sleep_duration_sec += duration;
                        break;
                    default:
                        break;
                }
            }
            
            // 更新当前状态
            g_last_sleep_state = g_realtime_data.sleep_state;
            g_sleep_state_start_time = current_time;
            
            // 检测离床
            if (g_realtime_data.sleep_state == R60ABD1_SLEEP_NONE) {
                g_statistics.away_count++;
            }
        }
    }
    
    g_statistics.valid = true;
}

/**
 * @brief 重置实时数据
 */
static void reset_realtime_data(void) {
    memset(&g_realtime_data, 0, sizeof(app_sleep_realtime_data_t));
}

/**
 * @brief 重置统计数据
 */
static void reset_statistics(void) {
    memset(&g_statistics, 0, sizeof(app_sleep_statistics_t));
    g_last_sleep_state = R60ABD1_SLEEP_NONE;
    g_sleep_state_start_time = 0;
}

/**
 * @brief 重置异常检测
 */
static void reset_alarm(void) {
    memset(&g_alarm, 0, sizeof(app_sleep_alarm_t));
}

/**
 * @brief 重置评分
 */
static void reset_score(void) {
    memset(&g_sleep_score, 0, sizeof(app_sleep_score_t));
}

/**
 * @brief 检查心率是否有效
 */
static bool is_valid_heart_rate(uint8_t rate) {
    return (rate >= RADAR_HEART_RATE_MIN && rate <= RADAR_HEART_RATE_MAX);
}

/**
 * @brief 检查呼吸率是否有效
 */
static bool is_valid_breathing_rate(uint8_t rate) {
    return (rate >= RADAR_BREATHING_RATE_MIN && rate <= RADAR_BREATHING_RATE_MAX);
}

/**
 * @brief 计算睡眠时长得分
 */
static uint8_t calculate_duration_score(uint32_t total_duration_sec) {
    uint32_t duration_min = total_duration_sec / 60;
    
    if (duration_min < APP_SLEEP_MIN_SLEEP_DURATION) {
        return 0;
    } else if (duration_min < 360) {  // < 6小时
        return 40 + (duration_min - APP_SLEEP_MIN_SLEEP_DURATION) * 20 / (360 - APP_SLEEP_MIN_SLEEP_DURATION);
    } else if (duration_min < 480) {  // 6-8小时
        return 60 + (duration_min - 360) * 30 / (480 - 360);
    } else if (duration_min < 540) {  // 8-9小时
        return 90 + (duration_min - 480) * 10 / (540 - 480);
    } else {  // > 9小时
        return 100;
    }
}

/**
 * @brief 计算深睡占比得分
 */
static uint8_t calculate_deep_sleep_score(float deep_sleep_ratio) {
    if (deep_sleep_ratio < APP_SLEEP_DEEP_SLEEP_MIN_RATIO) {
        return (uint8_t)(deep_sleep_ratio * 100 / APP_SLEEP_DEEP_SLEEP_MIN_RATIO * 40);
    } else if (deep_sleep_ratio < 0.25f) {
        return 40 + (uint8_t)((deep_sleep_ratio - APP_SLEEP_DEEP_SLEEP_MIN_RATIO) * 200);
    } else if (deep_sleep_ratio < 0.35f) {
        return 60 + (uint8_t)((deep_sleep_ratio - 0.25f) * 200);
    } else {
        return 80;
    }
}

/**
 * @brief 计算睡眠连续性得分
 */
static uint8_t calculate_continuity_score(uint8_t away_count, uint32_t away_duration_sec) {
    int32_t score = 100;
    
    score -= away_count * 5;
    
    if (away_duration_sec > 300) {
        score -= 10;
    }
    if (away_duration_sec > 600) {
        score -= 15;
    }
    if (away_duration_sec > 900) {
        score -= 20;
    }
    
    if (score < 0) {
        score = 0;
    }
    
    return (uint8_t)score;
}

/**
 * @brief 计算心率稳定性得分
 */
static uint8_t calculate_heart_rate_score(uint8_t avg, uint8_t min, uint8_t max) {
    if (avg < 50 || avg > 100) {
        return 40;
    }
    
    uint8_t range = max - min;
    
    if (range <= 10) {
        return 100;
    } else if (range <= 20) {
        return 90 - (range - 10) * 2;
    } else if (range <= 30) {
        return 70 - (range - 20) * 2;
    } else {
        return 50;
    }
}

/**
 * @brief 计算呼吸稳定性得分
 */
static uint8_t calculate_breathing_score(uint8_t avg, uint8_t min, uint8_t max) {
    if (avg < 10 || avg > 25) {
        return 40;
    }
    
    uint8_t range = max - min;
    
    if (range <= 3) {
        return 100;
    } else if (range <= 6) {
        return 90 - (range - 3) * 5;
    } else if (range <= 10) {
        return 75 - (range - 6) * 5;
    } else {
        return 50;
    }
}

/**
 * @brief 计算体动得分
 */
static uint8_t calculate_movement_score(uint8_t turn_over_count, uint8_t large_move_pct) {
    int32_t score = 100;
    
    if (turn_over_count > 20) {
        score -= 30;
    } else if (turn_over_count > 10) {
        score -= 20;
    } else if (turn_over_count > 5) {
        score -= 10;
    }
    
    score -= large_move_pct / 2;
    
    if (score < 0) {
        score = 0;
    }
    
    return (uint8_t)score;
}

/**
 * @brief 确定睡眠质量等级
 */
static sleep_quality_t determine_quality_level(uint8_t total_score) {
    if (total_score >= 90) {
        return SLEEP_QUALITY_EXCELLENT;
    } else if (total_score >= 80) {
        return SLEEP_QUALITY_GOOD;
    } else if (total_score >= 60) {
        return SLEEP_QUALITY_FAIR;
    } else if (total_score >= 40) {
        return SLEEP_QUALITY_POOR;
    } else {
        return SLEEP_QUALITY_BAD;
    }
}
