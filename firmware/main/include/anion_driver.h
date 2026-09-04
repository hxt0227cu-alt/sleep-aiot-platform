/**
 * @file anion_driver.h
 * @brief 负离子发生器控制头文件
 * @details 实现GPIO控制、PWM控制和状态检测
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __ANION_DRIVER_H__
#define __ANION_DRIVER_H__

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
#define ANION_DRIVER_VERSION_MAJOR  1
#define ANION_DRIVER_VERSION_MINOR  0
#define ANION_DRIVER_VERSION_PATCH  0
#define ANION_DRIVER_VERSION_STR    "1.0.0"

//=============================================================================
// 配置常量
//=============================================================================
#define ANION_PWM_FREQUENCY     1000        ///< PWM频率(Hz)
#define ANION_PWM_RESOLUTION     10          ///< PWM分辨率(位)
#define ANION_PWM_CHANNEL       0           ///< PWM通道
#define ANION_PWM_DUTY_MAX     100         ///< 最大占空比(%)

//=============================================================================
// 负离子状态枚举
//=============================================================================
typedef enum {
    ANION_STATE_OFF = 0,            ///< 关闭状态
    ANION_STATE_ON,              ///< 开启状态
    ANION_STATE_ERROR = 2           ///< 错误状态
} anion_state_t;

//=============================================================================
// 负离子配置结构
//=============================================================================
typedef struct {
    bool enable_pwm;                  ///< 是否启用PWM控制
    uint8_t pwm_duty;                ///< PWM占空比(0-100)
    bool auto_off;                   ///< 自动关闭功能
    uint32_t auto_off_delay_ms;       ///< 自动关闭延迟(ms)
} anion_config_t;

//=============================================================================
// 负离子状态信息结构
//=============================================================================
typedef struct {
    anion_state_t state;             ///< 当前状态
    uint8_t current_duty;            ///< 当前PWM占空比
    uint32_t total_on_time_ms;       ///< 总开启时长(ms)
    uint32_t auto_off_count;         ///< 自动关闭次数
} anion_state_info_t;

//=============================================================================
// 统计信息结构
//=============================================================================
typedef struct {
    uint32_t total_on_count;            ///< 总开启次数
    uint32_t total_off_count;           ///< 总关闭次数
    uint32_t total_auto_off_count;      ///< 总自动关闭次数
    uint32_t total_on_time_ms;         ///< 总开启时长(ms)
} anion_stats_t;

//=============================================================================
// 错误码枚举
//=============================================================================
typedef enum {
    ANION_ERR_NONE = 0,
    ANION_ERR_NOT_INITIALIZED,
    ANION_ERR_INVALID_PARAM,
    ANION_ERR_HARDWARE_ERROR,
    ANION_ERR_MEMORY_FAILED
} anion_error_t;

//=============================================================================
// 回调函数类型定义
//=============================================================================

/**
 * @brief 负离子事件回调函数类型
 * @param state 负离子状态
 * @param user_data 用户数据
 */
typedef void (*anion_event_callback_t)(
    anion_state_t state,
    void* user_data
);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化负离子发生器
 * @param config 配置，为NULL时使用默认配置
 * @return 成功返回ANION_ERR_NONE，失败返回错误码
 */
anion_error_t anion_init(const anion_config_t* config);

/**
 * @brief 反初始化负离子发生器
 */
void anion_deinit(void);

/**
 * @brief 开启负离子发生器
 * @return 成功返回ANION_ERR_NONE，失败返回错误码
 */
anion_error_t anion_on(void);

/**
 * @brief 关闭负离子发生器
 * @return 成功返回ANION_ERR_NONE，失败返回错误码
 */
anion_error_t anion_off(void);

/**
 * @brief 设置PWM占空比
 * @param duty 占空比(0-100)
 * @return 成功返回ANION_ERR_NONE，失败返回错误码
 */
anion_error_t anion_set_duty(uint8_t duty);

/**
 * @brief 获取当前状态
 * @return 负离子状态
 */
anion_state_t anion_get_state(void);

/**
 * @brief 获取状态信息
 * @param info 状态信息结构指针，用于存储结果
 */
void anion_get_state_info(anion_state_info_t* info);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构指针
 */
void anion_get_stats(anion_stats_t* stats);

/**
 * @brief 设置事件回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void anion_set_event_callback(anion_event_callback_t callback, void* user_data);

/**
 * @brief 启用自动关闭功能
 * @param enable true=启用，false=禁用
 * @param delay_ms 自动关闭延迟(ms)
 * @return 成功返回ANION_ERR_NONE，失败返回错误码
 */
anion_error_t anion_set_auto_off(bool enable, uint32_t delay_ms);

#ifdef __cplusplus
}
#endif

#endif /* __ANION_DRIVER_H__ */
