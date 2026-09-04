/**
 * @file light_control.h
 * @brief 灯光控制服务头文件
 * @details 实现PWM调光、色温控制、渐变效果和光闹钟管理
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __LIGHT_CONTROL_H__
#define __LIGHT_CONTROL_H__

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
#define LIGHT_CONTROL_VERSION_MAJOR  1
#define LIGHT_CONTROL_VERSION_MINOR  0
#define LIGHT_CONTROL_VERSION_PATCH  0
#define LIGHT_CONTROL_VERSION_STR    "1.0.0"

//=============================================================================
// 配置常量
//=============================================================================
#define LIGHT_ALARM_DURATION_MIN     10          ///< 光闹钟最短时长(分钟)
#define LIGHT_ALARM_DURATION_MAX     30          ///< 光闹钟最长时长(分钟)
#define LIGHT_ALARM_DEFAULT_DURATION 20          ///< 光闹钟默认时长(分钟)
#define LIGHT_FADE_STEP_MS          50          ///< 渐变步长(ms)
#define LIGHT_MAX_TIMERS            5           ///< 最大定时器数量

//=============================================================================
// 灯光状态枚举
//=============================================================================
typedef enum {
    LIGHT_STATE_OFF = 0,
    LIGHT_STATE_ON,
    LIGHT_STATE_FADING,
    LIGHT_STATE_ALARM
} light_state_t;

//=============================================================================
// 光闹钟状态枚举
//=============================================================================
typedef enum {
    LIGHT_ALARM_IDLE = 0,
    LIGHT_ALARM_RUNNING,
    LIGHT_ALARM_PAUSED,
    LIGHT_ALARM_COMPLETED
} light_alarm_state_t;

//=============================================================================
// 灯光配置结构
//=============================================================================
typedef struct {
    uint8_t brightness;              ///< 亮度 (0-100)
    uint16_t color_temp;             ///< 色温 (2700-6500K)
    bool power;                      ///< 电源状态
} light_config_t;

//=============================================================================
// 光闹钟配置结构
//=============================================================================
typedef struct {
    bool enabled;                    ///< 是否启用
    uint8_t hour;                    ///< 小时 (0-23)
    uint8_t minute;                  ///< 分钟 (0-59)
    uint8_t duration;                ///< 渐变时长(分钟)
    uint8_t target_brightness;        ///<.目标亮度 (0-100)
    uint16_t target_color_temp;       ///< 目标色温 (2700-6500K)
    bool repeat[7];                  ///< 重复设置 (周一到周日)
} light_alarm_config_t;

//=============================================================================
// 光闹钟状态结构
//=============================================================================
typedef struct {
    light_alarm_state_t state;        ///< 状态
    uint32_t start_time;             ///< 开始时间
    uint8_t current_brightness;       ///< 当前亮度
    uint16_t current_color_temp;      ///< 当前色温
    uint8_t progress;                ///< 进度 (0-100)
} light_alarm_status_t;

//=============================================================================
// 统计信息结构
//=============================================================================
typedef struct {
    uint32_t total_on_time;           ///< 总开启时间(秒)
    uint32_t alarm_triggered_count;    ///< 光闹钟触发次数
    uint32_t fade_count;              ///< 渐变次数
    uint32_t last_change_time;        ///< 最后改变时间
} light_stats_t;

//=============================================================================
// 错误码枚举
//=============================================================================
typedef enum {
    LIGHT_ERR_NONE = 0,
    LIGHT_ERR_NOT_INITIALIZED,
    LIGHT_ERR_INVALID_PARAM,
    LIGHT_ERR_PWM_FAILED,
    LIGHT_ERR_TIMER_FAILED,
    LIGHT_ERR_ALARM_FULL
} light_error_t;

//=============================================================================
// 回调函数类型定义
//=============================================================================

/**
 * @brief 灯光事件回调函数类型
 * @param event 事件类型
 * @param data 事件数据
 * @param user_data 用户数据
 */
typedef void (*light_event_callback_t)(
    int event,
    void* data,
    void* user_data
);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化灯光控制服务
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_init(void);

/**
 * @brief 反初始化灯光控制服务
 */
void light_control_deinit(void);

/**
 * @brief 开启灯光
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_on(void);

/**
 * @brief 关闭灯光
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_off(void);

/**
 * @brief 设置亮度
 * @param brightness 亮度 (0-100)
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_set_brightness(uint8_t brightness);

/**
 * @brief 设置色温
 * @param color_temp 色温 (2700-6500K)
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_set_color_temp(uint16_t color_temp);

/**
 * @brief 设置亮度和色温
 * @param brightness 亮度 (0-100)
 * @param color_temp 色温 (2700-6500K)
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_set_brightness_color(uint8_t brightness, uint16_t color_temp);

/**
 * @brief 渐变到目标状态
 * @param brightness 目标亮度 (0-100)
 * @param color_temp 目标色温 (2700-6500K)
 * @param duration_ms 渐变时长(ms)
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_fade_to(uint8_t brightness, uint16_t color_temp, uint32_t duration_ms);

/**
 * @brief 获取当前状态
 * @return 灯光状态
 */
light_state_t light_control_get_state(void);

/**
 * @brief 获取当前配置
 * @param config 配置结构指针，用于存储结果
 */
void light_control_get_config(light_config_t* config);

/**
 * @brief 添加光闹钟
 * @param config 光闹钟配置
 * @return 成功返回闹钟ID(0-4)，失败返回-1
 */
int light_control_add_alarm(const light_alarm_config_t* config);

/**
 * @brief 删除光闹钟
 * @param alarm_id 闹钟ID
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_remove_alarm(int alarm_id);

/**
 * @brief 启用/禁用光闹钟
 * @param alarm_id 闹钟ID
 * @param enabled true=启用, false=禁用
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_enable_alarm(int alarm_id, bool enabled);

/**
 * @brief 获取光闹钟状态
 * @param alarm_id 闹钟ID
 * @param status 状态结构指针，用于存储结果
 * @return 成功返回LIGHT_ERR_NONE，失败返回错误码
 */
light_error_t light_control_get_alarm_status(int alarm_id, light_alarm_status_t* status);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构指针
 */
void light_control_get_stats(light_stats_t* stats);

/**
 * @brief 设置事件回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void light_control_set_event_callback(light_event_callback_t callback, void* user_data);

#ifdef __cplusplus
}
#endif

#endif /* __LIGHT_CONTROL_H__ */
