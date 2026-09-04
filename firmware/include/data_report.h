/**
 * @file data_report.h
 * @brief 数据上报服务头文件
 * @details 负责接收雷达数据、聚合、缓存和MQTT上报
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __DATA_REPORT_H__
#define __DATA_REPORT_H__

#include <stdint.h>
#include <stdbool.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
#include "radar_driver.h"

#ifdef __cplusplus
extern "C" {
#endif

//=============================================================================
// 版本信息
//=============================================================================
#define DATA_REPORT_VERSION_MAJOR  1
#define DATA_REPORT_VERSION_MINOR  0
#define DATA_REPORT_VERSION_PATCH  0
#define DATA_REPORT_VERSION_STR    "1.0.0"

//=============================================================================
// 配置常量
//=============================================================================
#define DATA_REPORT_QUEUE_SIZE       50          ///< 数据队列大小
#define DATA_REPORT_BUFFER_SIZE      100         ///< 缓存数据大小
#define DATA_REPORT_MAX_RETRY        3           ///< 最大重试次数
#define DATA_REPORT_AGGREGATE_1MIN   60          ///< 1分钟聚合周期(秒)
#define DATA_REPORT_AGGREGATE_5MIN   300         ///< 5分钟聚合周期(秒)
#define DATA_REPORT_CACHE_FILE       "/spiffs/data_cache.bin"  ///< 缓存文件路径

//=============================================================================
// 数据上报状态枚举
//=============================================================================
typedef enum {
    DATA_REPORT_STATE_STOPPED = 0,
    DATA_REPORT_STATE_RUNNING,
    DATA_REPORT_STATE_ERROR
} data_report_state_t;

//=============================================================================
// 数据上报配置结构
//=============================================================================
typedef struct {
    bool enable_1min_aggregate;      ///< 启用1分钟聚合
    bool enable_5min_aggregate;      ///< 启用5分钟聚合
    bool enable_realtime;             ///< 启用实时上报
    bool enable_cache;                ///< 启用本地缓存
    uint32_t report_interval_ms;      ///< 上报间隔(ms)
    uint32_t cache_max_size;          ///< 缓存最大大小
} data_report_config_t;

//=============================================================================
// 聚合数据结构
//=============================================================================
typedef struct {
    uint32_t timestamp;               ///< 时间戳
    uint32_t start_time;              ///< 聚合开始时间
    
    uint16_t heart_rate_count;        ///< 心率数据计数
    uint32_t heart_rate_sum;          ///< 心率总和
    uint8_t heart_rate_min;          ///< 心率最小值
    uint8_t heart_rate_max;          ///< 心率最大值
    uint8_t heart_rate_avg;           ///< 心率平均值
    
    uint16_t breathing_rate_count;    ///< 呼吸率数据计数
    uint32_t breathing_rate_sum;      ///< 呼吸率总和
    uint8_t breathing_rate_min;      ///< 呼吸率最小值
    uint8_t breathing_rate_max;      ///< 呼吸率最大值
    uint8_t breathing_rate_avg;       ///< 呼吸率平均值
    
    uint8_t sleep_state;              ///< 睡眠状态
    uint8_t presence;                ///< 存在状态
    
    uint8_t turn_over_count;          ///< 翻身次数
    uint8_t large_move_pct;          ///< 大幅度体动占比
    uint8_t small_move_pct;          ///< 小幅度体动占比
    
    bool valid;                       ///< 数据有效标志
} data_report_aggregate_t;

//=============================================================================
// 统计信息结构
//=============================================================================
typedef struct {
    uint32_t total_received;          ///< 总接收数据数
    uint32_t total_sent;              ///< 总发送数据数
    uint32_t total_failed;             ///< 总失败数
    uint32_t cache_count;              ///< 缓存数据数
    uint32_t last_report_time;         ///< 最后上报时间
    uint32_t uptime_seconds;           ///< 运行时间(秒)
} data_report_stats_t;

//=============================================================================
// 错误码枚举
//=============================================================================
typedef enum {
    DATA_REPORT_ERR_NONE = 0,
    DATA_REPORT_ERR_NOT_INITIALIZED,
    DATA_REPORT_ERR_ALREADY_RUNNING,
    DATA_REPORT_ERR_QUEUE_FULL,
    DATA_REPORT_ERR_MQTT_FAILED,
    DATA_REPORT_ERR_CACHE_FAILED,
    DATA_REPORT_ERR_MEMORY_FAILED
} data_report_error_t;

//=============================================================================
// 回调函数类型定义
//=============================================================================

/**
 * @brief 数据上报事件回调函数类型
 * @param event 事件类型
 * @param data 事件数据
 * @param user_data 用户数据
 */
typedef void (*data_report_event_callback_t)(
    int event,
    void* data,
    void* user_data
);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化数据上报服务
 * @param config 配置，为NULL时使用默认配置
 * @return 成功返回DATA_REPORT_ERR_NONE，失败返回错误码
 */
data_report_error_t data_report_init(const data_report_config_t* config);

/**
 * @brief 反初始化数据上报服务
 */
void data_report_deinit(void);

/**
 * @brief 启动数据上报服务
 * @return 成功返回DATA_REPORT_ERR_NONE，失败返回错误码
 */
data_report_error_t data_report_start(void);

/**
 * @brief 停止数据上报服务
 */
void data_report_stop(void);

/**
 * @brief 获取当前状态
 * @return 数据上报状态
 */
data_report_state_t data_report_get_state(void);

/**
 * @brief 设置配置
 * @param config 新的配置
 * @return 成功返回DATA_REPORT_ERR_NONE，失败返回错误码
 */
data_report_error_t data_report_set_config(const data_report_config_t* config);

/**
 * @brief 获取当前配置
 * @param config 配置结构指针，用于存储结果
 */
void data_report_get_config(data_report_config_t* config);

/**
 * @brief 注册雷达数据回调
 * @details 内部调用，由雷达驱动调用
 * @param type 数据类型
 * @param data 数据
 * @param user_data 用户数据
 */
void data_report_radar_callback(radar_data_type_t type, const radar_data_union_t* data, void* user_data);

/**
 * @brief 手动上报数据
 * @return 成功返回DATA_REPORT_ERR_NONE，失败返回错误码
 */
data_report_error_t data_report_report_now(void);

/**
 * @brief 清除缓存数据
 * @return 成功返回DATA_REPORT_ERR_NONE，失败返回错误码
 */
data_report_error_t data_report_clear_cache(void);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构指针
 */
void data_report_get_stats(data_report_stats_t* stats);

/**
 * @brief 设置事件回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void data_report_set_event_callback(data_report_event_callback_t callback, void* user_data);

#ifdef __cplusplus
}
#endif

#endif /* __DATA_REPORT_H__ */
