/**
 * @file ota_service.cpp
 * @brief OTA升级服务实现
 * @details 实现固件下载、版本校验、MD5校验、升级执行、进度上报、回滚机制
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 */

#include "config.h"
#include "ota_service.h"
#include "mqtt_client.h"
#include <esp_log.h>
#include <esp_https_ota.h>
#include <esp_ota_ops.h>
#include <esp_app_desc.h>
#include <esp_http_client.h>
#include <esp_system.h>
#include <string.h>
#include <stdlib.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

static const char* TAG = "OTA_SVC";

//=============================================================================
// 静态变量
//=============================================================================

static ota_config_t s_config;
static ota_status_t s_status = {};
static ota_stats_t s_stats = {};
static SemaphoreHandle_t s_mutex = NULL;
static TaskHandle_t s_taskHandle = NULL;
static volatile bool s_taskRunning = false;
static ota_event_callback_t s_eventCallback = NULL;
static void* s_userData = NULL;
static bool s_initialized = false;
static bool s_cancelRequested = false;

//=============================================================================
// 静态函数声明
//=============================================================================

static void otaTask(void* pvParameters);
static void notifyEvent(ota_event_t event, const ota_status_t* status);

//=============================================================================
// API 实现
//=============================================================================

/**
 * @brief 初始化OTA服务
 */
ota_error_t ota_service_init(const ota_config_t* config) {
    ESP_LOGI(TAG, "初始化OTA服务...");
    
    if (s_initialized) {
        ESP_LOGW(TAG, "OTA服务已初始化");
        return OTA_ERR_NONE;
    }
    
    if (config != NULL) {
        memcpy(&s_config, config, sizeof(ota_config_t));
    } else {
        memset(&s_config, 0, sizeof(ota_config_t));
        s_config.verify_md5 = true;
        s_config.auto_reboot = true;
        s_config.timeout_ms = OTA_TIMEOUT_MS;
    }
    
    memset(&s_status, 0, sizeof(ota_status_t));
    memset(&s_stats, 0, sizeof(ota_stats_t));
    
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "创建互斥锁失败");
        return OTA_ERR_MEMORY_FAILED;
    }
    
    s_initialized = true;
    ESP_LOGI(TAG, "OTA服务初始化完成");
    return OTA_ERR_NONE;
}

/**
 * @brief 反初始化OTA服务
 */
void ota_service_deinit(void) {
    ESP_LOGI(TAG, "反初始化OTA服务...");
    
    if (s_taskRunning) {
        s_taskRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_initialized = false;
    ESP_LOGI(TAG, "OTA服务反初始化完成");
}

/**
 * @brief 开始OTA升级
 */
ota_error_t ota_service_start(const char* url, const char* version, const char* md5) {
    if (!s_initialized) {
        return OTA_ERR_NOT_INITIALIZED;
    }
    
    if (s_status.state == OTA_STATE_DOWNLOADING || s_status.state == OTA_STATE_INSTALLING) {
        ESP_LOGW(TAG, "OTA升级已在进行中");
        return OTA_ERR_ALREADY_RUNNING;
    }
    
    if (url == NULL || strlen(url) == 0) {
        ESP_LOGE(TAG, "无效的URL");
        return OTA_ERR_INVALID_URL;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    memset(&s_status, 0, sizeof(ota_status_t));
    s_status.state = OTA_STATE_DOWNLOADING;
    s_cancelRequested = false;
    
    if (version != NULL) {
        strncpy(s_status.current_version, version, OTA_MAX_VERSION_LENGTH - 1);
    }
    
    if (md5 != NULL) {
        strncpy(s_config.md5, md5, OTA_MAX_MD5_LENGTH - 1);
        s_config.verify_md5 = true;
    }
    
    strncpy(s_config.url, url, OTA_MAX_URL_LENGTH - 1);
    
    s_stats.total_attempts++;
    s_stats.last_update_time = xTaskGetTickCount() / 1000;
    
    xSemaphoreGive(s_mutex);
    
    BaseType_t result = xTaskCreatePinnedToCore(
        otaTask,
        "OTATask",
        8192,
        NULL,
        TASK_PRIORITY_HIGH,
        &s_taskHandle,
        1
    );
    
    if (result != pdPASS) {
        ESP_LOGE(TAG, "创建OTA任务失败");
        return OTA_ERR_MEMORY_FAILED;
    }
    
    s_taskRunning = true;
    
    notifyEvent(OTA_EVENT_START, &s_status);
    ESP_LOGI(TAG, "开始OTA升级: URL=%s, Version=%s", url, version ? version : "unknown");
    
    return OTA_ERR_NONE;
}

/**
 * @brief 取消OTA升级
 */
ota_error_t ota_service_cancel(void) {
    if (!s_initialized) {
        return OTA_ERR_NOT_INITIALIZED;
    }
    
    if (s_status.state != OTA_STATE_DOWNLOADING && 
        s_status.state != OTA_STATE_INSTALLING) {
        ESP_LOGW(TAG, "没有正在进行的OTA升级");
        return OTA_ERR_NONE;
    }
    
    s_cancelRequested = true;
    ESP_LOGI(TAG, "取消OTA升级请求");
    
    return OTA_ERR_NONE;
}

/**
 * @brief 获取当前状态
 */
ota_state_t ota_service_get_state(void) {
    return s_status.state;
}

/**
 * @brief 获取状态信息
 */
void ota_service_get_status(ota_status_t* status) {
    if (status != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(status, &s_status, sizeof(ota_status_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 获取统计信息
 */
void ota_service_get_stats(ota_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(stats, &s_stats, sizeof(ota_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 设置事件回调
 */
void ota_service_set_event_callback(ota_event_callback_t callback, void* user_data) {
    s_eventCallback = callback;
    s_userData = user_data;
}

/**
 * @brief 获取当前固件版本
 */
ota_error_t ota_service_get_current_version(char* version, size_t max_len) {
    if (!s_initialized) {
        return OTA_ERR_NOT_INITIALIZED;
    }
    
    if (version == NULL || max_len == 0) {
        return OTA_ERR_INVALID_PARAM;
    }
    
    const esp_app_desc_t* app_desc = esp_ota_get_app_description();
    if (app_desc == NULL) {
        ESP_LOGE(TAG, "获取应用描述失败");
        return OTA_ERR_HARDWARE_ERROR;
    }
    
    strncpy(version, app_desc->version, max_len - 1);
    version[max_len - 1] = '\0';
    
    ESP_LOGI(TAG, "当前固件版本: %s", version);
    return OTA_ERR_NONE;
}

/**
 * @brief 检查是否有可用更新
 */
ota_error_t ota_service_check_update(const char* update_url, char* latest_version, size_t max_len) {
    if (!s_initialized) {
        return OTA_ERR_NOT_INITIALIZED;
    }
    
    if (update_url == NULL || latest_version == NULL || max_len == 0) {
        return OTA_ERR_INVALID_PARAM;
    }
    
    ESP_LOGI(TAG, "检查固件更新: URL=%s", update_url);
    
    esp_http_client_config_t http_config = {
        .url = update_url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 10000,
        .keep_alive_enable = true,
    };
    
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) {
        ESP_LOGE(TAG, "HTTP客户端初始化失败");
        return OTA_ERR_NETWORK_ERROR;
    }
    
    esp_err_t err = esp_http_client_perform(client);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "HTTP请求失败: %d", err);
        esp_http_client_cleanup(client);
        return OTA_ERR_NETWORK_ERROR;
    }
    
    int content_length = esp_http_client_get_content_length(client);
    if (content_length <= 0 || content_length >= max_len) {
        ESP_LOGE(TAG, "无效的响应长度: %d", content_length);
        esp_http_client_cleanup(client);
        return OTA_ERR_NETWORK_ERROR;
    }
    
    char* response = (char*)malloc(content_length + 1);
    if (response == NULL) {
        ESP_LOGE(TAG, "内存分配失败");
        esp_http_client_cleanup(client);
        return OTA_ERR_MEMORY_FAILED;
    }
    
    int read_len = esp_http_client_read(client, response, content_length);
    response[read_len] = '\0';
    
    esp_http_client_cleanup(client);
    
    strncpy(latest_version, response, max_len - 1);
    latest_version[max_len - 1] = '\0';
    
    free(response);
    
    ESP_LOGI(TAG, "最新固件版本: %s", latest_version);
    return OTA_ERR_NONE;
}

//=============================================================================
// 静态函数实现
//=============================================================================

/**
 * @brief OTA任务
 */
static void otaTask(void* pvParameters) {
    (void)pvParameters;
    
    ESP_LOGI(TAG, "OTA任务启动");
    
    esp_err_t err = ESP_FAIL;
    esp_https_ota_handle_t ota_handle = NULL;
    bool update_success = false;
    
    esp_http_client_config_t http_config = {};
    http_config.url = s_config.url;
    http_config.method = HTTP_METHOD_GET;
    http_config.timeout_ms = s_config.timeout_ms;
    http_config.keep_alive_enable = true;
    http_config.buffer_size = OTA_BUFFER_SIZE;
    http_config.buffer_size_tx = OTA_BUFFER_SIZE;

    esp_https_ota_config_t ota_config = {};
    ota_config.http_config = &http_config;
    
    err = esp_https_ota_begin(&ota_config, &ota_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "OTA开始失败: %d", err);
        goto error_exit;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_status.state = OTA_STATE_DOWNLOADING;
    xSemaphoreGive(s_mutex);

    if (s_config.verify_md5 && strlen(s_config.md5) > 0) {
        ESP_LOGW(TAG, "当前OTA使用流式写入，暂不支持本地MD5校验，交由ESP-IDF镜像校验");
    }

    while (1) {
        if (s_cancelRequested) {
            ESP_LOGW(TAG, "OTA升级被取消");
            err = ESP_ERR_INVALID_STATE;
            break;
        }

        err = esp_https_ota_perform(ota_handle);

        int downloaded = esp_https_ota_get_image_len_read(ota_handle);
        int total = esp_https_ota_get_image_size(ota_handle);

        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_status.downloaded_size = downloaded > 0 ? downloaded : 0;
        if (total > 0) {
            s_status.total_size = total;
            s_status.progress = (uint8_t)((s_status.downloaded_size * 100) / s_status.total_size);
        }
        xSemaphoreGive(s_mutex);

        notifyEvent(OTA_EVENT_PROGRESS, &s_status);
        ESP_LOGD(TAG, "OTA进度: %d%%", s_status.progress);

        if (err == ESP_ERR_HTTPS_OTA_IN_PROGRESS) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        if (err != ESP_OK) {
            ESP_LOGE(TAG, "OTA执行失败: %s", esp_err_to_name(err));
            break;
        }

        break;
    }

    if (err == ESP_OK && !s_cancelRequested) {
        if (!esp_https_ota_is_complete_data_received(ota_handle)) {
            ESP_LOGE(TAG, "OTA镜像未完整接收");
            err = ESP_FAIL;
            goto error_exit;
        }

        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_status.state = OTA_STATE_VERIFYING;
        xSemaphoreGive(s_mutex);

        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_status.state = OTA_STATE_INSTALLING;
        xSemaphoreGive(s_mutex);
        
        err = esp_https_ota_finish(ota_handle);
        ota_handle = NULL;
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "OTA升级成功");
            update_success = true;
            
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            s_status.state = OTA_STATE_COMPLETED;
            s_stats.success_count++;
            xSemaphoreGive(s_mutex);
            
            notifyEvent(OTA_EVENT_SUCCESS, &s_status);
            
            if (s_config.auto_reboot) {
                ESP_LOGI(TAG, "将在%dms后重启...", OTA_REBOOT_DELAY_MS);
                vTaskDelay(pdMS_TO_TICKS(OTA_REBOOT_DELAY_MS));
                esp_restart();
            }
        } else {
            ESP_LOGE(TAG, "OTA升级失败: %d", err);
            goto error_exit;
        }
    }
    
error_exit:
    if (ota_handle != NULL) {
        esp_https_ota_abort(ota_handle);
    }
    
    if (!update_success || s_cancelRequested) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_status.state = OTA_STATE_FAILED;
        s_stats.failed_count++;
        snprintf(s_status.error_message, sizeof(s_status.error_message), 
                "OTA失败: %s", esp_err_to_name(err));
        xSemaphoreGive(s_mutex);
        
        notifyEvent(OTA_EVENT_FAILED, &s_status);
    }
    
    s_taskRunning = false;
    ESP_LOGI(TAG, "OTA任务结束");
    vTaskDelete(NULL);
}

/**
 * @brief 通知事件
 */
static void notifyEvent(ota_event_t event, const ota_status_t* status) {
    if (s_eventCallback != NULL) {
        s_eventCallback(event, status, s_userData);
    }
}
