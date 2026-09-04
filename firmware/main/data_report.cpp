/**
 * @file data_report.cpp
 * @brief 数据上报服务实现
 * @details 负责接收雷达数据、聚合、缓存和MQTT上报
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 */

#include "data_report.h"
#include "mqtt_client.h"
#include "config.h"
#include <esp_err.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <cJSON.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>

static const char* TAG = "DATA_REPORT";

typedef struct {
    radar_data_type_t type;
    radar_data_union_t data;
} data_report_queue_item_t;

//=============================================================================
// 静态变量
//=============================================================================

static data_report_config_t s_config;
static data_report_state_t s_state = DATA_REPORT_STATE_STOPPED;
static data_report_stats_t s_stats = {};
static data_report_aggregate_t s_aggregate1min = {};
static data_report_aggregate_t s_aggregate5min = {};
static SemaphoreHandle_t s_mutex = NULL;
static QueueHandle_t s_dataQueue = NULL;
static TaskHandle_t s_taskHandle = NULL;
static volatile bool s_taskRunning = false;
static data_report_event_callback_t s_eventCallback = NULL;
static void* s_userData = NULL;

//=============================================================================
// 静态函数声明
//=============================================================================

static void dataReportTask(void* pvParameters);
static void resetAggregate(data_report_aggregate_t* agg);
static void updateAggregate(data_report_aggregate_t* agg, radar_data_type_t type, const radar_data_union_t* data);
static bool publishAggregateData(const data_report_aggregate_t* agg, const char* suffix);
static bool publishRealtimeData(radar_data_type_t type, const radar_data_union_t* data);
static void notifyEvent(int event, void* data);
static const char* sleepStateToString(uint8_t state);
static void getDeviceId(char* buffer, size_t buffer_size);
static const char* radarTypeToString(radar_data_type_t type);
static uint32_t getRadarTimestamp(radar_data_type_t type, const radar_data_union_t* data);

//=============================================================================
// API 实现
//=============================================================================

/**
 * @brief 初始化数据上报服务
 */
data_report_error_t data_report_init(const data_report_config_t* config) {
    ESP_LOGI(TAG, "初始化数据上报服务...");
    
    if (s_state != DATA_REPORT_STATE_STOPPED) {
        ESP_LOGE(TAG, "服务已初始化");
        return DATA_REPORT_ERR_ALREADY_RUNNING;
    }
    
    if (config != NULL) {
        memcpy(&s_config, config, sizeof(data_report_config_t));
    } else {
        memset(&s_config, 0, sizeof(data_report_config_t));
        s_config.enable_1min_aggregate = true;
        s_config.enable_5min_aggregate = true;
        s_config.enable_realtime = false;
        s_config.enable_cache = true;
        s_config.report_interval_ms = 5000;
        s_config.cache_max_size = 100;
    }
    
    memset(&s_stats, 0, sizeof(data_report_stats_t));
    resetAggregate(&s_aggregate1min);
    resetAggregate(&s_aggregate5min);
    
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "创建互斥锁失败");
        return DATA_REPORT_ERR_MEMORY_FAILED;
    }
    
    s_dataQueue = xQueueCreate(DATA_REPORT_QUEUE_SIZE, sizeof(data_report_queue_item_t));
    if (s_dataQueue == NULL) {
        ESP_LOGE(TAG, "创建队列失败");
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
        return DATA_REPORT_ERR_MEMORY_FAILED;
    }
    
    s_state = DATA_REPORT_STATE_STOPPED;
    ESP_LOGI(TAG, "数据上报服务初始化完成");
    return DATA_REPORT_ERR_NONE;
}

/**
 * @brief 反初始化数据上报服务
 */
void data_report_deinit(void) {
    ESP_LOGI(TAG, "反初始化数据上报服务...");
    
    if (s_state == DATA_REPORT_STATE_RUNNING) {
        data_report_stop();
    }
    
    if (s_dataQueue != NULL) {
        vQueueDelete(s_dataQueue);
        s_dataQueue = NULL;
    }
    
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_state = DATA_REPORT_STATE_STOPPED;
    ESP_LOGI(TAG, "数据上报服务反初始化完成");
}

/**
 * @brief 启动数据上报服务
 */
data_report_error_t data_report_start(void) {
    if (s_state != DATA_REPORT_STATE_STOPPED) {
        ESP_LOGE(TAG, "服务未停止");
        return DATA_REPORT_ERR_ALREADY_RUNNING;
    }
    
    ESP_LOGI(TAG, "启动数据上报服务...");
    
    BaseType_t result = xTaskCreatePinnedToCore(
        dataReportTask,
        "DataReportTask",
        8192,
        NULL,
        TASK_PRIORITY_NORMAL,
        &s_taskHandle,
        1
    );
    
    if (result != pdPASS) {
        ESP_LOGE(TAG, "创建任务失败");
        return DATA_REPORT_ERR_MEMORY_FAILED;
    }
    
    s_taskRunning = true;
    s_state = DATA_REPORT_STATE_RUNNING;
    
    ESP_LOGI(TAG, "数据上报服务已启动");
    return DATA_REPORT_ERR_NONE;
}

/**
 * @brief 停止数据上报服务
 */
void data_report_stop(void) {
    if (s_state != DATA_REPORT_STATE_RUNNING) {
        return;
    }
    
    ESP_LOGI(TAG, "停止数据上报服务...");
    
    s_taskRunning = false;
    s_state = DATA_REPORT_STATE_STOPPED;
    
    if (s_taskHandle != NULL) {
        vTaskDelay(pdMS_TO_TICKS(100));
        s_taskHandle = NULL;
    }
    
    ESP_LOGI(TAG, "数据上报服务已停止");
}

/**
 * @brief 获取当前状态
 */
data_report_state_t data_report_get_state(void) {
    return s_state;
}

/**
 * @brief 设置配置
 */
data_report_error_t data_report_set_config(const data_report_config_t* config) {
    if (config == NULL) {
        return DATA_REPORT_ERR_NOT_INITIALIZED;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memcpy(&s_config, config, sizeof(data_report_config_t));
    xSemaphoreGive(s_mutex);
    
    return DATA_REPORT_ERR_NONE;
}

/**
 * @brief 获取当前配置
 */
void data_report_get_config(data_report_config_t* config) {
    if (config != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(config, &s_config, sizeof(data_report_config_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 注册雷达数据回调
 */
void data_report_radar_callback(radar_data_type_t type, const radar_data_union_t* data, void* user_data) {
    (void)user_data;

    if (data == NULL) {
        return;
    }
    
    if (s_state != DATA_REPORT_STATE_RUNNING) {
        return;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_stats.total_received++;
    xSemaphoreGive(s_mutex);
    
    if (s_config.enable_realtime) {
        publishRealtimeData(type, data);
    }
    
    data_report_queue_item_t item = {};
    item.type = type;
    item.data = *data;

    if (xQueueSend(s_dataQueue, &item, pdMS_TO_TICKS(10)) != pdTRUE) {
        ESP_LOGW(TAG, "队列已满，丢弃数据");
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_stats.total_failed++;
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 手动上报数据
 */
data_report_error_t data_report_report_now(void) {
    if (s_state != DATA_REPORT_STATE_RUNNING) {
        return DATA_REPORT_ERR_NOT_INITIALIZED;
    }
    
    bool success = true;
    
    if (s_config.enable_1min_aggregate && s_aggregate1min.valid) {
        success = publishAggregateData(&s_aggregate1min, "1min");
        if (success) {
            resetAggregate(&s_aggregate1min);
        }
    }
    
    if (s_config.enable_5min_aggregate && s_aggregate5min.valid) {
        success = publishAggregateData(&s_aggregate5min, "5min");
        if (success) {
            resetAggregate(&s_aggregate5min);
        }
    }
    
    return success ? DATA_REPORT_ERR_NONE : DATA_REPORT_ERR_MQTT_FAILED;
}

/**
 * @brief 清除缓存数据
 */
data_report_error_t data_report_clear_cache(void) {
    ESP_LOGI(TAG, "清除缓存数据");
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_stats.cache_count = 0;
    xSemaphoreGive(s_mutex);
    
    return DATA_REPORT_ERR_NONE;
}

/**
 * @brief 获取统计信息
 */
void data_report_get_stats(data_report_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(stats, &s_stats, sizeof(data_report_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 设置事件回调
 */
void data_report_set_event_callback(data_report_event_callback_t callback, void* user_data) {
    s_eventCallback = callback;
    s_userData = user_data;
}

//=============================================================================
// 静态函数实现
//=============================================================================

/**
 * @brief 数据上报任务
 */
static void dataReportTask(void* pvParameters) {
    (void)pvParameters;
    
    ESP_LOGI(TAG, "数据上报任务启动");
    
    uint32_t last1minTime = xTaskGetTickCount() / 1000;
    uint32_t last5minTime = xTaskGetTickCount() / 1000;
    
    while (s_taskRunning) {
        data_report_queue_item_t item;
        
        if (xQueueReceive(s_dataQueue, &item, pdMS_TO_TICKS(100)) == pdTRUE) {
            uint32_t currentTime = xTaskGetTickCount() / 1000;
            
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            
            if (s_config.enable_1min_aggregate) {
                if (!s_aggregate1min.valid) {
                    s_aggregate1min.start_time = currentTime;
                    s_aggregate1min.valid = true;
                }
                updateAggregate(&s_aggregate1min, item.type, &item.data);
            }
            
            if (s_config.enable_5min_aggregate) {
                if (!s_aggregate5min.valid) {
                    s_aggregate5min.start_time = currentTime;
                    s_aggregate5min.valid = true;
                }
                updateAggregate(&s_aggregate5min, item.type, &item.data);
            }
            
            xSemaphoreGive(s_mutex);
            
            if (s_config.enable_1min_aggregate && 
                (currentTime - last1minTime) >= DATA_REPORT_AGGREGATE_1MIN) {
                data_report_aggregate_t snapshot = {};
                bool shouldPublish = false;

                xSemaphoreTake(s_mutex, portMAX_DELAY);
                if (s_aggregate1min.valid) {
                    memcpy(&snapshot, &s_aggregate1min, sizeof(snapshot));
                    resetAggregate(&s_aggregate1min);
                    shouldPublish = true;
                }
                xSemaphoreGive(s_mutex);

                if (shouldPublish) {
                    publishAggregateData(&snapshot, "1min");
                }
                last1minTime = currentTime;
            }
            
            if (s_config.enable_5min_aggregate && 
                (currentTime - last5minTime) >= DATA_REPORT_AGGREGATE_5MIN) {
                data_report_aggregate_t snapshot = {};
                bool shouldPublish = false;

                xSemaphoreTake(s_mutex, portMAX_DELAY);
                if (s_aggregate5min.valid) {
                    memcpy(&snapshot, &s_aggregate5min, sizeof(snapshot));
                    resetAggregate(&s_aggregate5min);
                    shouldPublish = true;
                }
                xSemaphoreGive(s_mutex);

                if (shouldPublish) {
                    publishAggregateData(&snapshot, "5min");
                }
                last5minTime = currentTime;
            }
        }
    }
    
    ESP_LOGI(TAG, "数据上报任务结束");
    vTaskDelete(NULL);
}

/**
 * @brief 重置聚合数据
 */
static void resetAggregate(data_report_aggregate_t* agg) {
    memset(agg, 0, sizeof(data_report_aggregate_t));
    agg->heart_rate_min = 255;
    agg->breathing_rate_min = 255;
}

/**
 * @brief 更新聚合数据
 */
static void updateAggregate(data_report_aggregate_t* agg, radar_data_type_t type, const radar_data_union_t* data) {
    agg->timestamp = xTaskGetTickCount() / 1000;

    switch (type) {
        case RADAR_DATA_TYPE_HEART_RATE:
            if (data->heart_rate.heart_rate > 0) {
                agg->heart_rate_count++;
                agg->heart_rate_sum += data->heart_rate.heart_rate;

                if (data->heart_rate.heart_rate < agg->heart_rate_min) {
                    agg->heart_rate_min = data->heart_rate.heart_rate;
                }
                if (data->heart_rate.heart_rate > agg->heart_rate_max) {
                    agg->heart_rate_max = data->heart_rate.heart_rate;
                }

                agg->heart_rate_avg = agg->heart_rate_sum / agg->heart_rate_count;
            }
            break;

        case RADAR_DATA_TYPE_BREATH_RATE:
            if (data->breath_rate.breath_rate > 0) {
                agg->breathing_rate_count++;
                agg->breathing_rate_sum += data->breath_rate.breath_rate;

                if (data->breath_rate.breath_rate < agg->breathing_rate_min) {
                    agg->breathing_rate_min = data->breath_rate.breath_rate;
                }
                if (data->breath_rate.breath_rate > agg->breathing_rate_max) {
                    agg->breathing_rate_max = data->breath_rate.breath_rate;
                }

                agg->breathing_rate_avg = agg->breathing_rate_sum / agg->breathing_rate_count;
            }
            break;

        case RADAR_DATA_TYPE_SLEEP_STATE:
            agg->sleep_state = data->sleep_state.sleep_state;
            break;

        case RADAR_DATA_TYPE_PRESENCE:
            agg->presence = data->presence.presence;
            break;

        case RADAR_DATA_TYPE_BODY_MOVEMENT:
            agg->large_move_pct = data->body_movement.movement_level;
            break;

        case RADAR_DATA_TYPE_SLEEP_COMPOSITE:
            agg->sleep_state = data->sleep_composite.sleep_state;
            agg->presence = data->sleep_composite.presence;
            agg->turn_over_count = data->sleep_composite.turn_over_count;
            agg->large_move_pct = data->sleep_composite.large_move_pct;
            agg->small_move_pct = data->sleep_composite.small_move_pct;
            if (data->sleep_composite.avg_heart > 0) {
                agg->heart_rate_count++;
                agg->heart_rate_sum += data->sleep_composite.avg_heart;
                if (data->sleep_composite.avg_heart < agg->heart_rate_min) {
                    agg->heart_rate_min = data->sleep_composite.avg_heart;
                }
                if (data->sleep_composite.avg_heart > agg->heart_rate_max) {
                    agg->heart_rate_max = data->sleep_composite.avg_heart;
                }
                agg->heart_rate_avg = agg->heart_rate_sum / agg->heart_rate_count;
            }
            if (data->sleep_composite.avg_breath > 0) {
                agg->breathing_rate_count++;
                agg->breathing_rate_sum += data->sleep_composite.avg_breath;
                if (data->sleep_composite.avg_breath < agg->breathing_rate_min) {
                    agg->breathing_rate_min = data->sleep_composite.avg_breath;
                }
                if (data->sleep_composite.avg_breath > agg->breathing_rate_max) {
                    agg->breathing_rate_max = data->sleep_composite.avg_breath;
                }
                agg->breathing_rate_avg = agg->breathing_rate_sum / agg->breathing_rate_count;
            }
            break;

        case RADAR_DATA_TYPE_SLEEP_ANALYSIS:
            agg->turn_over_count = data->sleep_analysis.turn_over_count;
            if (data->sleep_analysis.avg_heart > 0) {
                agg->heart_rate_count++;
                agg->heart_rate_sum += data->sleep_analysis.avg_heart;
                if (data->sleep_analysis.avg_heart < agg->heart_rate_min) {
                    agg->heart_rate_min = data->sleep_analysis.avg_heart;
                }
                if (data->sleep_analysis.avg_heart > agg->heart_rate_max) {
                    agg->heart_rate_max = data->sleep_analysis.avg_heart;
                }
                agg->heart_rate_avg = agg->heart_rate_sum / agg->heart_rate_count;
            }
            if (data->sleep_analysis.avg_breath > 0) {
                agg->breathing_rate_count++;
                agg->breathing_rate_sum += data->sleep_analysis.avg_breath;
                if (data->sleep_analysis.avg_breath < agg->breathing_rate_min) {
                    agg->breathing_rate_min = data->sleep_analysis.avg_breath;
                }
                if (data->sleep_analysis.avg_breath > agg->breathing_rate_max) {
                    agg->breathing_rate_max = data->sleep_analysis.avg_breath;
                }
                agg->breathing_rate_avg = agg->breathing_rate_sum / agg->breathing_rate_count;
            }
            break;

        default:
            break;
    }

    if (agg->large_move_pct > 100) {
        agg->large_move_pct = 100;
    }
    if (agg->small_move_pct > 100) {
        agg->small_move_pct = 100;
    }
}

/**
 * @brief 发布聚合数据
 */
static bool publishAggregateData(const data_report_aggregate_t* agg, const char* suffix) {
    if (!mqtt_client_is_connected()) {
        ESP_LOGW(TAG, "MQTT未连接，无法上报数据");
        return false;
    }

    char deviceId[MQTT_MAX_CLIENT_ID_LEN];
    getDeviceId(deviceId, sizeof(deviceId));
    
    cJSON* root = cJSON_CreateObject();
    if (root == NULL) {
        return false;
    }
    
    cJSON_AddStringToObject(root, "deviceId", deviceId);
    cJSON_AddStringToObject(root, "device_id", deviceId);
    cJSON_AddNumberToObject(root, "timestamp", agg->timestamp);
    cJSON_AddStringToObject(root, "type", "sleep_data");
    cJSON_AddStringToObject(root, "aggregateType", suffix);
    cJSON_AddStringToObject(root, "aggregate_type", suffix);
    
    cJSON* data = cJSON_CreateObject();
    if (data != NULL) {
        cJSON_AddNumberToObject(data, "timestamp", agg->timestamp);
        cJSON_AddStringToObject(data, "aggregateType", suffix);
        cJSON_AddStringToObject(data, "aggregate_type", suffix);

        if (agg->heart_rate_count > 0) {
            cJSON_AddNumberToObject(data, "heartRate", agg->heart_rate_avg);
            cJSON_AddNumberToObject(data, "heart_rate", agg->heart_rate_avg);

            cJSON* heart_rate = cJSON_CreateObject();
            cJSON_AddNumberToObject(heart_rate, "avg", agg->heart_rate_avg);
            cJSON_AddNumberToObject(heart_rate, "min", agg->heart_rate_min);
            cJSON_AddNumberToObject(heart_rate, "max", agg->heart_rate_max);
            cJSON_AddNumberToObject(heart_rate, "count", agg->heart_rate_count);
            cJSON_AddItemToObject(data, "heartRateStats", heart_rate);
        }
        
        if (agg->breathing_rate_count > 0) {
            cJSON_AddNumberToObject(data, "breathingRate", agg->breathing_rate_avg);
            cJSON_AddNumberToObject(data, "breathing_rate", agg->breathing_rate_avg);

            cJSON* breathing = cJSON_CreateObject();
            cJSON_AddNumberToObject(breathing, "avg", agg->breathing_rate_avg);
            cJSON_AddNumberToObject(breathing, "min", agg->breathing_rate_min);
            cJSON_AddNumberToObject(breathing, "max", agg->breathing_rate_max);
            cJSON_AddNumberToObject(breathing, "count", agg->breathing_rate_count);
            cJSON_AddItemToObject(data, "breathingRateStats", breathing);
        }
        
        cJSON_AddStringToObject(data, "sleepState", sleepStateToString(agg->sleep_state));
        cJSON_AddStringToObject(data, "sleep_state", sleepStateToString(agg->sleep_state));
        cJSON_AddNumberToObject(data, "presence", agg->presence);
        cJSON_AddNumberToObject(data, "turnOverCount", agg->turn_over_count);
        cJSON_AddNumberToObject(data, "turn_over_count", agg->turn_over_count);

        uint8_t movement = agg->large_move_pct + agg->small_move_pct;
        if (movement > 100) {
            movement = 100;
        }
        cJSON_AddNumberToObject(data, "bodyMovement", movement);
        cJSON_AddNumberToObject(data, "body_movement", movement);
        
        cJSON* body_movement = cJSON_CreateObject();
        cJSON_AddNumberToObject(body_movement, "large", agg->large_move_pct);
        cJSON_AddNumberToObject(body_movement, "small", agg->small_move_pct);
        cJSON_AddItemToObject(data, "bodyMovementStats", body_movement);
        
        cJSON_AddItemToObject(root, "data", data);
    }
    
    char* json_str = cJSON_Print(root);
    cJSON_Delete(root);
    
    if (json_str == NULL) {
        return false;
    }
    
    char topic[128];
    snprintf(topic, sizeof(topic), "sleep/%s/data", deviceId);
    
    bool success = mqtt_client_publish_string(topic, json_str, MQTT_QOS_1, false);
    
    if (success) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_stats.total_sent++;
        s_stats.last_report_time = xTaskGetTickCount() / 1000;
        xSemaphoreGive(s_mutex);
        
        ESP_LOGD(TAG, "上报聚合数据成功: %s", suffix);
    } else {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_stats.total_failed++;
        xSemaphoreGive(s_mutex);
        
        ESP_LOGE(TAG, "上报聚合数据失败: %s", suffix);
    }
    
    free(json_str);
    return success;
}

/**
 * @brief 发布实时数据
 */
static bool publishRealtimeData(radar_data_type_t type, const radar_data_union_t* data) {
    if (!mqtt_client_is_connected()) {
        return false;
    }
    
    cJSON* root = cJSON_CreateObject();
    if (root == NULL) {
        return false;
    }
    
    char deviceId[MQTT_MAX_CLIENT_ID_LEN];
    getDeviceId(deviceId, sizeof(deviceId));
    uint32_t timestamp = getRadarTimestamp(type, data);

    cJSON_AddStringToObject(root, "deviceId", deviceId);
    cJSON_AddStringToObject(root, "device_id", deviceId);
    cJSON_AddNumberToObject(root, "timestamp", timestamp);
    cJSON_AddStringToObject(root, "type", "sleep_data");
    cJSON_AddStringToObject(root, "dataType", "realtime");
    cJSON_AddStringToObject(root, "data_type", "realtime");
    cJSON_AddStringToObject(root, "radarType", radarTypeToString(type));
    
    cJSON* data_obj = cJSON_CreateObject();
    if (data_obj != NULL) {
        cJSON_AddNumberToObject(data_obj, "timestamp", timestamp);
        cJSON_AddStringToObject(data_obj, "dataType", "realtime");
        cJSON_AddStringToObject(data_obj, "data_type", "realtime");
        cJSON_AddStringToObject(data_obj, "radarType", radarTypeToString(type));
        switch (type) {
            case RADAR_DATA_TYPE_HEART_RATE:
                cJSON_AddNumberToObject(data_obj, "heartRate", data->heart_rate.heart_rate);
                cJSON_AddNumberToObject(data_obj, "heart_rate", data->heart_rate.heart_rate);
                break;
            case RADAR_DATA_TYPE_BREATH_RATE:
                cJSON_AddNumberToObject(data_obj, "breathingRate", data->breath_rate.breath_rate);
                cJSON_AddNumberToObject(data_obj, "breathing_rate", data->breath_rate.breath_rate);
                break;
            case RADAR_DATA_TYPE_BODY_MOVEMENT:
                cJSON_AddNumberToObject(data_obj, "bodyMovement", data->body_movement.movement_level);
                cJSON_AddNumberToObject(data_obj, "body_movement", data->body_movement.movement_level);
                break;
            case RADAR_DATA_TYPE_SLEEP_STATE:
                cJSON_AddStringToObject(data_obj, "sleepState", sleepStateToString(data->sleep_state.sleep_state));
                cJSON_AddStringToObject(data_obj, "sleep_state", sleepStateToString(data->sleep_state.sleep_state));
                break;
            case RADAR_DATA_TYPE_PRESENCE:
                cJSON_AddNumberToObject(data_obj, "presence", data->presence.presence);
                break;
            default:
                break;
        }
        cJSON_AddItemToObject(root, "data", data_obj);
    }
    
    char* json_str = cJSON_Print(root);
    cJSON_Delete(root);
    
    if (json_str == NULL) {
        return false;
    }
    
    char topic[128];
    snprintf(topic, sizeof(topic), "sleep/%s/data", deviceId);

    bool success = mqtt_client_publish_string(topic, json_str, MQTT_QOS_1, false);
    
    if (success) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_stats.total_sent++;
        xSemaphoreGive(s_mutex);
    } else {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_stats.total_failed++;
        xSemaphoreGive(s_mutex);
    }
    
    free(json_str);
    return success;
}

/**
 * @brief 通知事件
 */
static void notifyEvent(int event, void* data) {
    if (s_eventCallback != NULL) {
        s_eventCallback(event, data, s_userData);
    }
}

/**
 * @brief 睡眠状态转字符串
 */
static const char* sleepStateToString(uint8_t state) {
    switch (state) {
        case R60ABD1_SLEEP_DEEP: return "deep_sleep";
        case R60ABD1_SLEEP_LIGHT: return "light_sleep";
        case R60ABD1_SLEEP_AWAKE: return "awake";
        case R60ABD1_SLEEP_NONE: return "none";
        default: return "unknown";
    }
}

static void getDeviceId(char* buffer, size_t buffer_size) {
    if (buffer == NULL || buffer_size == 0) {
        return;
    }

    uint8_t mac[6] = {0};
    esp_err_t err = esp_read_mac(mac, ESP_MAC_WIFI_STA);
    if (err != ESP_OK) {
        snprintf(buffer, buffer_size, "%sUNKNOWN", MQTT_CLIENT_ID_PREFIX);
        return;
    }

    snprintf(buffer, buffer_size, "%s%02X%02X%02X%02X%02X%02X",
             MQTT_CLIENT_ID_PREFIX,
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

static const char* radarTypeToString(radar_data_type_t type) {
    switch (type) {
        case RADAR_DATA_TYPE_PRESENCE: return "presence";
        case RADAR_DATA_TYPE_MOTION: return "motion";
        case RADAR_DATA_TYPE_BODY_MOVEMENT: return "body_movement";
        case RADAR_DATA_TYPE_BODY_DISTANCE: return "body_distance";
        case RADAR_DATA_TYPE_BODY_POSITION: return "body_position";
        case RADAR_DATA_TYPE_BREATH_STATUS: return "breath_status";
        case RADAR_DATA_TYPE_BREATH_RATE: return "breath_rate";
        case RADAR_DATA_TYPE_BREATH_WAVE: return "breath_wave";
        case RADAR_DATA_TYPE_HEART_RATE: return "heart_rate";
        case RADAR_DATA_TYPE_HEART_WAVE: return "heart_wave";
        case RADAR_DATA_TYPE_BED_STATUS: return "bed_status";
        case RADAR_DATA_TYPE_SLEEP_STATE: return "sleep_state";
        case RADAR_DATA_TYPE_SLEEP_TIME: return "sleep_time";
        case RADAR_DATA_TYPE_SLEEP_SCORE: return "sleep_score";
        case RADAR_DATA_TYPE_SLEEP_COMPOSITE: return "sleep_composite";
        case RADAR_DATA_TYPE_SLEEP_ANALYSIS: return "sleep_analysis";
        case RADAR_DATA_TYPE_RAW_FRAME: return "raw_frame";
        default: return "unknown";
    }
}

static uint32_t getRadarTimestamp(radar_data_type_t type, const radar_data_union_t* data) {
    if (data == NULL) {
        return xTaskGetTickCount() / 1000;
    }

    switch (type) {
        case RADAR_DATA_TYPE_PRESENCE: return data->presence.timestamp;
        case RADAR_DATA_TYPE_MOTION: return data->motion.timestamp;
        case RADAR_DATA_TYPE_BODY_MOVEMENT: return data->body_movement.timestamp;
        case RADAR_DATA_TYPE_BODY_DISTANCE: return data->body_distance.timestamp;
        case RADAR_DATA_TYPE_BODY_POSITION: return data->body_position.timestamp;
        case RADAR_DATA_TYPE_BREATH_STATUS: return data->breath_status.timestamp;
        case RADAR_DATA_TYPE_BREATH_RATE: return data->breath_rate.timestamp;
        case RADAR_DATA_TYPE_BREATH_WAVE: return data->breath_wave.timestamp;
        case RADAR_DATA_TYPE_HEART_RATE: return data->heart_rate.timestamp;
        case RADAR_DATA_TYPE_HEART_WAVE: return data->heart_wave.timestamp;
        case RADAR_DATA_TYPE_BED_STATUS: return data->bed_status.timestamp;
        case RADAR_DATA_TYPE_SLEEP_STATE: return data->sleep_state.timestamp;
        case RADAR_DATA_TYPE_SLEEP_TIME: return data->sleep_time.timestamp;
        case RADAR_DATA_TYPE_SLEEP_SCORE: return data->sleep_score.timestamp;
        case RADAR_DATA_TYPE_SLEEP_COMPOSITE: return data->sleep_composite.timestamp;
        case RADAR_DATA_TYPE_SLEEP_ANALYSIS: return data->sleep_analysis.timestamp;
        case RADAR_DATA_TYPE_RAW_FRAME: return data->raw_frame.timestamp;
        default: return xTaskGetTickCount() / 1000;
    }
}
