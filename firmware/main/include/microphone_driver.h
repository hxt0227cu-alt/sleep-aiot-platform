/**
 * @file microphone_driver.h
 * @brief ICS-43434麦克风驱动头文件
 * @details 实现I2S MEMS麦克风驱动，支持高性能/低功耗/睡眠模式
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __MICROPHONE_DRIVER_H__
#define __MICROPHONE_DRIVER_H__

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
#define MICROPHONE_DRIVER_VERSION_MAJOR  1
#define MICROPHONE_DRIVER_VERSION_MINOR  0
#define MICROPHONE_DRIVER_VERSION_PATCH  0
#define MICROPHONE_DRIVER_VERSION_STR    "1.0.0"

//=============================================================================
// 配置常量
//=============================================================================
#define MIC_BUFFER_SIZE          4096        ///< 音频缓冲区大小
#define MIC_DMA_BUF_COUNT       8           ///< DMA缓冲区数量
#define MIC_DMA_BUF_LEN        512         ///< 每个DMA缓冲区长度
#define MIC_SAMPLE_RATE_HPM    16000       ///< ESP-SR WakeNet/MultiNet sample rate
#define MIC_SAMPLE_RATE_LPM    6250        ///< 低功耗模式采样率(6.25kHz)
#define MIC_SAMPLE_RATE_SLEEP   3125        ///< 睡眠模式采样率(3.125kHz)
#define MIC_BITS_PER_SAMPLE     24          ///< 24位采样
#define MIC_CHANNEL_NUM         1           ///< 单声道

//=============================================================================
// 工作模式枚举
//=============================================================================
typedef enum {
    MIC_MODE_HPM = 0,              ///< 高性能模式(51.2kHz)
    MIC_MODE_LPM = 1,              ///< 低功耗模式(6.25kHz)
    MIC_MODE_SLEEP = 2             ///< 睡眠模式(3.125kHz)
} mic_mode_t;

//=============================================================================
// 麦克风状态枚举
//=============================================================================
typedef enum {
    MIC_STATE_UNINITIALIZED = 0,     ///< 未初始化
    MIC_STATE_INITIALIZED = 1,        ///< 已初始化
    MIC_STATE_RUNNING = 2,            ///< 运行中
    MIC_STATE_PAUSED = 3,             ///< 已暂停
    MIC_STATE_ERROR = 4                ///< 错误状态
} mic_state_t;

//=============================================================================
// 麦克风配置结构
//=============================================================================
typedef struct {
    mic_mode_t mode;                  ///< 工作模式
    uint32_t sample_rate;              ///< 采样率
    uint8_t bits_per_sample;           ///< 位深度
    uint8_t channels;                  ///< 通道数
    uint16_t buffer_size;               ///< 缓冲区大小
    bool enable_noise_gate;             ///< 噪声门使能
    uint8_t noise_gate_threshold;       ///< 噪声门阈值
    bool enable_high_pass;             ///< 高通滤波使能
} mic_config_t;

//=============================================================================
// 麦克风状态信息结构
//=============================================================================
typedef struct {
    mic_state_t state;                 ///< 当前状态
    uint32_t sample_rate;              ///< 当前采样率
    uint16_t buffer_level;              ///< 缓冲区使用量
    uint32_t total_samples;             ///< 总采集样本数
    uint32_t total_time_ms;             ///< 总采集时长(ms)
    uint8_t current_mode;              ///< 当前工作模式
} mic_state_info_t;

//=============================================================================
// 统计信息结构
//=============================================================================
typedef struct {
    uint32_t samples_collected;          ///< 采集样本数
    uint32_t buffer_overruns;           ///< 缓冲区溢出次数
    uint32_t errors;                    ///< 错误次数
    uint32_t mode_switches;             ///< 模式切换次数
} mic_stats_t;

//=============================================================================
// 错误码枚举
//=============================================================================
typedef enum {
    MIC_ERR_NONE = 0,
    MIC_ERR_NOT_INITIALIZED,
    MIC_ERR_ALREADY_RUNNING,
    MIC_ERR_INVALID_PARAM,
    MIC_ERR_HARDWARE_ERROR,
    MIC_ERR_MEMORY_FAILED,
    MIC_ERR_BUFFER_FULL,
    MIC_ERR_NOT_SUPPORTED
} mic_error_t;

//=============================================================================
// 回调函数类型定义
//=============================================================================

/**
 * @brief 麦克风数据回调函数类型
 * @param data 音频数据指针
 * @param len 数据长度(样本数)
 * @param user_data 用户数据
 */
typedef void (*mic_data_callback_t)(
    const int32_t* data,
    uint32_t len,
    void* user_data
);

/**
 * @brief 麦克风事件回调函数类型
 * @param state 麦克风状态
 * @param user_data 用户数据
 */
typedef void (*mic_event_callback_t)(
    mic_state_t state,
    void* user_data
);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化麦克风驱动
 * @param config 配置，为NULL时使用默认配置
 * @return 成功返回MIC_ERR_NONE，失败返回错误码
 */
mic_error_t microphone_init(const mic_config_t* config);

/**
 * @brief 反初始化麦克风驱动
 */
void microphone_deinit(void);

/**
 * @brief 启动麦克风采集
 * @return 成功返回MIC_ERR_NONE，失败返回错误码
 */
mic_error_t microphone_start(void);

/**
 * @brief 停止麦克风采集
 */
void microphone_stop(void);

/**
 * @brief 暂停麦克风采集
 * @return 成功返回MIC_ERR_NONE，失败返回错误码
 */
mic_error_t microphone_pause(void);

/**
 * @brief 恢复麦克风采集
 * @return 成功返回MIC_ERR_NONE，失败返回错误码
 */
mic_error_t microphone_resume(void);

/**
 * @brief 设置工作模式
 * @param mode 工作模式
 * @return 成功返回MIC_ERR_NONE，失败返回错误码
 */
mic_error_t microphone_set_mode(mic_mode_t mode);

/**
 * @brief 获取当前状态
 * @return 麦克风状态
 */
mic_state_t microphone_get_state(void);

/**
 * @brief 获取状态信息
 * @param info 状态信息结构指针，用于存储结果
 */
void microphone_get_state_info(mic_state_info_t* info);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构指针
 */
void microphone_get_stats(mic_stats_t* stats);

/**
 * @brief 设置数据回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void microphone_set_data_callback(mic_data_callback_t callback, void* user_data);

/**
 * @brief 设置事件回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void microphone_set_event_callback(mic_event_callback_t callback, void* user_data);

/**
 * @brief 获取当前工作模式
 * @return 当前工作模式
 */
mic_mode_t microphone_get_mode(void);

#ifdef __cplusplus
}
#endif

#endif /* __MICROPHONE_DRIVER_H__ */
