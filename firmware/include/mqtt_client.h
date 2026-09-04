/**
 * @file mqtt_client.h
 * @brief MQTT 客户端模块头文件
 * @details 提供 MQTT 连接、消息发布/订阅、自动重连等功能
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 */

#ifndef MQTT_CLIENT_H
#define MQTT_CLIENT_H

#include <esp_mqtt_client.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/event_groups.h>

//=============================================================================
// 宏定义
//=============================================================================

#define MQTT_MAX_TOPIC_LEN      128     ///< 最大主题长度
#define MQTT_MAX_PAYLOAD_LEN    1024    ///< 最大消息长度
#define MQTT_MAX_CLIENT_ID_LEN  32      ///< 最大客户端ID长度
#define MQTT_MAX_RETRY_ATTEMPTS 5       ///< 最大重连尝试次数
#define MQTT_RETRY_DELAY_MS     5000    ///< 重连延迟(毫秒)
#define MQTT_KEEPALIVE_SECONDS  30      ///< 保活间隔(秒)
#define MQTT_SOCKET_TIMEOUT_MS  10000   ///< Socket超时(毫秒)

#define MQTT_TASK_STACK_SIZE    8192    ///< MQTT任务堆栈大小
#define MQTT_TASK_PRIORITY      3       ///< MQTT任务优先级

// 事件组位定义
#define MQTT_CONNECTED_BIT      BIT0
#define MQTT_DISCONNECTED_BIT   BIT1
#define MQTT_MESSAGE_BIT        BIT2

//=============================================================================
// 数据类型定义
//=============================================================================

/**
 * @brief MQTT 连接状态
 */
typedef enum {
    MQTT_STATE_DISCONNECTED = 0,     ///< 未连接
    MQTT_STATE_CONNECTING,          ///< 连接中
    MQTT_STATE_CONNECTED,           ///< 已连接
    MQTT_STATE_DISCONNECTING,       ///< 断开中
    MQTT_STATE_ERROR                ///< 错误状态
} mqtt_state_t;

/**
 * @brief MQTT QoS 等级
 */
typedef enum {
    MQTT_QOS_0 = 0,                 ///< 最多一次
    MQTT_QOS_1 = 1,                 ///< 至少一次
    MQTT_QOS_2 = 2                  ///< 恰好一次
} mqtt_qos_t;

/**
 * @brief MQTT 事件类型
 */
typedef enum {
    MQTT_EVENT_CONNECTED = 0,       ///< 已连接
    MQTT_EVENT_DISCONNECTED,        ///< 已断开
    MQTT_EVENT_MESSAGE,              ///< 收到消息
    MQTT_EVENT_PUBLISHED,            ///< 消息已发布
    MQTT_EVENT_ERROR                 ///< 发生错误
} mqtt_event_t;

/**
 * @brief MQTT 消息结构
 */
typedef struct {
    char topic[MQTT_MAX_TOPIC_LEN];         ///< 主题
    uint8_t payload[MQTT_MAX_PAYLOAD_LEN];  ///< 消息内容
    size_t payload_len;                      ///< 消息长度
    mqtt_qos_t qos;                           ///< QoS等级
    bool retain;                              ///< 保留标志
} mqtt_message_t;

/**
 * @brief MQTT 配置结构
 */
typedef struct {
    char broker_host[64];           ///< MQTT服务器地址
    uint16_t broker_port;            ///< MQTT服务器端口
    char client_id[MQTT_MAX_CLIENT_ID_LEN];  ///< 客户端ID
    char username[32];              ///< 用户名
    char password[64];              ///< 密码
    uint16_t keepalive_seconds;     ///< 保活间隔
    bool use_ssl;                   ///< 是否使用SSL/TLS
    bool clean_session;             ///< 是否清理会话
} mqtt_config_t;

/**
 * @brief MQTT 统计信息
 */
typedef struct {
    uint32_t connect_count;         ///< 连接次数
    uint32_t disconnect_count;      ///< 断开次数
    uint32_t message_sent;          ///< 发送消息数
    uint32_t message_received;      ///< 接收消息数
    uint32_t error_count;           ///< 错误次数
    uint32_t reconnect_count;       ///< 重连次数
    uint32_t last_connect_time;     ///< 上次连接时间
    uint32_t uptime_seconds;        ///< 运行时间(秒)
} mqtt_stats_t;

/**
 * @brief MQTT 事件回调函数类型
 */
typedef void (*mqtt_event_callback_t)(mqtt_event_t event, void* data, void* user_data);

//=============================================================================
// 函数声明
//=============================================================================

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief 初始化 MQTT 客户端
 * @param config MQTT配置
 * @return true 成功, false 失败
 */
bool mqtt_client_init(const mqtt_config_t* config);

/**
 * @brief 反初始化 MQTT 客户端
 */
void mqtt_client_deinit(void);

/**
 * @brief 连接到 MQTT 服务器
 * @param timeout_ms 超时时间(毫秒)
 * @return true 成功, false 失败
 */
bool mqtt_client_connect(uint32_t timeout_ms);

/**
 * @brief 断开 MQTT 连接
 */
void mqtt_client_disconnect(void);

/**
 * @brief 重新连接
 * @return true 成功, false 失败
 */
bool mqtt_client_reconnect(void);

/**
 * @brief 发布消息
 * @param topic 主题
 * @param payload 消息内容
 * @param payload_len 消息长度
 * @param qos QoS等级
 * @param retain 保留标志
 * @return true 成功, false 失败
 */
bool mqtt_client_publish(const char* topic, const uint8_t* payload, size_t payload_len, 
                         mqtt_qos_t qos, bool retain);

/**
 * @brief 发布字符串消息(便捷函数)
 * @param topic 主题
 * @param message 消息字符串
 * @param qos QoS等级
 * @param retain 保留标志
 * @return true 成功, false 失败
 */
bool mqtt_client_publish_string(const char* topic, const char* message, mqtt_qos_t qos, bool retain);

/**
 * @brief 订阅主题
 * @param topic 主题
 * @param qos QoS等级
 * @return true 成功, false 失败
 */
bool mqtt_client_subscribe(const char* topic, mqtt_qos_t qos);

/**
 * @brief 取消订阅主题
 * @param topic 主题
 * @return true 成功, false 失败
 */
bool mqtt_client_unsubscribe(const char* topic);

/**
 * @brief 检查是否已连接
 * @return true 已连接, false 未连接
 */
bool mqtt_client_is_connected(void);

/**
 * @brief 获取当前状态
 * @return MQTT状态
 */
mqtt_state_t mqtt_client_get_state(void);

/**
 * @brief 设置事件回调
 * @param callback 回调函数
 * @param user_data 用户数据
 */
void mqtt_client_set_event_callback(mqtt_event_callback_t callback, void* user_data);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构体
 */
void mqtt_client_get_stats(mqtt_stats_t* stats);

/**
 * @brief 获取最后一次错误信息
 * @return 错误描述字符串
 */
const char* mqtt_client_get_last_error(void);

/**
 * @brief 启动 MQTT 任务(后台运行)
 * @return true 成功, false 失败
 */
bool mqtt_client_start_task(void);

/**
 * @brief 停止 MQTT 任务
 */
void mqtt_client_stop_task(void);

/**
 * @brief 检查是否有连接
 * @return true 已连接, false 未连接
 */
static inline bool mqtt_client_has_connection(void) {
    return mqtt_client_is_connected();
}

#ifdef __cplusplus
}
#endif

#endif // MQTT_CLIENT_H
