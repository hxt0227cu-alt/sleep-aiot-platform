/**
 * @file mqtt_client.cpp
 * @brief MQTT 客户端模块实现
 * @details 实现 MQTT 连接、消息发布/订阅、自动重连等功能
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 */

#include "mqtt_client.h"
#include "config.h"
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/event_groups.h>
#include <esp_heap_caps.h>
#include <stdarg.h>

static const char* TAG = "MQTT_CLI";

//=============================================================================
// 静态变量
//=============================================================================

static mqtt_config_t s_config;
static esp_mqtt_client_handle_t s_mqttClient = NULL;
static mqtt_state_t s_state = MQTT_STATE_DISCONNECTED;
static mqtt_stats_t s_stats = {};
static mqtt_event_callback_t s_eventCallback = NULL;
static void* s_userData = NULL;
static SemaphoreHandle_t s_mutex = NULL;
static EventGroupHandle_t s_eventGroup = NULL;
static TaskHandle_t s_mqttTask = NULL;
static volatile bool s_taskRunning = false;
static char s_lastError[128] = {0};

//=============================================================================
// 静态函数声明
//=============================================================================

static void mqttEventHandler(void* handler_args, esp_event_base_t base, int32_t event_id, void* event_data);
static void mqttTask(void* pvParameters);
static void notifyEvent(mqtt_event_t event, void* data);
static void updateStats(void);
static void setLastError(const char* fmt, ...);

//=============================================================================
// API 实现
//=============================================================================

/**
 * @brief 初始化 MQTT 客户端
 */
bool mqtt_client_init(const mqtt_config_t* config) {
    if (config == NULL) {
        ESP_LOGE(TAG, "配置为空");
        return false;
    }
    
    ESP_LOGI(TAG, "初始化MQTT客户端...");
    
    // 创建互斥锁
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "创建互斥锁失败");
        return false;
    }
    
    // 创建事件组
    s_eventGroup = xEventGroupCreate();
    if (s_eventGroup == NULL) {
        ESP_LOGE(TAG, "创建事件组失败");
        return false;
    }
    
    // 保存配置
    memcpy(&s_config, config, sizeof(mqtt_config_t));
    
    // 初始化统计信息
    memset(&s_stats, 0, sizeof(s_stats));
    
    // 创建MQTT客户端
    esp_mqtt_client_config_t mqtt_cfg = {};
    mqtt_cfg.broker.address.hostname = s_config.broker_host;
    mqtt_cfg.broker.address.port = s_config.broker_port;
    mqtt_cfg.broker.address.transport = MQTT_TRANSPORT_OVER_TCP;
    mqtt_cfg.credentials.username = s_config.username;
    mqtt_cfg.credentials.authentication.password = s_config.password;
    mqtt_cfg.session.keepalive = s_config.keepalive_seconds;
    mqtt_cfg.session.disable_clean_session = !s_config.clean_session;
    mqtt_cfg.network.reconnect_timeout_ms = MQTT_RETRY_DELAY_MS;
    mqtt_cfg.network.timeout_ms = MQTT_SOCKET_TIMEOUT_MS;
    mqtt_cfg.task.priority = MQTT_TASK_PRIORITY;
    mqtt_cfg.task.stack_size = MQTT_TASK_STACK_SIZE;
    mqtt_cfg.buffer.size = MQTT_MAX_PAYLOAD_LEN;
    mqtt_cfg.buffer.out_size = MQTT_MAX_PAYLOAD_LEN;
    
    if (strlen(s_config.client_id) > 0) {
        mqtt_cfg.credentials.client_id = s_config.client_id;
    }
    
    s_mqttClient = esp_mqtt_client_init(&mqtt_cfg);
    if (s_mqttClient == NULL) {
        ESP_LOGE(TAG, "创建MQTT客户端失败");
        return false;
    }
    
    // 注册事件处理
    esp_err_t err = esp_mqtt_client_register_event(s_mqttClient, MQTT_EVENT_ANY, mqttEventHandler, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "注册MQTT事件处理失败: %d", err);
        return false;
    }
    
    s_state = MQTT_STATE_DISCONNECTED;
    ESP_LOGI(TAG, "MQTT客户端初始化完成");
    return true;
}

/**
 * @brief 反初始化 MQTT 客户端
 */
void mqtt_client_deinit(void) {
    ESP_LOGI(TAG, "反初始化MQTT客户端...");
    
    // 停止任务
    if (s_taskRunning) {
        mqtt_client_stop_task();
    }
    
    // 断开连接
    mqtt_client_disconnect();
    
    // 释放资源
    if (s_mqttClient != NULL) {
        esp_mqtt_client_destroy(s_mqttClient);
        s_mqttClient = NULL;
    }
    
    if (s_eventGroup != NULL) {
        vEventGroupDelete(s_eventGroup);
        s_eventGroup = NULL;
    }
    
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_state = MQTT_STATE_DISCONNECTED;
    ESP_LOGI(TAG, "MQTT客户端反初始化完成");
}

/**
 * @brief 连接到 MQTT 服务器
 */
bool mqtt_client_connect(uint32_t timeout_ms) {
    if (s_mqttClient == NULL) {
        ESP_LOGE(TAG, "MQTT客户端未初始化");
        return false;
    }
    
    if (s_state == MQTT_STATE_CONNECTED) {
        ESP_LOGW(TAG, "MQTT已连接");
        return true;
    }
    
    ESP_LOGI(TAG, "连接到MQTT服务器: %s:%d", s_config.broker_host, s_config.broker_port);
    ESP_LOGI(TAG, "MQTT启动前内存: internal=%u, psram=%u",
             heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    s_lastError[0] = '\0';
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    s_state = MQTT_STATE_CONNECTING;
    
    // 清除事件位
    xEventGroupClearBits(s_eventGroup, MQTT_CONNECTED_BIT | MQTT_DISCONNECTED_BIT);
    
    // 开始连接
    esp_err_t err = esp_mqtt_client_start(s_mqttClient);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "启动MQTT客户端失败: %d", err);
        snprintf(s_lastError, sizeof(s_lastError), "启动MQTT客户端失败: %d", err);
        s_state = MQTT_STATE_ERROR;
        xSemaphoreGive(s_mutex);
        return false;
    }
    
    xSemaphoreGive(s_mutex);
    
    // 等待连接完成或超时
    EventBits_t bits = xEventGroupWaitBits(
        s_eventGroup,
        MQTT_CONNECTED_BIT | MQTT_DISCONNECTED_BIT,
        pdFALSE,
        pdFALSE,
        pdMS_TO_TICKS(timeout_ms)
    );
    
    if (bits & MQTT_CONNECTED_BIT) {
        ESP_LOGI(TAG, "MQTT连接成功");
        s_stats.connect_count++;
        s_stats.last_connect_time = xTaskGetTickCount() / 1000;
        return true;
    } else {
        if (s_lastError[0] == '\0') {
            setLastError("connect timeout to %s:%u", s_config.broker_host, (unsigned)s_config.broker_port);
        }
        ESP_LOGE(TAG, "MQTT连接失败或超时: %s", s_lastError);
        if (s_mqttClient != NULL) {
            esp_mqtt_client_stop(s_mqttClient);
        }
        s_state = MQTT_STATE_ERROR;
        return false;
    }
}

/**
 * @brief 断开 MQTT 连接
 */
void mqtt_client_disconnect(void) {
    if (s_mqttClient == NULL || s_state == MQTT_STATE_DISCONNECTED) {
        return;
    }
    
    ESP_LOGI(TAG, "断开MQTT连接");
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    s_state = MQTT_STATE_DISCONNECTING;
    
    esp_mqtt_client_stop(s_mqttClient);
    
    s_state = MQTT_STATE_DISCONNECTED;
    s_stats.disconnect_count++;
    
    xSemaphoreGive(s_mutex);
    
    notifyEvent(MQTT_CLIENT_EVENT_DISCONNECTED, NULL);
}

/**
 * @brief 重新连接
 */
bool mqtt_client_reconnect(void) {
    ESP_LOGI(TAG, "MQTT重连...");
    
    // 先断开
    mqtt_client_disconnect();
    
    // 等待一段时间
    vTaskDelay(pdMS_TO_TICKS(MQTT_RETRY_DELAY_MS));
    
    // 重新连接
    bool result = mqtt_client_connect(MQTT_SOCKET_TIMEOUT_MS);
    
    if (result) {
        s_stats.reconnect_count++;
    }
    
    return result;
}

/**
 * @brief 发布消息
 */
bool mqtt_client_publish(const char* topic, const uint8_t* payload, size_t payload_len, 
                         mqtt_qos_t qos, bool retain) {
    if (s_mqttClient == NULL || s_state != MQTT_STATE_CONNECTED) {
        ESP_LOGE(TAG, "MQTT未连接");
        return false;
    }
    
    if (topic == NULL || strlen(topic) == 0) {
        ESP_LOGE(TAG, "主题为空");
        return false;
    }
    
    if (payload == NULL && payload_len > 0) {
        ESP_LOGE(TAG, "payload为空但长度大于0");
        return false;
    }
    
    int msg_id = esp_mqtt_client_publish(
        s_mqttClient,
        topic,
        (const char*)payload,
        payload_len,
        qos,
        retain
    );
    
    if (msg_id < 0) {
        ESP_LOGE(TAG, "发布消息失败: %d", msg_id);
        snprintf(s_lastError, sizeof(s_lastError), "发布消息失败: %d", msg_id);
        s_stats.error_count++;
        return false;
    }
    
    s_stats.message_sent++;
    ESP_LOGD(TAG, "发布消息成功, ID: %d", msg_id);
    
        notifyEvent(MQTT_CLIENT_EVENT_PUBLISHED, NULL);
    return true;
}

/**
 * @brief 发布字符串消息(便捷函数)
 */
bool mqtt_client_publish_string(const char* topic, const char* message, mqtt_qos_t qos, bool retain) {
    if (message == NULL) {
        return mqtt_client_publish(topic, NULL, 0, qos, retain);
    }
    
    return mqtt_client_publish(topic, (const uint8_t*)message, strlen(message), qos, retain);
}

/**
 * @brief 订阅主题
 */
bool mqtt_client_subscribe(const char* topic, mqtt_qos_t qos) {
    if (s_mqttClient == NULL || s_state != MQTT_STATE_CONNECTED) {
        ESP_LOGE(TAG, "MQTT未连接");
        return false;
    }
    
    if (topic == NULL || strlen(topic) == 0) {
        ESP_LOGE(TAG, "主题为空");
        return false;
    }
    
    int msg_id = esp_mqtt_client_subscribe(s_mqttClient, topic, qos);
    
    if (msg_id < 0) {
        ESP_LOGE(TAG, "订阅主题失败: %d", msg_id);
        snprintf(s_lastError, sizeof(s_lastError), "订阅主题失败: %d", msg_id);
        s_stats.error_count++;
        return false;
    }
    
    ESP_LOGI(TAG, "订阅主题成功: %s, ID: %d", topic, msg_id);
    return true;
}

/**
 * @brief 取消订阅主题
 */
bool mqtt_client_unsubscribe(const char* topic) {
    if (s_mqttClient == NULL || s_state != MQTT_STATE_CONNECTED) {
        ESP_LOGE(TAG, "MQTT未连接");
        return false;
    }
    
    if (topic == NULL || strlen(topic) == 0) {
        ESP_LOGE(TAG, "主题为空");
        return false;
    }
    
    int msg_id = esp_mqtt_client_unsubscribe(s_mqttClient, topic);
    
    if (msg_id < 0) {
        ESP_LOGE(TAG, "取消订阅主题失败: %d", msg_id);
        snprintf(s_lastError, sizeof(s_lastError), "取消订阅主题失败: %d", msg_id);
        s_stats.error_count++;
        return false;
    }
    
    ESP_LOGI(TAG, "取消订阅主题成功: %s, ID: %d", topic, msg_id);
    return true;
}

/**
 * @brief 检查是否已连接
 */
bool mqtt_client_is_connected(void) {
    return (s_state == MQTT_STATE_CONNECTED);
}

/**
 * @brief 获取当前状态
 */
mqtt_state_t mqtt_client_get_state(void) {
    return s_state;
}

/**
 * @brief 设置事件回调
 */
void mqtt_client_set_event_callback(mqtt_event_callback_t callback, void* user_data) {
    s_eventCallback = callback;
    s_userData = user_data;
}

/**
 * @brief 获取统计信息
 */
void mqtt_client_get_stats(mqtt_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(stats, &s_stats, sizeof(mqtt_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 获取最后一次错误信息
 */
const char* mqtt_client_get_last_error(void) {
    return s_lastError;
}

/**
 * @brief 启动 MQTT 任务(后台运行)
 */
bool mqtt_client_start_task(void) {
    ESP_LOGI(TAG, "MQTT后台重连由主MQTT任务和ESP-MQTT客户端处理");
    return true;
}

/**
 * @brief 停止 MQTT 任务
 */
void mqtt_client_stop_task(void) {
    s_taskRunning = false;
    s_mqttTask = NULL;
}

//=============================================================================
// 静态函数实现
//=============================================================================

/**
 * @brief MQTT 事件处理
 */
static void mqttEventHandler(void* handler_args, esp_event_base_t base, int32_t event_id, void* event_data) {
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    
    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED: {
            ESP_LOGI(TAG, "MQTT已连接");
            
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            s_state = MQTT_STATE_CONNECTED;
            xSemaphoreGive(s_mutex);
            
            xEventGroupSetBits(s_eventGroup, MQTT_CONNECTED_BIT);
            notifyEvent(MQTT_CLIENT_EVENT_CONNECTED, NULL);
            break;
        }
            
        case MQTT_EVENT_DISCONNECTED: {
            ESP_LOGW(TAG, "MQTT已断开");
            
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            s_state = MQTT_STATE_DISCONNECTED;
            s_stats.disconnect_count++;
            xSemaphoreGive(s_mutex);
            
            xEventGroupSetBits(s_eventGroup, MQTT_DISCONNECTED_BIT);
            xEventGroupClearBits(s_eventGroup, MQTT_CONNECTED_BIT);
            notifyEvent(MQTT_CLIENT_EVENT_DISCONNECTED, NULL);
            break;
        }
            
        case MQTT_EVENT_DATA: {
            ESP_LOGD(TAG, "收到MQTT消息");
            
            if (event->data_len > 0) {
                mqtt_message_t msg;
                memset(&msg, 0, sizeof(msg));
                
                // 复制主题
                size_t topic_len = event->topic_len;
                if (topic_len > MQTT_MAX_TOPIC_LEN - 1) {
                    topic_len = MQTT_MAX_TOPIC_LEN - 1;
                }
                memcpy(msg.topic, event->topic, topic_len);
                msg.topic[topic_len] = '\0';
                
                // 复制payload
                size_t payload_len = event->data_len;
                if (payload_len > MQTT_MAX_PAYLOAD_LEN) {
                    payload_len = MQTT_MAX_PAYLOAD_LEN;
                }
                memcpy(msg.payload, event->data, payload_len);
                msg.payload_len = payload_len;
                
                msg.qos = (mqtt_qos_t)event->qos;
                msg.retain = event->retain;
                
                s_stats.message_received++;
                notifyEvent(MQTT_CLIENT_EVENT_MESSAGE, &msg);
            }
            break;
        }
            
        case MQTT_EVENT_ERROR: {
            ESP_LOGE(TAG, "MQTT错误");

            if (event->error_handle != NULL) {
                if (event->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT) {
                    int sock_errno = event->error_handle->esp_transport_sock_errno;
                    setLastError("tcp transport error: sock_errno=%d tls_last=0x%x tls_stack=0x%x",
                                 sock_errno,
                                 (unsigned)event->error_handle->esp_tls_last_esp_err,
                                 (unsigned)event->error_handle->esp_tls_stack_err);
                    ESP_LOGE(TAG, "TCP transport error: sock_errno=%d, tls_last=0x%x, tls_stack=0x%x",
                             sock_errno,
                             (unsigned)event->error_handle->esp_tls_last_esp_err,
                             (unsigned)event->error_handle->esp_tls_stack_err);
                } else if (event->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
                    setLastError("connection refused: return_code=%d",
                                 event->error_handle->connect_return_code);
                    ESP_LOGE(TAG, "连接被拒绝: return_code=%d", event->error_handle->connect_return_code);
                } else {
                    setLastError("mqtt error type=%d", event->error_handle->error_type);
                    ESP_LOGE(TAG, "MQTT error type=%d", event->error_handle->error_type);
                }
            } else {
                setLastError("mqtt error without details");
            }
            
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            s_state = MQTT_STATE_ERROR;
            s_stats.error_count++;
            xSemaphoreGive(s_mutex);

            xEventGroupSetBits(s_eventGroup, MQTT_DISCONNECTED_BIT);
            xEventGroupClearBits(s_eventGroup, MQTT_CONNECTED_BIT);
            notifyEvent(MQTT_CLIENT_EVENT_ERROR, NULL);
            break;
        }
            
        case MQTT_EVENT_PUBLISHED: {
            ESP_LOGD(TAG, "消息已发布");
            break;
        }
            
        case MQTT_EVENT_BEFORE_CONNECT: {
            ESP_LOGI(TAG, "准备连接MQTT...");
            break;
        }
            
        default:
            break;
    }
}

/**
 * @brief MQTT 任务
 */
static void mqttTask(void* pvParameters) {
    (void)pvParameters;
    
    ESP_LOGI(TAG, "MQTT任务启动");
    
    while (s_taskRunning) {
        vTaskDelay(pdMS_TO_TICKS(100));
        
        // 检查连接状态
        if (s_state == MQTT_STATE_DISCONNECTED || s_state == MQTT_STATE_ERROR) {
            // 尝试重连
            static uint32_t lastReconnectTime = 0;
            uint32_t currentTime = xTaskGetTickCount();
            
            if (currentTime - lastReconnectTime > pdMS_TO_TICKS(MQTT_RETRY_DELAY_MS)) {
                lastReconnectTime = currentTime;
                
                ESP_LOGI(TAG, "尝试重连MQTT...");
                if (mqtt_client_connect(MQTT_SOCKET_TIMEOUT_MS)) {
                    ESP_LOGI(TAG, "MQTT重连成功");
                }
            }
        }
    }
    
    ESP_LOGI(TAG, "MQTT任务结束");
    vTaskDelete(NULL);
}

static void setLastError(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vsnprintf(s_lastError, sizeof(s_lastError), fmt, args);
    va_end(args);
}

/**
 * @brief 通知事件
 */
static void notifyEvent(mqtt_event_t event, void* data) {
    if (s_eventCallback != NULL) {
        s_eventCallback(event, data, s_userData);
    }
}

/**
 * @brief 更新统计信息
 */
static void updateStats(void) {
    s_stats.uptime_seconds = xTaskGetTickCount() / 1000;
}
