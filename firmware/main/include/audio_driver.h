/**
 * @file audio_driver.h
 * @brief 音频驱动模块头文件
 * @details 提供I2S音频驱动，支持MAX98357A功放和ICS-43434麦克风
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __AUDIO_DRIVER_H__
#define __AUDIO_DRIVER_H__

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
    AUDIO_ERR_NONE = 0,              ///< 无错误
    AUDIO_ERR_NOT_INITIALIZED = -1,    ///< 未初始化
    AUDIO_ERR_ALREADY_RUNNING = -2,     ///< 已在运行
    AUDIO_ERR_INVALID_PARAM = -3,       ///< 参数无效
    AUDIO_ERR_HARDWARE_ERROR = -4,      ///< 硬件错误
    AUDIO_ERR_MEMORY_FAILED = -5,       ///< 内存分配失败
    AUDIO_ERR_BUFFER_FULL = -6,         ///< 缓冲区满
    AUDIO_ERR_NOT_SUPPORTED = -7,       ///< 不支持的操作
} audio_error_t;

//=============================================================================
// 状态定义
//=============================================================================

typedef enum {
    AUDIO_STATE_UNINITIALIZED = 0,     ///< 未初始化
    AUDIO_STATE_INITIALIZED = 1,        ///< 已初始化
    AUDIO_STATE_RUNNING = 2,            ///< 运行中
    AUDIO_STATE_PAUSED = 3,             ///< 已暂停
    AUDIO_STATE_ERROR = 4                ///< 错误状态
} audio_state_t;

//=============================================================================
// 音频格式定义
//=============================================================================

typedef enum {
    AUDIO_FORMAT_PCM_16BIT = 0,       ///< 16位PCM
    AUDIO_FORMAT_PCM_24BIT = 1,       ///< 24位PCM
    AUDIO_FORMAT_PCM_32BIT = 2,       ///< 32位PCM
} audio_format_t;

//=============================================================================
// 音频配置结构体
//=============================================================================

typedef struct {
    // 功放配置
    bool amp_enabled;                   ///< 功放使能
    uint32_t amp_sample_rate;           ///< 功放采样率
    uint8_t amp_bits_per_sample;        ///< 功放位深度
    uint8_t amp_channels;              ///< 功放通道数
    
    // 麦克风配置
    bool mic_enabled;                   ///< 麦克风使能
    uint32_t mic_sample_rate;           ///< 麦克风采样率
    uint8_t mic_bits_per_sample;        ///< 麦克风位深度
    uint8_t mic_channels;              ///< 麦克风通道数
    
    // 缓冲区配置
    uint16_t buffer_size;               ///< 缓冲区大小
    bool enable_noise_gate;             ///< 噪声门使能
    uint8_t noise_gate_threshold;       ///< 噪声门阈值
} audio_config_t;

//=============================================================================
// 音频状态结构体
//=============================================================================

typedef struct {
    audio_state_t state;                 ///< 驱动状态
    bool amp_playing;                   ///< 功放播放中
    bool mic_recording;                  ///< 麦克风录音中
    uint32_t amp_sample_rate;           ///< 当前功放采样率
    uint32_t mic_sample_rate;           ///< 当前麦克风采样率
    uint16_t buffer_level;              ///< 缓冲区使用量
    uint32_t total_play_time_ms;        ///< 总播放时长(ms)
    uint32_t total_record_time_ms;      ///< 总录音时长(ms)
} audio_state_info_t;

//=============================================================================
// 统计信息结构体
//=============================================================================

typedef struct {
    uint32_t samples_played;            ///< 播放样本数
    uint32_t samples_recorded;          ///< 录音样本数
    uint32_t buffer_overruns;           ///< 缓冲区溢出次数
    uint32_t errors;                    ///< 错误次数
} audio_stats_t;

//=============================================================================
// 音频数据回调函数类型
//=============================================================================

typedef void (*audio_data_callback_t)(const int16_t* data, uint32_t len, void* user_data);

//=============================================================================
// 事件回调函数类型
//=============================================================================

typedef void (*audio_event_callback_t)(audio_state_t state, void* user_data);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化音频驱动
 * @param config 配置参数（NULL使用默认配置）
 * @return 错误码
 */
audio_error_t audio_init(const audio_config_t* config);

/**
 * @brief 反初始化音频驱动
 */
void audio_deinit(void);

/**
 * @brief 启动音频驱动
 * @return 错误码
 */
audio_error_t audio_start(void);

/**
 * @brief 停止音频驱动
 */
void audio_stop(void);

/**
 * @brief 暂停音频播放
 * @return 错误码
 */
audio_error_t audio_pause(void);

/**
 * @brief 恢复音频播放
 * @return 错误码
 */
audio_error_t audio_resume(void);

/**
 * @brief 播放音频数据
 * @param data 音频数据指针
 * @param len 数据长度（样本数）
 * @return 错误码
 */
audio_error_t audio_play(const int16_t* data, uint32_t len);

/**
 * @brief 播放音频数据（阻塞模式）
 * @param data 音频数据指针
 * @param len 数据长度（样本数）
 * @return 错误码
 */
audio_error_t audio_play_blocking(const int16_t* data, uint32_t len);

/**
 * @brief 设置音量
 * @param volume 音量值 (0-100)
 * @return 错误码
 */
audio_error_t audio_set_volume(uint8_t volume);

/**
 * @brief 获取音量
 * @return 音量值 (0-100)
 */
uint8_t audio_get_volume(void);

/**
 * @brief 静音
 * @return 错误码
 */
audio_error_t audio_mute(void);

/**
 * @brief 取消静音
 * @return 错误码
 */
audio_error_t audio_unmute(void);

/**
 * @brief 检查是否静音
 * @return true=静音, false=未静音
 */
bool audio_is_muted(void);

/**
 * @brief 开始录音
 * @return 错误码
 */
audio_error_t audio_start_recording(void);

/**
 * @brief 停止录音
 * @return 错误码
 */
audio_error_t audio_stop_recording(void);

/**
 * @brief 检查是否正在录音
 * @return true=录音中, false=未录音
 */
bool audio_is_recording(void);

/**
 * @brief 检查是否正在播放
 * @return true=播放中, false=未播放
 */
bool audio_is_playing(void);

/**
 * @brief 获取驱动状态
 * @return 驱动状态
 */
audio_state_t audio_get_state(void);

/**
 * @brief 获取状态信息
 * @param info 状态信息结构体指针
 */
void audio_get_state_info(audio_state_info_t* info);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构体指针
 */
void audio_get_stats(audio_stats_t* stats);

/**
 * @brief 清除统计信息
 */
void audio_clear_stats(void);

/**
 * @brief 设置配置
 * @param config 配置参数
 * @return 错误码
 */
audio_error_t audio_set_config(const audio_config_t* config);

/**
 * @brief 获取配置
 * @param config 配置结构体指针
 */
void audio_get_config(audio_config_t* config);

/**
 * @brief 设置音频数据回调
 * @param callback 回调函数
 * @param user_data 用户数据
 */
void audio_set_data_callback(audio_data_callback_t callback, void* user_data);

/**
 * @brief 设置事件回调
 * @param callback 回调函数
 * @param user_data 用户数据
 */
void audio_set_event_callback(audio_event_callback_t callback, void* user_data);

/**
 * @brief 获取最后一个错误
 * @return 错误码
 */
audio_error_t audio_get_last_error(void);

/**
 * @brief 获取缓冲区可用空间
 * @return 可用空间（样本数）
 */
uint32_t audio_get_buffer_available(void);

/**
 * @brief 获取缓冲区数据量
 * @return 缓冲区数据量（样本数）
 */
uint32_t audio_get_buffer_level(void);

/**
 * @brief 清空缓冲区
 */
void audio_clear_buffer(void);

#ifdef __cplusplus
}
#endif

#endif /* __AUDIO_DRIVER_H__ */
