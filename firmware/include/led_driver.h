/**
 * @file led_driver.h
 * @brief LED调光驱动模块头文件
 * @details 提供双色温LED的PWM调光驱动，支持亮度、色温调节和预设场景
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __LED_DRIVER_H__
#define __LED_DRIVER_H__

#include <stdint.h>
#include <stdbool.h>
#include "esp_log.h"

#ifdef __cplusplus
extern "C" {
#endif

//=============================================================================
// 错误码定义
//=============================================================================

typedef enum {
    LED_ERR_NONE = 0,              ///< 无错误
    LED_ERR_NOT_INITIALIZED = -1,    ///< 未初始化
    LED_ERR_ALREADY_RUNNING = -2,     ///< 已在运行
    LED_ERR_INVALID_PARAM = -3,       ///< 参数无效
    LED_ERR_HARDWARE_ERROR = -4,      ///< 硬件错误
    LED_ERR_MEMORY_FAILED = -5,       ///< 内存分配失败
} led_error_t;

//=============================================================================
// 状态定义
//=============================================================================

typedef enum {
    LED_STATE_UNINITIALIZED = 0,     ///< 未初始化
    LED_STATE_INITIALIZED = 1,        ///< 已初始化
    LED_STATE_RUNNING = 2,            ///< 运行中
    LED_STATE_ERROR = 3                ///< 错误状态
} led_state_t;

//=============================================================================
// 预设场景定义
//=============================================================================

typedef enum {
    LED_SCENE_CUSTOM = 0,             ///< 自定义
    LED_SCENE_READING = 1,            ///< 阅读模式
    LED_SCENE_SLEEP = 2,              ///< 睡眠模式
    LED_SCENE_RELAX = 3,              ///< 放松模式
    LED_SCENE_WORK = 4,               ///< 工作模式
    LED_SCENE_OFF = 5                 ///< 关闭
} led_scene_t;

//=============================================================================
// LED配置结构体
//=============================================================================

typedef struct {
    bool enabled;                      ///< 使能状态
    uint8_t brightness;                 ///< 亮度 (0-100)
    uint16_t color_temp;               ///< 色温 (2700-6500K)
    led_scene_t scene;                 ///< 当前场景
    bool smooth_transition;             ///< 平滑过渡使能
    uint16_t transition_time_ms;        ///< 过渡时间(ms)
} led_config_t;

//=============================================================================
// LED状态结构体
//=============================================================================

typedef struct {
    led_state_t state;                 ///< 驱动状态
    uint8_t brightness;                 ///< 当前亮度 (0-100)
    uint16_t color_temp;               ///< 当前色温 (2700-6500K)
    uint8_t cold_duty;                 ///< 冷色温占空比 (0-1023)
    uint8_t warm_duty;                 ///< 暖色温占空比 (0-1023)
    led_scene_t scene;                 ///< 当前场景
    uint32_t on_time_ms;               ///< 开启时长(ms)
    uint32_t change_count;              ///< 亮度/色温改变次数
} led_state_info_t;

//=============================================================================
// 统计信息结构体
//=============================================================================

typedef struct {
    uint32_t total_on_time_ms;           ///< 总开启时长(ms)
    uint32_t brightness_changes;         ///< 亮度改变次数
    uint32_t color_temp_changes;        ///< 色温改变次数
    uint32_t scene_changes;            ///< 场景切换次数
    uint32_t errors;                   ///< 错误次数
} led_stats_t;

//=============================================================================
// 事件回调函数类型
//=============================================================================

typedef void (*led_event_callback_t)(led_state_t state, void* user_data);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化LED驱动
 * @param config 配置参数（NULL使用默认配置）
 * @return 错误码
 */
led_error_t led_init(const led_config_t* config);

/**
 * @brief 反初始化LED驱动
 */
void led_deinit(void);

/**
 * @brief 启动LED驱动
 * @return 错误码
 */
led_error_t led_start(void);

/**
 * @brief 停止LED驱动
 */
void led_stop(void);

/**
 * @brief 设置亮度
 * @param brightness 亮度值 (0-100)
 * @param smooth 是否平滑过渡
 * @return 错误码
 */
led_error_t led_set_brightness(uint8_t brightness, bool smooth);

/**
 * @brief 设置色温
 * @param color_temp 色温值 (2700-6500K)
 * @param smooth 是否平滑过渡
 * @return 错误码
 */
led_error_t led_set_color_temp(uint16_t color_temp, bool smooth);

/**
 * @brief 同时设置亮度和色温
 * @param brightness 亮度值 (0-100)
 * @param color_temp 色温值 (2700-6500K)
 * @param smooth 是否平滑过渡
 * @return 错误码
 */
led_error_t led_set_brightness_color(uint8_t brightness, uint16_t color_temp, bool smooth);

/**
 * @brief 切换预设场景
 * @param scene 场景类型
 * @return 错误码
 */
led_error_t led_set_scene(led_scene_t scene);

/**
 * @brief 打开LED
 * @return 错误码
 */
led_error_t led_on(void);

/**
 * @brief 关闭LED
 * @return 错误码
 */
led_error_t led_off(void);

/**
 * @brief 切换LED开关状态
 * @return 错误码
 */
led_error_t led_toggle(void);

/**
 * @brief 获取当前亮度
 * @return 亮度值 (0-100)
 */
uint8_t led_get_brightness(void);

/**
 * @brief 获取当前色温
 * @return 色温值 (2700-6500K)
 */
uint16_t led_get_color_temp(void);

/**
 * @brief 获取当前场景
 * @return 场景类型
 */
led_scene_t led_get_scene(void);

/**
 * @brief 检查LED是否开启
 * @return true=开启, false=关闭
 */
bool led_is_on(void);

/**
 * @brief 获取驱动状态
 * @return 驱动状态
 */
led_state_t led_get_state(void);

/**
 * @brief 获取状态信息
 * @param info 状态信息结构体指针
 */
void led_get_state_info(led_state_info_t* info);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构体指针
 */
void led_get_stats(led_stats_t* stats);

/**
 * @brief 清除统计信息
 */
void led_clear_stats(void);

/**
 * @brief 设置配置
 * @param config 配置参数
 * @return 错误码
 */
led_error_t led_set_config(const led_config_t* config);

/**
 * @brief 获取配置
 * @param config 配置结构体指针
 */
void led_get_config(led_config_t* config);

/**
 * @brief 设置事件回调
 * @param callback 回调函数
 * @param user_data 用户数据
 */
void led_set_event_callback(led_event_callback_t callback, void* user_data);

/**
 * @brief 获取最后一个错误
 * @return 错误码
 */
led_error_t led_get_last_error(void);

#ifdef __cplusplus
}
#endif

#endif /* __LED_DRIVER_H__ */
