/**
 * @file microphone_driver.cpp
 * @brief ICS-43434麦克风驱动实现
 * @details 实现I2S MEMS麦克风驱动，支持高性能/低功耗/睡眠模式
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 */

#include "microphone_driver.h"
#include "config.h"
#include <esp_heap_caps.h>
#include <esp_intr_alloc.h>
#include <esp_log.h>
#include <driver/i2s.h>
#include <driver/gpio.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
#include <string.h>

static const char* TAG = "MIC_DRIVER";

//=============================================================================
// 静态变量
//=============================================================================

static mic_config_t s_config;
static mic_state_info_t s_stateInfo;
static mic_stats_t s_stats = {};
static mic_error_t s_lastError = MIC_ERR_NONE;
static SemaphoreHandle_t s_mutex = NULL;
static QueueHandle_t s_micQueue = NULL;
static TaskHandle_t s_micTask = NULL;
static volatile bool s_taskRunning = false;

static mic_data_callback_t s_dataCallback = NULL;
static mic_event_callback_t s_eventCallback = NULL;
static void* s_userData = NULL;

static bool s_initialized = false;

static int32_t* s_dmaBuffer = NULL;
static uint32_t s_dmaBufferHead = 0;
static uint32_t s_dmaBufferTail = 0;

static i2s_config_t s_i2sConfig = {};
static bool s_i2sDriverInstalled = false;

//=============================================================================
// 静态函数声明
//=============================================================================

static void micTask(void* pvParameters);
static void notifyEvent(mic_state_t state);
static void notifyData(const int32_t* data, uint32_t len);
static bool applyHighPassFilter(int32_t* data, uint32_t len);
static void updateStats(void);
static esp_err_t configureI2SForMode(mic_mode_t mode);

//=============================================================================
// API 实现
//=============================================================================

/**
 * @brief 初始化麦克风驱动
 */
mic_error_t microphone_init(const mic_config_t* config) {
    ESP_LOGI(TAG, "初始化ICS-43434麦克风驱动...");
    
    if (s_initialized) {
        ESP_LOGW(TAG, "麦克风驱动已初始化");
        return MIC_ERR_NONE;
    }
    
    if (config != NULL) {
        memcpy(&s_config, config, sizeof(mic_config_t));
    } else {
        memset(&s_config, 0, sizeof(mic_config_t));
        s_config.mode = MIC_MODE_HPM;
        s_config.sample_rate = MIC_SAMPLE_RATE_HPM;
        s_config.bits_per_sample = MIC_BITS_PER_SAMPLE;
        s_config.channels = MIC_CHANNEL_NUM;
        s_config.buffer_size = MIC_BUFFER_SIZE;
        s_config.enable_noise_gate = true;
        s_config.noise_gate_threshold = 10;
        s_config.enable_high_pass = true;
    }
    
    memset(&s_stateInfo, 0, sizeof(mic_state_info_t));
    s_stateInfo.state = MIC_STATE_INITIALIZED;
    s_stateInfo.sample_rate = s_config.sample_rate;
    s_stateInfo.current_mode = s_config.mode;
    memset(&s_stats, 0, sizeof(mic_stats_t));
    
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "创建互斥锁失败");
        return MIC_ERR_MEMORY_FAILED;
    }
    
    s_micQueue = xQueueCreate(10, sizeof(int32_t) * 256);
    if (s_micQueue == NULL) {
        ESP_LOGE(TAG, "创建音频队列失败");
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
        return MIC_ERR_MEMORY_FAILED;
    }
    
    s_dmaBuffer = (int32_t*)heap_caps_malloc(MIC_BUFFER_SIZE * sizeof(int32_t), MALLOC_CAP_SPIRAM);
    if (s_dmaBuffer == NULL) {
        ESP_LOGE(TAG, "分配DMA缓冲区失败");
        vQueueDelete(s_micQueue);
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
        return MIC_ERR_MEMORY_FAILED;
    }
    
    s_initialized = true;
    ESP_LOGI(TAG, "ICS-43434麦克风驱动初始化完成");
    return MIC_ERR_NONE;
}

/**
 * @brief 反初始化麦克风驱动
 */
void microphone_deinit(void) {
    ESP_LOGI(TAG, "反初始化ICS-43434麦克风驱动...");
    
    if (s_taskRunning) {
        s_taskRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    if (s_i2sDriverInstalled) {
        i2s_driver_uninstall(I2S_NUM_1);
        s_i2sDriverInstalled = false;
    }
    
    if (s_dmaBuffer != NULL) {
        heap_caps_free(s_dmaBuffer);
        s_dmaBuffer = NULL;
    }
    
    if (s_micQueue != NULL) {
        vQueueDelete(s_micQueue);
        s_micQueue = NULL;
    }
    
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_initialized = false;
    ESP_LOGI(TAG, "ICS-43434麦克风驱动反初始化完成");
}

/**
 * @brief 启动麦克风采集
 */
mic_error_t microphone_start(void) {
    if (!s_initialized) {
        return MIC_ERR_NOT_INITIALIZED;
    }
    
    if (s_stateInfo.state == MIC_STATE_RUNNING) {
        ESP_LOGW(TAG, "麦克风已在运行中");
        return MIC_ERR_ALREADY_RUNNING;
    }
    
    ESP_LOGI(TAG, "启动ICS-43434麦克风采集...");
    
    esp_err_t err = configureI2SForMode(s_config.mode);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "配置I2S失败: %d", err);
        return MIC_ERR_HARDWARE_ERROR;
    }
    
    err = i2s_start(I2S_NUM_1);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "启动I2S失败: %d", err);
        return MIC_ERR_HARDWARE_ERROR;
    }
    
    s_stateInfo.state = MIC_STATE_RUNNING;
    s_stateInfo.sample_rate = s_config.sample_rate;
    s_stateInfo.current_mode = s_config.mode;
    
    BaseType_t result = xTaskCreatePinnedToCore(
        micTask,
        "MICTask",
        8192,
        NULL,
        TASK_PRIORITY_HIGH,
        &s_micTask,
        1
    );
    
    if (result != pdPASS) {
        ESP_LOGE(TAG, "创建麦克风任务失败");
        return MIC_ERR_MEMORY_FAILED;
    }
    
    s_taskRunning = true;
    s_lastError = MIC_ERR_NONE;
    
    notifyEvent(MIC_STATE_RUNNING);
    ESP_LOGI(TAG, "ICS-43434麦克风采集已启动");
    return MIC_ERR_NONE;
}

/**
 * @brief 停止麦克风采集
 */
void microphone_stop(void) {
    if (s_stateInfo.state != MIC_STATE_RUNNING && 
        s_stateInfo.state != MIC_STATE_PAUSED) {
        return;
    }
    
    ESP_LOGI(TAG, "停止ICS-43434麦克风采集...");
    
    if (s_taskRunning) {
        s_taskRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    i2s_stop(I2S_NUM_1);
    
    s_stateInfo.state = MIC_STATE_INITIALIZED;
    s_stateInfo.buffer_level = 0;
    
    notifyEvent(MIC_STATE_INITIALIZED);
    ESP_LOGI(TAG, "ICS-43434麦克风采集已停止");
}

/**
 * @brief 暂停麦克风采集
 */
mic_error_t microphone_pause(void) {
    if (s_stateInfo.state != MIC_STATE_RUNNING) {
        return MIC_ERR_NOT_INITIALIZED;
    }
    
    ESP_LOGI(TAG, "暂停ICS-43434麦克风采集...");
    
    i2s_stop(I2S_NUM_1);
    
    s_stateInfo.state = MIC_STATE_PAUSED;
    
    notifyEvent(MIC_STATE_PAUSED);
    ESP_LOGI(TAG, "ICS-43434麦克风采集已暂停");
    return MIC_ERR_NONE;
}

/**
 * @brief 恢复麦克风采集
 */
mic_error_t microphone_resume(void) {
    if (s_stateInfo.state != MIC_STATE_PAUSED) {
        return MIC_ERR_NOT_INITIALIZED;
    }
    
    ESP_LOGI(TAG, "恢复ICS-43434麦克风采集...");
    
    esp_err_t err = i2s_start(I2S_NUM_1);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "启动I2S失败: %d", err);
        return MIC_ERR_HARDWARE_ERROR;
    }
    
    s_stateInfo.state = MIC_STATE_RUNNING;
    
    notifyEvent(MIC_STATE_RUNNING);
    ESP_LOGI(TAG, "ICS-43434麦克风采集已恢复");
    return MIC_ERR_NONE;
}

/**
 * @brief 设置工作模式
 */
mic_error_t microphone_set_mode(mic_mode_t mode) {
    if (!s_initialized) {
        return MIC_ERR_NOT_INITIALIZED;
    }
    
    if (mode < MIC_MODE_HPM || mode > MIC_MODE_SLEEP) {
        return MIC_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    bool was_running = (s_stateInfo.state == MIC_STATE_RUNNING);
    
    if (was_running) {
        i2s_stop(I2S_NUM_1);
    }
    
    s_config.mode = mode;
    
    esp_err_t err = configureI2SForMode(mode);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "配置I2S失败: %d", err);
        xSemaphoreGive(s_mutex);
        return MIC_ERR_HARDWARE_ERROR;
    }
    
    if (was_running) {
        err = i2s_start(I2S_NUM_1);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "启动I2S失败: %d", err);
            xSemaphoreGive(s_mutex);
            return MIC_ERR_HARDWARE_ERROR;
        }
    }
    
    s_stateInfo.current_mode = mode;
    s_stats.mode_switches++;
    
    xSemaphoreGive(s_mutex);
    
    ESP_LOGI(TAG, "工作模式已设置: %d", mode);
    return MIC_ERR_NONE;
}

/**
 * @brief 获取当前状态
 */
mic_state_t microphone_get_state(void) {
    return s_stateInfo.state;
}

/**
 * @brief 获取状态信息
 */
void microphone_get_state_info(mic_state_info_t* info) {
    if (info != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(info, &s_stateInfo, sizeof(mic_state_info_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 获取统计信息
 */
void microphone_get_stats(mic_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(stats, &s_stats, sizeof(mic_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 设置数据回调
 */
void microphone_set_data_callback(mic_data_callback_t callback, void* user_data) {
    s_dataCallback = callback;
    s_userData = user_data;
}

/**
 * @brief 设置事件回调
 */
void microphone_set_event_callback(mic_event_callback_t callback, void* user_data) {
    s_eventCallback = callback;
    s_userData = user_data;
}

/**
 * @brief 获取当前工作模式
 */
mic_mode_t microphone_get_mode(void) {
    return s_config.mode;
}

//=============================================================================
// 静态函数实现
//=============================================================================

/**
 * @brief 麦克风任务
 */
static void micTask(void* pvParameters) {
    (void)pvParameters;
    
    ESP_LOGI(TAG, "ICS-43434麦克风任务启动");
    
    size_t bytes_read = 0;
    
    while (s_taskRunning) {
        esp_err_t err = i2s_read(
            I2S_NUM_1,
            (void*)s_dmaBuffer,
            MIC_DMA_BUF_LEN * sizeof(int32_t),
            &bytes_read,
            portMAX_DELAY
        );
        
        if (err == ESP_OK && bytes_read > 0) {
            int32_t samples = bytes_read / sizeof(int32_t);
            
            if (s_config.enable_high_pass) {
                applyHighPassFilter((int32_t*)s_dmaBuffer, samples);
            }
            
            if (s_dataCallback != NULL) {
                s_dataCallback((int32_t*)s_dmaBuffer, samples, s_userData);
            }
            
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            s_stats.samples_collected += samples;
            s_stateInfo.buffer_level = (s_dmaBufferHead - s_dmaBufferTail + MIC_BUFFER_SIZE) % MIC_BUFFER_SIZE;
            updateStats();
            xSemaphoreGive(s_mutex);
        }
        
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    
    ESP_LOGI(TAG, "ICS-43434麦克风任务结束");
    vTaskDelete(NULL);
}

/**
 * @brief 通知事件
 */
static void notifyEvent(mic_state_t state) {
    if (s_eventCallback != NULL) {
        s_eventCallback(state, s_userData);
    }
}

/**
 * @brief 通知数据
 */
static void notifyData(const int32_t* data, uint32_t len) {
    if (s_dataCallback != NULL) {
        s_dataCallback(data, len, s_userData);
    }
}

/**
 * @brief 应用高通滤波器
 */
static bool applyHighPassFilter(int32_t* data, uint32_t len) {
    static int32_t prev_sample = 0;
    static const float alpha = 0.1f;
    
    for (uint32_t i = 0; i < len; i++) {
        int32_t filtered = (int32_t)(alpha * data[i] + (1.0f - alpha) * prev_sample);
        data[i] = filtered;
        prev_sample = data[i];
    }
    
    return true;
}

/**
 * @brief 更新统计信息
 */
static void updateStats(void) {
    s_stateInfo.total_time_ms = xTaskGetTickCount() / portTICK_PERIOD_MS;
}

/**
 * @brief 根据模式配置I2S
 */
static esp_err_t configureI2SForMode(mic_mode_t mode) {
    uint32_t sample_rate;
    
    switch (mode) {
        case MIC_MODE_HPM:
            sample_rate = MIC_SAMPLE_RATE_HPM;
            break;
        case MIC_MODE_LPM:
            sample_rate = MIC_SAMPLE_RATE_LPM;
            break;
        case MIC_MODE_SLEEP:
            sample_rate = MIC_SAMPLE_RATE_SLEEP;
            break;
        default:
            sample_rate = MIC_SAMPLE_RATE_HPM;
            break;
    }
    
    if (s_i2sDriverInstalled) {
        i2s_driver_uninstall(I2S_NUM_1);
        s_i2sDriverInstalled = false;
    }

    memset(&s_i2sConfig, 0, sizeof(s_i2sConfig));
    s_i2sConfig.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
    s_i2sConfig.sample_rate = sample_rate;
    s_i2sConfig.bits_per_sample = I2S_BITS_PER_SAMPLE_24BIT;
    s_i2sConfig.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    s_i2sConfig.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    s_i2sConfig.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
    s_i2sConfig.dma_buf_count = MIC_DMA_BUF_COUNT;
    s_i2sConfig.dma_buf_len = MIC_DMA_BUF_LEN;
    s_i2sConfig.use_apll = false;
    s_i2sConfig.tx_desc_auto_clear = true;
    s_i2sConfig.fixed_mclk = 0;
    s_i2sConfig.mclk_multiple = I2S_MCLK_MULTIPLE_256;
    s_i2sConfig.bits_per_chan = I2S_BITS_PER_CHAN_DEFAULT;
    
    esp_err_t err = i2s_driver_install(I2S_NUM_1, &s_i2sConfig, 0, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "安装I2S驱动失败: %d", err);
        return err;
    }
    s_i2sDriverInstalled = true;
    
    i2s_pin_config_t pin_config = {};
    pin_config.mck_io_num = I2S_PIN_NO_CHANGE;
    pin_config.bck_io_num = MIC_I2S_SCK_PIN;
    pin_config.ws_io_num = MIC_I2S_WS_PIN;
    pin_config.data_out_num = I2S_PIN_NO_CHANGE;
    pin_config.data_in_num = MIC_I2S_SD_PIN;

    err = i2s_set_pin(I2S_NUM_1, &pin_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "配置I2S麦克风引脚失败: %d", err);
        return err;
    }
    
    return ESP_OK;
}
