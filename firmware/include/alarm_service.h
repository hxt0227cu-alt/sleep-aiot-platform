/**
 * @file alarm_service.h
 * @brief 报警服务头文件
 * @details 实现本地报警（蜂鸣器/LED）和远程报警（MQTT推送）
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __ALARM_SERVICE_H__
#define __ALARM_SERVICE_H__

#include <stdint.h>
#include <stdbool.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#ifdef __cplusplus
extern "C" {
#endif

//=============================================================================
// 版本信息
//=============================================================================
#define ALARM_SERVICE_VERSION_MAJOR  1
#define ALARM_SERVICE_VERSION_MINOR  0
#define ALARM_SERVICE_VERSION_PATCH  0
#define ALARM_SERVICE_VERSION_STR    "1.0.0"

//=============================================================================
// 配置常量
//=============================================================================
#define ALARM_DEDUP_WINDOW_MS      300000      ///< 报警去重时间窗口(5分钟)
#define ALARM_MAX_ALARMS           10          ///< 最大报警数量
#define ALARM_BEEP_DURATION_MS      200         ///< 蜂鸣器鸣叫时长(ms)
#define ALARM_LED_BLINK_INTERVAL_MS 500         ///< LED闪烁间隔(ms)
#define ALARM_MAX_HISTORY         50          ///< 最大历史记录数

//=============================================================================
// 报警级别枚举
//=============================================================================
typedef enum {
    ALARM_LEVEL_INFO = 0,
    ALARM_LEVEL_WARNING,
    ALARM_LEVEL_CRITICAL
} alarm_level_t;

//=============================================================================
// 报警类型枚举
//=============================================================================
typedef enum {
    ALARM_TYPE_NONE = 0,
    ALARM_TYPE_HEART_RATE_HIGH,
    ALARM_TYPE_HEART_RATE_LOW,
    ALARM_TYPE_BREATHING_RATE_HIGH,
    ALARM_TYPE_BREATHING_RATE_LOW,
    ALARM_TYPE_NO_MOVEMENT,
    ALARM_TYPE_APNEA,
    ALARM_TYPE_SLEEP_ABNORMAL,
    ALARM_TYPE_SYSTEM_ERROR
} alarm_type_t;

//=============================================================================
// 报警状态枚举
//=============================================================================
typedef enum {
    ALARM_STATE_IDLE = 0,
    ALARM_STATE_TRIGGERED,
    ALARM_STATE_ACKNOWLEDGED,
    ALARM_STATE_CLEARED
} alarm_state_t;

//=============================================================================
// 报警配置结构
//=============================================================================
typedef struct {
    bool enable_local;              ///< 启用本地报警
    bool enable_remote;             ///< 启用远程报警
    bool enable_dedup;             ///< 启用去重
    uint32_t dedup_window_ms;       ///< 去重时间窗口(ms)
    
    uint8_t heart_rate_high_threshold;   ///< 心率过高阈值
    uint8_t heart_rate_low_threshold;    ///< 心率过低阈值
    uint8_t breathing_rate_high_threshold; ///< 呼吸率过高阈值
    uint8_t breathing_rate_low_threshold;  ///< 呼吸率过低阈值
    uint32_t no_movement_timeout_ms;      ///< 无体动超时(ms)
} alarm_config_t;

//=============================================================================
// 报警记录结构
//=============================================================================
typedef struct {
    alarm_type_t type;             ///< 报警类型
    alarm_level_t level;           ///< 报警级别
    alarm_state_t state;           ///< 报警状态
    uint32_t timestamp;            ///< 时间戳
    uint8_t value;                ///< 报警值
    char message[64];             ///< 报警消息
} alarm_record_t;

//=============================================================================
// 统计信息结构
//=============================================================================
typedef struct {
    uint32_t total_triggered;      ///< 总触发次数
    uint32_t total_acknowledged;   ///< 总确认次数
    uint32_t total_cleared;        ///< 总清除次数
    uint32_t by_type[ALARM_TYPE_SYSTEM_ERROR + 1];  ///< 按类型统计
    uint32_t last_alarm_time;      ///< 最后报警时间
} alarm_stats_t;

//=============================================================================
// 错误码枚举
//=============================================================================
typedef enum {
    ALARM_ERR_NONE = 0,
    ALARM_ERR_NOT_INITIALIZED,
    ALARM_ERR_INVALID_PARAM,
    ALARM_ERR_QUEUE_FULL,
    ALARM_ERR_MQTT_FAILED
} alarm_error_t;

//=============================================================================
// 回调函数类型定义
//=============================================================================

/**
 * @brief 报警事件回调函数类型
 * @param alarm 报警记录
 * @param user_data 用户数据
 */
typedef void (*alarm_callback_t)(
    const alarm_record_t* alarm,
    void* user_data
);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化报警服务
 * @param config 配置，为NULL时使用默认配置
 * @return 成功返回ALARM_ERR_NONE，失败返回错误码
 */
alarm_error_t alarm_service_init(const alarm_config_t* config);

/**
 * @brief 反初始化报警服务
 */
void alarm_service_deinit(void);

/**
 * @brief 触发报警
 * @param type 报警类型
 * @param level 报警级别
 * @param value 报警值
 * @param message 报警消息
 * @return 成功返回ALARM_ERR_NONE，失败返回错误码
 */
alarm_error_t alarm_service_trigger(alarm_type_t type, alarm_level_t level, uint8_t value, const char* message);

/**
 * @brief 确认报警
 * @param alarm_id 报警ID
 * @return 成功返回ALARM_ERR_NONE，失败返回错误码
 */
alarm_error_t alarm_service_acknowledge(int alarm_id);

/**
 * @brief 清除报警
 * @param alarm_id 报警ID
 * @return 成功返回ALARM_ERR_NONE，失败返回错误码
 */
alarm_error_t alarm_service_clear(int alarm_id);

/**
 * @brief 清除所有报警
 * @return 成功返回ALARM_ERR_NONE，失败返回错误码
 */
alarm_error_t alarm_service_clear_all(void);

/**
 * @brief 设置配置
 * @param config 新的配置
 * @return 成功返回ALARM_ERR_NONE，失败返回错误码
 */
alarm_error_t alarm_service_set_config(const alarm_config_t* config);

/**
 * @brief 获取当前配置
 * @param config 配置结构指针，用于存储结果
 */
void alarm_service_get_config(alarm_config_t* config);

/**
 * @brief 获取报警记录
 * @param records 报警记录数组
 * @param max_count 最大数量
 * @return 实际获取的数量
 */
int alarm_service_get_records(alarm_record_t* records, int max_count);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构指针
 */
void alarm_service_get_stats(alarm_stats_t* stats);

/**
 * @brief 设置报警回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void alarm_service_set_callback(alarm_callback_t callback, void* user_data);

/**
 * @brief 检查心率报警
 * @param heart_rate 心率值
 * @return 成功返回ALARM_ERR_NONE，失败返回错误码
 */
alarm_error_t alarm_service_check_heart_rate(uint8_t heart_rate);

/**
 * @brief 检查呼吸率报警
 * @param breathing_rate 呼吸率值
 * @return 成功返回ALARM_ERR_NONE，失败返回错误码
 */
alarm_error_t alarm_service_check_breathing_rate(uint8_t breathing_rate);

/**
 * @brief 检查体动报警
 * @param movement_level 体动级别
 * @return 成功返回ALARM_ERR_NONE，失败返回错误码
 */
alarm_error_t alarm_service_check_movement(uint8_t movement_level);

#ifdef __cplusplus
}
#endif

#endif /* __ALARM_SERVICE_H__ */
