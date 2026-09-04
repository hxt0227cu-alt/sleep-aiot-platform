/**
 * @file audio_driver.cpp
 * @brief 音频驱动模块实现
 * @details 实现I2S音频驱动，支持MAX98357A功放和ICS-43434麦克风
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#include "audio_driver.h"
#include "config.h"
#include <math.h>
#include <string.h>
#include <esp_heap_caps.h>
#include <esp_intr_alloc.h>
#include <esp_log.h>
#include <driver/i2s.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>

static const char* TAG = "AUDIO_DRV";

#undef log_i
#undef log_e
#define log_i(format, ...) ESP_LOGI(TAG, format, ##__VA_ARGS__)
#define log_e(format, ...) ESP_LOGE(TAG, format, ##__VA_ARGS__)

//=============================================================================
// 静态变量
//=============================================================================

static audio_config_t s_config;
static audio_state_info_t s_stateInfo;
static audio_stats_t s_stats = {};
static audio_error_t s_lastError = AUDIO_ERR_NONE;
static SemaphoreHandle_t s_mutex = NULL;
static QueueHandle_t s_audioQueue = NULL;

// 回调函数
static audio_data_callback_t s_dataCallback = NULL;
static audio_event_callback_t s_eventCallback = NULL;
static void* s_userData = NULL;

// I2S配置
static i2s_pin_config_t s_ampChannel = {};
static i2s_config_t s_i2sConfig = {};

// 音量控制
static uint8_t s_volume = 80;
static bool s_muted = false;

// 缓冲区
static int16_t* s_playBuffer = NULL;
static int16_t* s_recordBuffer = NULL;
static uint32_t s_playBufferHead = 0;
static uint32_t s_playBufferTail = 0;
static uint32_t s_recordBufferHead = 0;
static uint32_t s_recordBufferTail = 0;

// 任务句柄
static TaskHandle_t s_playTask = NULL;
static TaskHandle_t s_recordTask = NULL;
static volatile bool s_playTaskRunning = false;
static volatile bool s_recordTaskRunning = false;

//=============================================================================
// 静态函数声明
//=============================================================================

static void playTask(void* pvParameters);
static void recordTask(void* pvParameters);
static void notifyEvent(audio_state_t state);
static void notifyData(const int16_t* data, uint32_t len);
static bool applyNoiseGate(int16_t* data, uint32_t len);
static void updateStats(void);

//=============================================================================
// API 实现
//=============================================================================

audio_error_t audio_init(const audio_config_t* config) {
    log_i("初始化音频驱动...");
    
    // 创建互斥锁
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        log_e("创建互斥锁失败");
        return AUDIO_ERR_MEMORY_FAILED;
    }
    
    // 初始化配置
    if (config != NULL) {
        memcpy(&s_config, config, sizeof(audio_config_t));
    } else {
        memset(&s_config, 0, sizeof(audio_config_t));
        s_config.amp_enabled = true;
        s_config.amp_sample_rate = AMP_I2S_SAMPLE_RATE;
        s_config.amp_bits_per_sample = AMP_I2S_BITS_PER_SAMPLE;
        s_config.amp_channels = AMP_I2S_CHANNEL_NUM;
        s_config.mic_enabled = true;
        s_config.mic_sample_rate = MIC_I2S_SAMPLE_RATE;
        s_config.mic_bits_per_sample = MIC_I2S_BITS_PER_SAMPLE;
        s_config.mic_channels = MIC_I2S_CHANNEL_NUM;
        s_config.buffer_size = 4096;
        s_config.enable_noise_gate = true;
        s_config.noise_gate_threshold = 10;
    }
    
    // 初始化状态
    memset(&s_stateInfo, 0, sizeof(audio_state_info_t));
    s_stateInfo.state = AUDIO_STATE_INITIALIZED;
    s_stateInfo.amp_sample_rate = s_config.amp_sample_rate;
    s_stateInfo.mic_sample_rate = s_config.mic_sample_rate;
    
    // 分配缓冲区
    s_playBuffer = (int16_t*)heap_caps_malloc(s_config.buffer_size * sizeof(int16_t), 
                                                  MALLOC_CAP_SPIRAM);
    if (s_playBuffer == NULL) {
        log_e("分配播放缓冲区失败");
        return AUDIO_ERR_MEMORY_FAILED;
    }
    
    s_recordBuffer = (int16_t*)heap_caps_malloc(s_config.buffer_size * sizeof(int16_t), 
                                                   MALLOC_CAP_SPIRAM);
    if (s_recordBuffer == NULL) {
        log_e("分配录音缓冲区失败");
        heap_caps_free(s_playBuffer);
        s_playBuffer = NULL;
        return AUDIO_ERR_MEMORY_FAILED;
    }
    
    // 创建音频队列
    s_audioQueue = xQueueCreate(10, sizeof(int16_t) * 256);
    if (s_audioQueue == NULL) {
        log_e("创建音频队列失败");
        heap_caps_free(s_playBuffer);
        heap_caps_free(s_recordBuffer);
        s_playBuffer = NULL;
        s_recordBuffer = NULL;
        return AUDIO_ERR_MEMORY_FAILED;
    }
    
    // 配置I2S标准配置
    s_i2sConfig.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
    s_i2sConfig.sample_rate = s_config.amp_sample_rate;
    s_i2sConfig.bits_per_sample = (i2s_bits_per_sample_t)s_config.amp_bits_per_sample;
    s_i2sConfig.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
    s_i2sConfig.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    s_i2sConfig.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
    s_i2sConfig.dma_buf_count = 8;
    s_i2sConfig.dma_buf_len = 64;
    s_i2sConfig.use_apll = false;
    s_i2sConfig.tx_desc_auto_clear = true;
    s_i2sConfig.fixed_mclk = 0;
    s_i2sConfig.mclk_multiple = I2S_MCLK_MULTIPLE_256;
    s_i2sConfig.bits_per_chan = I2S_BITS_PER_CHAN_DEFAULT;
    
    esp_err_t err = i2s_driver_install(I2S_NUM_0, &s_i2sConfig, 0, NULL);
    if (err != ESP_OK) {
        log_e("安装I2S驱动失败: %d", err);
        return AUDIO_ERR_HARDWARE_ERROR;
    }
    
    // 配置功放通道（输出）
    s_ampChannel.mck_io_num = I2S_PIN_NO_CHANGE;
    s_ampChannel.bck_io_num = AMP_I2S_BCLK_PIN;
    s_ampChannel.ws_io_num = AMP_I2S_WS_PIN;
    s_ampChannel.data_out_num = AMP_I2S_SD_PIN;
    s_ampChannel.data_in_num = I2S_PIN_NO_CHANGE;

    err = i2s_set_pin(I2S_NUM_0, &s_ampChannel);
    if (err != ESP_OK) {
        log_e("配置功放引脚失败: %d", err);
        return AUDIO_ERR_HARDWARE_ERROR;
    }
    
    log_i("音频驱动初始化完成");
    return AUDIO_ERR_NONE;
}

void audio_deinit(void) {
    log_i("反初始化音频驱动...");
    
    // 停止任务
    if (s_playTaskRunning) {
        s_playTaskRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    if (s_recordTaskRunning) {
        s_recordTaskRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    // 停止I2S
    i2s_stop(I2S_NUM_0);
    i2s_driver_uninstall(I2S_NUM_0);
    
    // 释放缓冲区
    if (s_playBuffer != NULL) {
        heap_caps_free(s_playBuffer);
        s_playBuffer = NULL;
    }
    
    if (s_recordBuffer != NULL) {
        heap_caps_free(s_recordBuffer);
        s_recordBuffer = NULL;
    }
    
    // 释放队列
    if (s_audioQueue != NULL) {
        vQueueDelete(s_audioQueue);
        s_audioQueue = NULL;
    }
    
    // 释放互斥锁
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_stateInfo.state = AUDIO_STATE_UNINITIALIZED;
    log_i("音频驱动反初始化完成");
}

audio_error_t audio_start(void) {
    if (s_stateInfo.state == AUDIO_STATE_RUNNING) {
        return AUDIO_ERR_ALREADY_RUNNING;
    }
    
    log_i("启动音频驱动...");
    
    esp_err_t err = i2s_start(I2S_NUM_0);
    if (err != ESP_OK) {
        log_e("启动I2S失败: %d", err);
        return AUDIO_ERR_HARDWARE_ERROR;
    }
    
    s_stateInfo.state = AUDIO_STATE_RUNNING;
    s_lastError = AUDIO_ERR_NONE;
    
    notifyEvent(AUDIO_STATE_RUNNING);
    log_i("音频驱动已启动");
    return AUDIO_ERR_NONE;
}

void audio_stop(void) {
    if (s_stateInfo.state != AUDIO_STATE_RUNNING && 
        s_stateInfo.state != AUDIO_STATE_PAUSED) {
        return;
    }
    
    log_i("停止音频驱动...");
    
    // 停止播放任务
    if (s_playTaskRunning) {
        s_playTaskRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    // 停止录音任务
    if (s_recordTaskRunning) {
        s_recordTaskRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    // 停止I2S
    i2s_stop(I2S_NUM_0);
    
    s_stateInfo.state = AUDIO_STATE_INITIALIZED;
    s_stateInfo.amp_playing = false;
    s_stateInfo.mic_recording = false;
    
    notifyEvent(AUDIO_STATE_INITIALIZED);
    log_i("音频驱动已停止");
}

audio_error_t audio_pause(void) {
    if (s_stateInfo.state != AUDIO_STATE_RUNNING) {
        return AUDIO_ERR_NOT_INITIALIZED;
    }
    
    log_i("暂停音频播放...");
    
    s_stateInfo.state = AUDIO_STATE_PAUSED;
    s_stateInfo.amp_playing = false;
    
    notifyEvent(AUDIO_STATE_PAUSED);
    return AUDIO_ERR_NONE;
}

audio_error_t audio_resume(void) {
    if (s_stateInfo.state != AUDIO_STATE_PAUSED) {
        return AUDIO_ERR_NOT_INITIALIZED;
    }
    
    log_i("恢复音频播放...");
    
    s_stateInfo.state = AUDIO_STATE_RUNNING;
    s_stateInfo.amp_playing = true;
    
    notifyEvent(AUDIO_STATE_RUNNING);
    return AUDIO_ERR_NONE;
}

audio_error_t audio_play(const int16_t* data, uint32_t len) {
    if (data == NULL || len == 0) {
        return AUDIO_ERR_INVALID_PARAM;
    }
    
    if (s_stateInfo.state != AUDIO_STATE_RUNNING) {
        return AUDIO_ERR_NOT_INITIALIZED;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    // 应用噪声门
    if (s_config.enable_noise_gate) {
        if (!applyNoiseGate((int16_t*)data, len)) {
            xSemaphoreGive(s_mutex);
            return AUDIO_ERR_NONE;
        }
    }
    
    // 写入I2S
    size_t bytes_written = 0;
    esp_err_t err = i2s_write(I2S_NUM_0, (const char*)data, len * sizeof(int16_t), 
                               &bytes_written, portMAX_DELAY);
    
    if (err != ESP_OK) {
        log_e("I2S写入失败: %d", err);
        xSemaphoreGive(s_mutex);
        return AUDIO_ERR_HARDWARE_ERROR;
    }
    
    s_stateInfo.amp_playing = true;
    s_stats.samples_played += len;
    updateStats();
    
    xSemaphoreGive(s_mutex);
    return AUDIO_ERR_NONE;
}

audio_error_t audio_play_blocking(const int16_t* data, uint32_t len) {
    if (data == NULL || len == 0) {
        return AUDIO_ERR_INVALID_PARAM;
    }
    
    if (s_stateInfo.state != AUDIO_STATE_RUNNING) {
        return AUDIO_ERR_NOT_INITIALIZED;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    // 应用噪声门
    if (s_config.enable_noise_gate) {
        if (!applyNoiseGate((int16_t*)data, len)) {
            xSemaphoreGive(s_mutex);
            return AUDIO_ERR_NONE;
        }
    }
    
    // 写入I2S（阻塞）
    size_t bytes_written = 0;
    esp_err_t err = i2s_write(I2S_NUM_0, (const char*)data, len * sizeof(int16_t), 
                               &bytes_written, pdMS_TO_TICKS(5000));
    
    if (err != ESP_OK) {
        log_e("I2S写入失败: %d", err);
        xSemaphoreGive(s_mutex);
        return AUDIO_ERR_HARDWARE_ERROR;
    }
    
    s_stateInfo.amp_playing = true;
    s_stats.samples_played += len;
    updateStats();
    
    xSemaphoreGive(s_mutex);
    return AUDIO_ERR_NONE;
}

audio_error_t audio_set_volume(uint8_t volume) {
    if (volume > 100) {
        volume = 100;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_volume = volume;
    xSemaphoreGive(s_mutex);
    
    return AUDIO_ERR_NONE;
}

uint8_t audio_get_volume(void) {
    return s_volume;
}

audio_error_t audio_mute(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_muted = true;
    xSemaphoreGive(s_mutex);
    
    return AUDIO_ERR_NONE;
}

audio_error_t audio_unmute(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_muted = false;
    xSemaphoreGive(s_mutex);
    
    return AUDIO_ERR_NONE;
}

bool audio_is_muted(void) {
    return s_muted;
}

audio_error_t audio_start_recording(void) {
    if (s_stateInfo.state != AUDIO_STATE_RUNNING) {
        return AUDIO_ERR_NOT_INITIALIZED;
    }

    ESP_LOGW(TAG, "audio_driver仅负责I2S0功放播放，录音请使用microphone_driver");
    return AUDIO_ERR_NOT_SUPPORTED;
}

audio_error_t audio_stop_recording(void) {
    if (!s_recordTaskRunning) {
        return AUDIO_ERR_NOT_INITIALIZED;
    }
    
    log_i("停止录音...");
    
    s_recordTaskRunning = false;
    s_stateInfo.mic_recording = false;
    
    vTaskDelay(pdMS_TO_TICKS(100));
    return AUDIO_ERR_NONE;
}

bool audio_is_recording(void) {
    return s_recordTaskRunning;
}

bool audio_is_playing(void) {
    return s_stateInfo.amp_playing;
}

audio_state_t audio_get_state(void) {
    return s_stateInfo.state;
}

void audio_get_state_info(audio_state_info_t* info) {
    if (info != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(info, &s_stateInfo, sizeof(audio_state_info_t));
        xSemaphoreGive(s_mutex);
    }
}

void audio_get_stats(audio_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(stats, &s_stats, sizeof(audio_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

void audio_clear_stats(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memset(&s_stats, 0, sizeof(audio_stats_t));
    xSemaphoreGive(s_mutex);
}

audio_error_t audio_set_config(const audio_config_t* config) {
    if (config == NULL) {
        return AUDIO_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memcpy(&s_config, config, sizeof(audio_config_t));
    xSemaphoreGive(s_mutex);
    
    return AUDIO_ERR_NONE;
}

void audio_get_config(audio_config_t* config) {
    if (config != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(config, &s_config, sizeof(audio_config_t));
        xSemaphoreGive(s_mutex);
    }
}

void audio_set_data_callback(audio_data_callback_t callback, void* user_data) {
    s_dataCallback = callback;
    s_userData = user_data;
}

void audio_set_event_callback(audio_event_callback_t callback, void* user_data) {
    s_eventCallback = callback;
    s_userData = user_data;
}

audio_error_t audio_get_last_error(void) {
    return s_lastError;
}

uint32_t audio_get_buffer_available(void) {
    if (s_playBuffer == NULL) {
        return 0;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    uint32_t available = (s_config.buffer_size - 
                         (s_playBufferHead - s_playBufferTail)) % s_config.buffer_size;
    xSemaphoreGive(s_mutex);
    
    return available;
}

uint32_t audio_get_buffer_level(void) {
    if (s_playBuffer == NULL) {
        return 0;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    uint32_t level = (s_playBufferHead - s_playBufferTail) % s_config.buffer_size;
    xSemaphoreGive(s_mutex);
    
    return level;
}

void audio_clear_buffer(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    if (s_playBuffer != NULL) {
        memset(s_playBuffer, 0, s_config.buffer_size * sizeof(int16_t));
    }
    
    if (s_recordBuffer != NULL) {
        memset(s_recordBuffer, 0, s_config.buffer_size * sizeof(int16_t));
    }
    
    s_playBufferHead = 0;
    s_playBufferTail = 0;
    s_recordBufferHead = 0;
    s_recordBufferTail = 0;
    
    xSemaphoreGive(s_mutex);
}

//=============================================================================
// 静态函数实现
//=============================================================================

static void playTask(void* pvParameters) {
    (void)pvParameters;
    log_i("音频播放任务启动");
    
    while (s_playTaskRunning) {
        // 从队列获取数据
        int16_t data[256];
        if (xQueueReceive(s_audioQueue, data, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (!s_muted) {
                audio_play(data, 256);
            }
        }
    }
    
    log_i("音频播放任务结束");
    vTaskDelete(NULL);
}

static void recordTask(void* pvParameters) {
    (void)pvParameters;
    log_i("音频录音任务启动");
    
    uint8_t buffer[512];
    
    while (s_recordTaskRunning) {
        // 从I2S读取数据
        size_t bytes_read = 0;
        esp_err_t err = i2s_read(I2S_NUM_0, (char*)buffer, sizeof(buffer), 
                                   &bytes_read, portMAX_DELAY);
        
        if (err == ESP_OK && bytes_read > 0) {
            uint32_t samples = bytes_read / sizeof(int16_t);
            
            // 应用噪声门
            if (s_config.enable_noise_gate) {
                if (!applyNoiseGate((int16_t*)buffer, samples)) {
                    continue;
                }
            }
            
            // 通知数据回调
            notifyData((int16_t*)buffer, samples);
            
            s_stats.samples_recorded += samples;
            updateStats();
        }
        
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    
    log_i("音频录音任务结束");
    vTaskDelete(NULL);
}

static void notifyEvent(audio_state_t state) {
    if (s_eventCallback != NULL) {
        s_eventCallback(state, s_userData);
    }
}

static void notifyData(const int16_t* data, uint32_t len) {
    if (s_dataCallback != NULL) {
        s_dataCallback(data, len, s_userData);
    }
}

static bool applyNoiseGate(int16_t* data, uint32_t len) {
    if (!s_config.enable_noise_gate) {
        return true;
    }
    
    // 计算RMS值
    int64_t sum = 0;
    for (uint32_t i = 0; i < len; i++) {
        sum += (int64_t)data[i] * data[i];
    }
    
    int32_t rms = (int32_t)sqrt((float)sum / len);
    
    // 比较阈值
    if (rms < s_config.noise_gate_threshold) {
        return false;
    }
    
    return true;
}

static void updateStats(void) {
    if (s_stateInfo.amp_playing) {
        s_stateInfo.total_play_time_ms += 100;
    }
    
    if (s_stateInfo.mic_recording) {
        s_stateInfo.total_record_time_ms += 100;
    }
}
