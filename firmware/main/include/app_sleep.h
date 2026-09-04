/**
 * @file app_sleep.h
 * @brief 睡眠监测应用层头文件
 * @details 负责睡眠数据采集、分析处理、异常检测、数据上报和睡眠质量评分
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __APP_SLEEP_H__
#define __APP_SLEEP_H__

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
#define APP_SLEEP_VERSION_MAJOR  1
#define APP_SLEEP_VERSION_MINOR  0
#define APP_SLEEP_VERSION_PATCH  0
#define APP_SLEEP_VERSION_STR    "1.0.0"

//=============================================================================
// 配置常量
//=============================================================================
#define APP_SLEEP_TASK_STACK_SIZE    8192        ///< 睡眠监测任务堆栈大小
#define APP_SLEEP_TASK_PRIORITY      5           ///< 睡眠监测任务优先级
#define APP_SLEEP_DATA_QUEUE_SIZE     50          ///< 数据队列大小
#define APP_SLEEP_CACHE_SIZE          100         ///< 本地缓存大小
#define APP_SLEEP_ANALYSIS_INTERVAL_MS  1000     ///< 数据分析间隔(ms)
#define APP_SLEEP_REPORT_INTERVAL_MS     5000     ///< 数据上报间隔(ms)
#define APP_SLEEP_SCORE_UPDATE_INTERVAL_MS 60000 ///< 睡眠评分更新间隔(ms)

// 睡眠阶段时长阈值（分钟）
#define APP_SLEEP_MIN_SLEEP_DURATION      30      ///< 最小睡眠时长
#define APP_SLEEP_DEEP_SLEEP_MIN_RATIO    0.15    ///< 深睡最小占比
#define APP_SLEEP_LIGHT_SLEEP_MIN_RATIO   0.50    ///< 浅睡最小占比
#define APP_SLEEP_AWAKE_MAX_RATIO        0.20    ///< 清醒最大占比

//=============================================================================
// 睡眠监测状态枚举
//=============================================================================
typedef enum {
    APP_SLEEP_STATE_IDLE = 0,          ///< 空闲状态
    APP_SLEEP_STATE_MONITORING,        ///< 监测中
    APP_SLEEP_STATE_ANALYZING,         ///< 分析中
    APP_SLEEP_STATE_REPORTING,          ///< 上报中
    APP_SLEEP_STATE_ERROR               ///< 错误状态
} app_sleep_state_t;

//=============================================================================
// 睡眠阶段枚举
//=============================================================================
typedef enum {
    SLEEP_STAGE_AWAKE = 0,             ///< 清醒
    SLEEP_STAGE_LIGHT,                 ///< 浅睡
    SLEEP_STAGE_DEEP,                  ///< 深睡
    SLEEP_STAGE_REM,                   ///< 快速眼动
    SLEEP_STAGE_NONE                   ///< 无数据
} sleep_stage_t;

//=============================================================================
// 睡眠质量等级枚举
//=============================================================================
typedef enum {
    SLEEP_QUALITY_EXCELLENT = 0,       ///< 优秀 (90-100分)
    SLEEP_QUALITY_GOOD,                ///< 良好 (80-89分)
    SLEEP_QUALITY_FAIR,                ///< 一般 (60-79分)
    SLEEP_QUALITY_POOR,                ///< 较差 (40-59分)
    SLEEP_QUALITY_BAD                  ///< 很差 (0-39分)
} sleep_quality_t;

//=============================================================================
// 睡眠监测配置结构
//=============================================================================
typedef struct {
    bool enable_monitoring;            ///< 启用睡眠监测
    bool enable_analysis;              ///< 启用数据分析
    bool enable_report;                 ///< 启用数据上报
    bool enable_cache;                  ///< 启用本地缓存
    bool enable_alarm;                  ///< 启用异常报警
    
    uint32_t analysis_interval_ms;     ///< 分析间隔(ms)
    uint32_t report_interval_ms;       ///< 上报间隔(ms)
    uint32_t cache_max_size;            ///< 缓存最大大小
    
    // 阈值配置
    uint8_t heart_rate_high_threshold;  ///< 心率过高阈值
    uint8_t heart_rate_low_threshold;   ///< 心率过低阈值
    uint8_t breathing_rate_high_threshold; ///< 呼吸率过高阈值
    uint8_t breathing_rate_low_threshold;  ///< 呼吸率过低阈值
    uint32_t no_movement_timeout_ms;   ///< 无体动超时(ms)
} app_sleep_config_t;

//=============================================================================
// 实时睡眠数据结构
//=============================================================================
typedef struct {
    uint32_t timestamp;                               ///< 时间戳
    
    // 心率数据
    uint8_t heart_rate;                      ///< 心率(bpm)
    bool heart_rate_valid;                   ///< 心率数据有效
    
    // 呼吸数据
    uint8_t breathing_rate;                  ///< 呼吸率(次/分钟)
    bool breathing_rate_valid;               ///< 呼吸率数据有效
    
    // 体动数据
    uint8_t movement_level;                   ///< 体动幅度(0-100)
    bool movement_valid;                     ///< 体动数据有效
    
    // 睡眠状态
    uint8_t sleep_state;                     ///< 睡眠状态(0=深睡,1=浅睡,2=清醒,3=离床)
    bool sleep_state_valid;                  ///< 睡眠状态有效
    
    // 入床状态
    uint8_t bed_state;                       ///< 入床状态(0=离床,1=入床)
    bool bed_state_valid;                    ///< 入床状态有效
    
    // 人体存在
    uint8_t presence;                        ///< 存在状态(0=无人,1=有人)
    bool presence_valid;                     ///< 存在状态有效
    
    // 人体距离
    uint16_t distance_cm;                    ///< 人体距离(cm)
    bool distance_valid;                     ///< 跷离数据有效
    
    bool valid;                              ///< 数据整体有效标志
} app_sleep_realtime_data_t;

//=============================================================================
// 睡眠统计结构
//=============================================================================
typedef struct {
    uint32_t start_time;                     ///< 睡眠开始时间
    uint32_t end_time;                       ///< 睡眠结束时间
    uint32_t total_duration_sec;             ///< 总时长(秒)
    
    // 各阶段时长(秒)
    uint32_t awake_duration_sec;             ///< 清醒时长
    uint32_t light_sleep_duration_sec;       ///< 浅睡时长
    uint32_t deep_sleep_duration_sec;        ///< 深睡时长
    uint32_t rem_duration_sec;               ///< REM时长
    
    // 心率统计
    uint16_t heart_rate_count;               ///< 心率数据计数
    uint32_t heart_rate_sum;                 ///< 心率总和
    uint8_t heart_rate_min;                  ///< 心率最小值
    uint8_t heart_rate_max;                  ///< 心率最大值
    uint8_t heart_rate_avg;                  ///< 心率平均值
    
    // 呼吸率统计
    uint16_t breathing_rate_count;           ///< 呼吸率数据计数
    uint32_t breathing_rate_sum;             ///< 呼吸率总和
    uint8_t breathing_rate_min;              ///< 呼吸率最小值
    uint8_t breathing_rate_max;              ///< 呼吸率最大值
    uint8_t breathing_rate_avg;               ///< 呼吸率平均值
    
    // 体动统计
    uint16_t movement_count;                 ///< 体动数据计数
    uint32_t movement_sum;                   ///< 体动总和
    uint8_t movement_avg;                    ///< 体动平均值
    uint8_t turn_over_count;                 ///< 翻身次数
    uint8_t large_move_count;                ///< 大幅度体动次数
    uint8_t small_move_count;                ///< 小幅度体动次数
    
    // 离床统计
    uint8_t away_count;                      ///< 离床次数
    uint32_t away_duration_sec;              ///< 离床总时长
    
    // 睡眠质量
    uint8_t sleep_score;                    ///< 睡眠质量评分(0-100)
    sleep_quality_t sleep_quality;           ///< 睡眠质量等级
    
    bool valid;                              ///< 数据有效标志
} app_sleep_statistics_t;

//=============================================================================
// 睡眠质量评分结构
//=============================================================================
typedef struct {
    uint8_t total_score;                     ///< 总分(0-100)
    sleep_quality_t quality_level;            ///< 质量等级
    
    // 各项得分
    uint8_t duration_score;                  ///< 睡眠时长得分
    uint8_t deep_sleep_score;                ///< 深睡占比得分
    uint8_t continuity_score;               ///< 睡眠连续性得分
    uint8_t heart_rate_score;                ///< 心率稳定性得分
    uint8_t breathing_score;                 ///< 呼吸稳定性得分
    uint8_t movement_score;                  ///< 体动得分
    
    uint32_t timestamp;                      ///< 评分时间
    bool valid;                              ///< 数据有效标志
} app_sleep_score_t;

//=============================================================================
// 异常检测结构
//=============================================================================
typedef struct {
    bool heart_rate_high;                    ///< 心率过高
    bool heart_rate_low;                     ///< 心率过低
    bool breathing_rate_high;                 ///< 呼吸率过高
    bool breathing_rate_low;                  ///< 呼吸率过低
    bool no_movement;                        ///< 无体动
    bool apnea;                              ///< 呼吸暂停
    bool sleep_abnormal;                      ///< 睡眠异常
    
    uint32_t last_alarm_time;                ///< 最后报警时间
    uint8_t alarm_count;                     ///< 报警计数
} app_sleep_alarm_t;

//=============================================================================
// 统计信息结构
//=============================================================================
typedef struct {
    uint32_t total_samples;                  ///< 总采样数
    uint32_t valid_samples;                  ///< 有效采样数
    uint32_t analysis_count;                 ///< 分析次数
    uint32_t report_count;                   ///< 上报次数
    uint32_t alarm_count;                    ///< 报警次数
    uint32_t uptime_seconds;                 ///< 运行时间(秒)
    uint32_t last_update_time;               ///< 最后更新时间
} app_sleep_stats_t;

//=============================================================================
// 错误码枚举
//=============================================================================
typedef enum {
    APP_SLEEP_ERR_NONE = 0,
    APP_SLEEP_ERR_NOT_INITIALIZED,
    APP_SLEEP_ERR_ALREADY_RUNNING,
    APP_SLEEP_ERR_QUEUE_FULL,
    APP_SLEEP_ERR_MQTT_FAILED,
    APP_SLEEP_ERR_CACHE_FAILED,
    APP_SLEEP_ERR_INVALID_PARAM,
    APP_SLEEP_ERR_NO_MEMORY,
    APP_SLEEP_ERR_TIMEOUT
} app_sleep_error_t;

//=============================================================================
// 回调函数类型定义
//=============================================================================

/**
 * @brief 睡眠数据回调函数类型
 * @param data 实时睡眠数据
 * @param user_data 用户数据
 */
typedef void (*app_sleep_data_callback_t)(
    const app_sleep_realtime_data_t* data,
    void* user_data
);

/**
 * @brief 睡眠统计回调函数类型
 * @param stats 睡眠统计数据
 * @param user_data 用户数据
 */
typedef void (*app_sleep_stats_callback_t)(
    const app_sleep_statistics_t* stats,
    void* user_data
);

/**
 * @brief 睡眠质量评分回调函数类型
 * @param score 睡眠质量评分
 * @param user_data 用户数据
 */
typedef void (*app_sleep_score_callback_t)(
    const app_sleep_score_t* score,
    void* user_data
);

/**
 * @brief 异常报警回调函数类型
 * @param alarm 异常检测结构
 * @param user_data 用户数据
 */
typedef void (*app_sleep_alarm_callback_t)(
    const app_sleep_alarm_t* alarm,
    void* user_data
);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化睡眠监测应用层
 * @param config 配置，为NULL时使用默认配置
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_init(const app_sleep_config_t* config);

/**
 * @brief 反初始化睡眠监测应用层
 */
void app_sleep_deinit(void);

/**
 * @brief 启动睡眠监测
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_start(void);

/**
 * @brief 停止睡眠监测
 */
void app_sleep_stop(void);

/**
 * @brief 获取当前状态
 * @return 睡眠监测状态
 */
app_sleep_state_t app_sleep_get_state(void);

/**
 * @brief 设置配置
 * @param config 新的配置
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_set_config(const app_sleep_config_t* config);

/**
 * @brief 获取当前配置
 * @param config 配置结构指针，用于存储结果
 */
void app_sleep_get_config(app_sleep_config_t* config);

/**
 * @brief 获取实时睡眠数据
 * @param data 实时数据结构指针
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_get_realtime_data(app_sleep_realtime_data_t* data);

/**
 * @brief 获取睡眠统计
 * @param stats 统计结构指针
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_get_statistics(app_sleep_statistics_t* stats);

/**
 * @brief 获取睡眠质量评分
 * @param score 评分结构指针
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_get_score(app_sleep_score_t* score);

/**
 * @brief 获取异常检测状态
 * @param alarm 异常检测结构指针
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_get_alarm(app_sleep_alarm_t* alarm);

/**
 * @brief 手动触发数据分析
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_analyze_now(void);

/**
 * @brief 手动触发数据上报
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_report_now(void);

/**
 * @brief 重置睡眠统计
 * @return 成功返回APP_SLEEP_ERR_NONE，失败返回错误码
 */
app_sleep_error_t app_sleep_reset_statistics(void);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构指针
 */
void app_sleep_get_stats(app_sleep_stats_t* stats);

/**
 * @brief 注册睡眠数据回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void app_sleep_register_data_callback(app_sleep_data_callback_t callback, void* user_data);

/**
 * @brief 注册睡眠统计回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void app_sleep_register_stats_callback(app_sleep_stats_callback_t callback, void* user_data);

/**
 * @brief 注册睡眠质量评分回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void app_sleep_register_score_callback(app_sleep_score_callback_t callback, void* user_data);

/**
 * @brief 注册异常报警回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void app_sleep_register_alarm_callback(app_sleep_alarm_callback_t callback, void* user_data);

/**
 * @brief 雷达数据回调（内部调用）
 * @param type 数据类型
 * @param data 数据
 * @param user_data 用户数据
 */
void app_sleep_radar_callback(radar_data_type_t type, const radar_data_union_t* data, void* user_data);

#ifdef __cplusplus
}
#endif

#endif /* __APP_SLEEP_H__ */
