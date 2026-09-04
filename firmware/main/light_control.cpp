/**
 * @file light_control.cpp
 * @brief 灯光控制服务实现
 * @details 实现PWM调光、色温控制、渐变效果和光闹钟管理
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 */

#include "light_control.h"
#include "config.h"
#include <esp_log.h>
#include <driver/ledc.h>
#include <driver/gpio.h>
#include <string.h>
#include <time.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/timers.h>

static const char* TAG = "LIGHT_CTRL";

//=============================================================================
// 静态变量
//=============================================================================

static light_config_t s_config = {};
static light_state_t s_state = LIGHT_STATE_OFF;
static light_stats_t s_stats = {};
static light_alarm_config_t s_alarms[LIGHT_MAX_TIMERS] = {};
static light_alarm_status_t s_alarmStatus[LIGHT_MAX_TIMERS] = {};
static SemaphoreHandle_t s_mutex = NULL;
static TimerHandle_t s_alarmTimers[LIGHT_MAX_TIMERS] = {NULL};
static light_event_callback_t s_eventCallback = NULL;
static void* s_userData = NULL;

static bool s_initialized = false;
static bool s_fading = false;
static uint8_t s_targetBrightness = 0;
static uint16_t s_targetColorTemp = 0;
static uint32_t s_fadeStartTime = 0;
static uint32_t s_fadeDuration = 0;
static uint8_t s_startBrightness = 0;
static uint16_t s_startColorTemp = 0;

//=============================================================================
// 静态函数声明
//=============================================================================

static void updatePWM(void);
static void colorTempToRatio(uint16_t color_temp, uint8_t brightness, uint32_t* cold_duty, uint32_t* warm_duty);
static void alarmTimerCallback(TimerHandle_t xTimer);
static void notifyEvent(int event, void* data);
static void fadeTask(void* pvParameters);

//=============================================================================
// API 实现
//=============================================================================

/**
 * @brief 初始化灯光控制服务
 */
light_error_t light_control_init(void) {
    ESP_LOGI(TAG, "初始化灯光控制服务...");
    
    if (s_initialized) {
        ESP_LOGW(TAG, "灯光控制已初始化");
        return LIGHT_ERR_NONE;
    }
    
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "创建互斥锁失败");
        return LIGHT_ERR_PWM_FAILED;
    }
    
    ledc_timer_config_t timer_conf = {};
    timer_conf.speed_mode = LEDC_LOW_SPEED_MODE;
    timer_conf.duty_resolution = LEDC_TIMER_10_BIT;
    timer_conf.timer_num = LEDC_TIMER_0;
    timer_conf.freq_hz = LED_PWM_FREQUENCY;
    timer_conf.clk_cfg = LEDC_AUTO_CLK;
    
    esp_err_t err = ledc_timer_config(&timer_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "配置LEDC定时器失败: %d", err);
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
        return LIGHT_ERR_PWM_FAILED;
    }
    
    ledc_channel_config_t cold_channel_conf = {};
    cold_channel_conf.gpio_num = LED_PWM_COLD_PIN;
    cold_channel_conf.speed_mode = LEDC_LOW_SPEED_MODE;
    cold_channel_conf.channel = (ledc_channel_t)LED_PWM_COLD_CHANNEL;
    cold_channel_conf.intr_type = LEDC_INTR_DISABLE;
    cold_channel_conf.timer_sel = LEDC_TIMER_0;
    cold_channel_conf.duty = 0;
    cold_channel_conf.hpoint = 0;
    
    err = ledc_channel_config(&cold_channel_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "配置冷色温通道失败: %d", err);
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
        return LIGHT_ERR_PWM_FAILED;
    }
    
    ledc_channel_config_t warm_channel_conf = {};
    warm_channel_conf.gpio_num = LED_PWM_WARM_PIN;
    warm_channel_conf.speed_mode = LEDC_LOW_SPEED_MODE;
    warm_channel_conf.channel = (ledc_channel_t)LED_PWM_WARM_CHANNEL;
    warm_channel_conf.intr_type = LEDC_INTR_DISABLE;
    warm_channel_conf.timer_sel = LEDC_TIMER_0;
    warm_channel_conf.duty = 0;
    warm_channel_conf.hpoint = 0;
    
    err = ledc_channel_config(&warm_channel_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "配置暖色温通道失败: %d", err);
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
        return LIGHT_ERR_PWM_FAILED;
    }
    
#if LED_EN_PIN >= 0
    gpio_config_t io_conf = {};
    io_conf.pin_bit_mask = (1ULL << LED_EN_PIN);
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.intr_type = GPIO_INTR_DISABLE;
    gpio_config(&io_conf);
    gpio_set_level(LED_EN_PIN, 0);
#endif
    
    memset(&s_config, 0, sizeof(light_config_t));
    s_config.brightness = 50;
    s_config.color_temp = 4000;
    s_config.power = false;
    
    memset(&s_stats, 0, sizeof(s_stats));
    memset(s_alarms, 0, sizeof(s_alarms));
    memset(s_alarmStatus, 0, sizeof(s_alarmStatus));
    
    s_initialized = true;
    s_state = LIGHT_STATE_OFF;
    
    ESP_LOGI(TAG, "灯光控制服务初始化完成");
    return LIGHT_ERR_NONE;
}

/**
 * @brief 反初始化灯光控制服务
 */
void light_control_deinit(void) {
    ESP_LOGI(TAG, "反初始化灯光控制服务...");
    
    if (!s_initialized) {
        return;
    }
    
    light_control_off();
    
    for (int i = 0; i < LIGHT_MAX_TIMERS; i++) {
        if (s_alarmTimers[i] != NULL) {
            xTimerDelete(s_alarmTimers[i], portMAX_DELAY);
            s_alarmTimers[i] = NULL;
        }
    }
    
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_initialized = false;
    ESP_LOGI(TAG, "灯光控制服务反初始化完成");
}

/**
 * @brief 开启灯光
 */
light_error_t light_control_on(void) {
    if (!s_initialized) {
        return LIGHT_ERR_NOT_INITIALIZED;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    s_config.power = true;
    s_state = LIGHT_STATE_ON;
    s_stats.last_change_time = xTaskGetTickCount() / 1000;
    
#if LED_EN_PIN >= 0
    gpio_set_level(LED_EN_PIN, 1);
#endif
    updatePWM();
    
    xSemaphoreGive(s_mutex);
    
    ESP_LOGI(TAG, "灯光已开启");
    return LIGHT_ERR_NONE;
}

/**
 * @brief 关闭灯光
 */
light_error_t light_control_off(void) {
    if (!s_initialized) {
        return LIGHT_ERR_NOT_INITIALIZED;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    s_config.power = false;
    s_state = LIGHT_STATE_OFF;
    s_stats.last_change_time = xTaskGetTickCount() / 1000;
    
#if LED_EN_PIN >= 0
    gpio_set_level(LED_EN_PIN, 0);
#endif
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)LED_PWM_COLD_CHANNEL, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)LED_PWM_COLD_CHANNEL);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)LED_PWM_WARM_CHANNEL, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)LED_PWM_WARM_CHANNEL);
    
    xSemaphoreGive(s_mutex);
    
    ESP_LOGI(TAG, "灯光已关闭");
    return LIGHT_ERR_NONE;
}

/**
 * @brief 设置亮度
 */
light_error_t light_control_set_brightness(uint8_t brightness) {
    if (!s_initialized) {
        return LIGHT_ERR_NOT_INITIALIZED;
    }
    
    if (brightness > 100) {
        return LIGHT_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    s_config.brightness = brightness;
    s_stats.last_change_time = xTaskGetTickCount() / 1000;
    
    if (s_config.power) {
        updatePWM();
    }
    
    xSemaphoreGive(s_mutex);
    
    ESP_LOGD(TAG, "亮度设置为: %d%%", brightness);
    return LIGHT_ERR_NONE;
}

/**
 * @brief 设置色温
 */
light_error_t light_control_set_color_temp(uint16_t color_temp) {
    if (!s_initialized) {
        return LIGHT_ERR_NOT_INITIALIZED;
    }
    
    if (color_temp < LED_COLOR_TEMP_MIN || color_temp > LED_COLOR_TEMP_MAX) {
        return LIGHT_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    s_config.color_temp = color_temp;
    s_stats.last_change_time = xTaskGetTickCount() / 1000;
    
    if (s_config.power) {
        updatePWM();
    }
    
    xSemaphoreGive(s_mutex);
    
    ESP_LOGD(TAG, "色温设置为: %dK", color_temp);
    return LIGHT_ERR_NONE;
}

/**
 * @brief 设置亮度和色温
 */
light_error_t light_control_set_brightness_color(uint8_t brightness, uint16_t color_temp) {
    if (!s_initialized) {
        return LIGHT_ERR_NOT_INITIALIZED;
    }
    
    if (brightness > 100) {
        return LIGHT_ERR_INVALID_PARAM;
    }
    
    if (color_temp < LED_COLOR_TEMP_MIN || color_temp > LED_COLOR_TEMP_MAX) {
        return LIGHT_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    s_config.brightness = brightness;
    s_config.color_temp = color_temp;
    s_stats.last_change_time = xTaskGetTickCount() / 1000;
    
    if (s_config.power) {
        updatePWM();
    }
    
    xSemaphoreGive(s_mutex);
    
    ESP_LOGD(TAG, "亮度: %d%%, 色温: %dK", brightness, color_temp);
    return LIGHT_ERR_NONE;
}

/**
 * @brief 渐变到目标状态
 */
light_error_t light_control_fade_to(uint8_t brightness, uint16_t color_temp, uint32_t duration_ms) {
    if (!s_initialized) {
        return LIGHT_ERR_NOT_INITIALIZED;
    }
    
    if (brightness > 100) {
        return LIGHT_ERR_INVALID_PARAM;
    }
    
    if (color_temp < LED_COLOR_TEMP_MIN || color_temp > LED_COLOR_TEMP_MAX) {
        return LIGHT_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    s_startBrightness = s_config.brightness;
    s_startColorTemp = s_config.color_temp;
    s_targetBrightness = brightness;
    s_targetColorTemp = color_temp;
    s_fadeDuration = duration_ms;
    s_fadeStartTime = xTaskGetTickCount();
    s_fading = true;
    s_state = LIGHT_STATE_FADING;
    
    xSemaphoreGive(s_mutex);
    
    TaskHandle_t fadeTaskHandle;
    xTaskCreatePinnedToCore(fadeTask, "FadeTask", 4096, NULL, TASK_PRIORITY_NORMAL, &fadeTaskHandle, 1);
    
    ESP_LOGI(TAG, "开始渐变: 亮度 %d->%d, 色温 %dK->%dK, 时长 %lu ms", 
             s_startBrightness, brightness, s_startColorTemp, color_temp, (unsigned long)duration_ms);
    
    return LIGHT_ERR_NONE;
}

/**
 * @brief 获取当前状态
 */
light_state_t light_control_get_state(void) {
    return s_state;
}

/**
 * @brief 获取当前配置
 */
void light_control_get_config(light_config_t* config) {
    if (config != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(config, &s_config, sizeof(light_config_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 添加光闹钟
 */
int light_control_add_alarm(const light_alarm_config_t* config) {
    if (!s_initialized || config == NULL) {
        return -1;
    }
    
    if (config->hour > 23 || config->minute > 59) {
        return -1;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    int alarm_id = -1;
    for (int i = 0; i < LIGHT_MAX_TIMERS; i++) {
        if (!s_alarms[i].enabled) {
            memcpy(&s_alarms[i], config, sizeof(light_alarm_config_t));
            s_alarmStatus[i].state = LIGHT_ALARM_IDLE;
            
            char timer_name[32];
            snprintf(timer_name, sizeof(timer_name), "AlarmTimer%d", i);
            s_alarmTimers[i] = xTimerCreate(timer_name, pdMS_TO_TICKS(1000), pdTRUE, (void*)(intptr_t)i, alarmTimerCallback);
            
            if (s_alarmTimers[i] != NULL) {
                xTimerStart(s_alarmTimers[i], portMAX_DELAY);
                alarm_id = i;
                ESP_LOGI(TAG, "添加光闹钟成功: ID=%d, %02d:%02d", i, config->hour, config->minute);
            }
            break;
        }
    }
    
    xSemaphoreGive(s_mutex);
    return alarm_id;
}

/**
 * @brief 删除光闹钟
 */
light_error_t light_control_remove_alarm(int alarm_id) {
    if (!s_initialized || alarm_id < 0 || alarm_id >= LIGHT_MAX_TIMERS) {
        return LIGHT_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    if (s_alarmTimers[alarm_id] != NULL) {
        xTimerStop(s_alarmTimers[alarm_id], portMAX_DELAY);
        xTimerDelete(s_alarmTimers[alarm_id], portMAX_DELAY);
        s_alarmTimers[alarm_id] = NULL;
    }
    
    memset(&s_alarms[alarm_id], 0, sizeof(light_alarm_config_t));
    memset(&s_alarmStatus[alarm_id], 0, sizeof(light_alarm_status_t));
    
    xSemaphoreGive(s_mutex);
    
    ESP_LOGI(TAG, "删除光闹钟: ID=%d", alarm_id);
    return LIGHT_ERR_NONE;
}

/**
 * @brief 启用/禁用光闹钟
 */
light_error_t light_control_enable_alarm(int alarm_id, bool enabled) {
    if (!s_initialized || alarm_id < 0 || alarm_id >= LIGHT_MAX_TIMERS) {
        return LIGHT_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    s_alarms[alarm_id].enabled = enabled;
    
    if (enabled && s_alarmTimers[alarm_id] != NULL) {
        xTimerStart(s_alarmTimers[alarm_id], portMAX_DELAY);
    } else if (!enabled && s_alarmTimers[alarm_id] != NULL) {
        xTimerStop(s_alarmTimers[alarm_id], portMAX_DELAY);
    }
    
    xSemaphoreGive(s_mutex);
    
    ESP_LOGI(TAG, "光闹钟 %s: ID=%d", enabled ? "启用" : "禁用", alarm_id);
    return (LIGHT_ERR_NONE);
}

/**
 * @brief 获取光闹钟状态
 */
light_error_t light_control_get_alarm_status(int alarm_id, light_alarm_status_t* status) {
    if (!s_initialized || alarm_id < 0 || alarm_id >= LIGHT_MAX_TIMERS || status == NULL) {
        return LIGHT_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memcpy(status, &s_alarmStatus[alarm_id], sizeof(light_alarm_status_t));
    xSemaphoreGive(s_mutex);
    
    return LIGHT_ERR_NONE;
}

/**
 * @brief 获取统计信息
 */
void light_control_get_stats(light_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(stats, &s_stats, sizeof(light_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

/**
 * @brief 设置事件回调

 */
void light_control_set_event_callback(light_event_callback_t callback, void* user_data) {
    s_eventCallback = callback;
    s_userData = user_data;
}

//=============================================================================
// 静态函数实现
//=============================================================================

/**
 * @brief 更新PWM输出
 */
static void updatePWM(void) {
    uint32_t cold_duty, warm_duty;
    colorTempToRatio(s_config.color_temp, s_config.brightness, &cold_duty, &warm_duty);
    
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)LED_PWM_COLD_CHANNEL, cold_duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)LED_PWM_COLD_CHANNEL);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)LED_PWM_WARM_CHANNEL, warm_duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)LED_PWM_WARM_CHANNEL);
}

/**
 * @brief 色温转换为冷暖PWM占空比
 */
static void colorTempToRatio(uint16_t color_temp, uint8_t brightness, uint32_t* cold_duty, uint32_t* warm_duty) {
    float ratio = (float)(color_temp - LED_COLOR_TEMP_MIN) / (LED_COLOR_TEMP_MAX - LED_COLOR_TEMP_MIN);
    
    uint32_t max_duty = (1 << LED_PWM_RESOLUTION) - 1;
    uint32_t brightness_duty = (max_duty * brightness) / 100;
    
    *cold_duty = (uint32_t)(brightness_duty * ratio);
    *warm_duty = (uint32_t)(brightness_duty * (1.0f - ratio));
}

/**
 * @brief 光闹钟定时器回调
 */
static void alarmTimerCallback(TimerHandle_t xTimer) {
    int alarm_id = (int)(intptr_t)pvTimerGetTimerID(xTimer);
    
    if (alarm_id < 0 || alarm_id >= LIGHT_MAX_TIMERS) {
        return;
    }
    
    time_t now;
    time(&now);
    struct tm* timeinfo = localtime(&now);
    
    if (s_alarms[alarm_id].enabled && 
        timeinfo->tm_hour == s_alarms[alarm_id].hour && 
        timeinfo->tm_min == s_alarms[alarm_id].minute) {
        
        if (s_alarmStatus[alarm_id].state != LIGHT_ALARM_RUNNING) {
            s_alarmStatus[alarm_id].state = LIGHT_ALARM_RUNNING;
            s_alarmStatus[alarm_id].start_time = xTaskGetTickCount() / 1000;
            
            light_control_fade_to(
                s_alarms[alarm_id].target_brightness,
                s_alarms[alarm_id].target_color_temp,
                s_alarms[alarm_id].duration * 60 * 1000
            );
            
            s_stats.alarm_triggered_count++;
            ESP_LOGI(TAG, "光闹钟触发: ID=%d", alarm_id);
            
            notifyEvent(1, (void*)(intptr_t)alarm_id);
        }
    }
}

/**
 * @brief 通知事件
 */
static void notifyEvent(int event, void* data) {
    if (s_eventCallback != NULL) {
        s_eventCallback(event, data, s_userData);
    }
}

/**
 * @brief 渐变任务
 */
static void fadeTask(void* pvParameters) {
    (void)pvParameters;
    
    uint32_t start_time = xTaskGetTickCount();
    
    while (s_fading) {
        uint32_t elapsed = xTaskGetTickCount() - start_time;
        
        if (elapsed >= s_fadeDuration) {
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            s_config.brightness = s_targetBrightness;
            s_config.color_temp = s_targetColorTemp;
            s_fading = false;
            s_state = LIGHT_STATE_ON;
            updatePWM();
            xSemaphoreGive(s_mutex);
            
            s_stats.fade_count++;
            ESP_LOGI(TAG, "渐变完成");
            break;
        }
        
        float progress = (float)elapsed / s_fadeDuration;
        
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_config.brightness = s_startBrightness + (s_targetBrightness - s_startBrightness) * progress;
        s_config.color_temp = s_startColorTemp + (s_targetColorTemp - s_startColorTemp) * progress;
        updatePWM();
        xSemaphoreGive(s_mutex);
        
        vTaskDelay(pdMS_TO_TICKS(LIGHT_FADE_STEP_MS));
    }
    
    vTaskDelete(NULL);
}
