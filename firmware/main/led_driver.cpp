/**
 * @file led_driver.cpp
 * @brief LED调光驱动模块实现
 * @details 实现双色温LED的PWM调光驱动，支持亮度、色温调节和预设场景
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#include "led_driver.h"
#include "config.h"
#include <esp_log.h>
#include <driver/gpio.h>
#include <driver/ledc.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

static const char* TAG = "LED_DRV";

//=============================================================================
// 静态变量
//=============================================================================

static led_config_t s_config;
static led_state_info_t s_stateInfo;
static led_stats_t s_stats = {};
static led_error_t s_lastError = LED_ERR_NONE;
static SemaphoreHandle_t s_mutex = NULL;
static led_event_callback_t s_eventCallback = NULL;
static void* s_userData = NULL;

// 平滑过渡任务
static TaskHandle_t s_transitionTask = NULL;
static volatile bool s_transitionRunning = false;

// 目标值（用于平滑过渡）
static uint8_t s_targetBrightness = 0;
static uint16_t s_targetColorTemp = 2700;

//=============================================================================
// 静态函数声明
//=============================================================================

static void calculateDutyCycle(uint8_t brightness, uint16_t color_temp, 
                            uint16_t* cold_duty, uint16_t* warm_duty);
static void applyDutyCycle(uint16_t cold_duty, uint16_t warm_duty);
static void transitionTask(void* pvParameters);
static void notifyEvent(led_state_t state);
static void updateStats(void);

//=============================================================================
// API 实现
//=============================================================================

led_error_t led_init(const led_config_t* config) {
    ESP_LOGI(TAG, "初始化LED驱动...");
    
    // 创建互斥锁
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "创建互斥锁失败");
        return LED_ERR_MEMORY_FAILED;
    }
    
    // 初始化配置
    if (config != NULL) {
        memcpy(&s_config, config, sizeof(led_config_t));
    } else {
        memset(&s_config, 0, sizeof(led_config_t));
        s_config.brightness = 50;
        s_config.color_temp = 4000;
        s_config.scene = LED_SCENE_CUSTOM;
        s_config.smooth_transition = true;
        s_config.transition_time_ms = 500;
    }
    
    // 初始化状态
    memset(&s_stateInfo, 0, sizeof(led_state_info_t));
    s_stateInfo.state = LED_STATE_INITIALIZED;
    s_stateInfo.brightness = s_config.brightness;
    s_stateInfo.color_temp = s_config.color_temp;
    s_stateInfo.scene = s_config.scene;
    
    // 配置LED PWM通道
    ledc_timer_config_t timer_conf = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = (ledc_timer_bit_t)LED_PWM_RESOLUTION,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = LED_PWM_FREQUENCY,
        .clk_cfg = LEDC_AUTO_CLK
    };
    
    esp_err_t err = ledc_timer_config(&timer_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "配置LED定时器失败: %d", err);
        return LED_ERR_HARDWARE_ERROR;
    }
    
    // 配置冷色温通道
    ledc_channel_config_t cold_conf = {
        .gpio_num = LED_PWM_COLD_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = (ledc_channel_t)LED_PWM_COLD_CHANNEL,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
        .hpoint = 0
    };
    
    err = ledc_channel_config(&cold_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "配置冷色温通道失败: %d", err);
        return LED_ERR_HARDWARE_ERROR;
    }
    
    // 配置暖色温通道
    ledc_channel_config_t warm_conf = {
        .gpio_num = LED_PWM_WARM_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = (ledc_channel_t)LED_PWM_WARM_CHANNEL,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
        .hpoint = 0
    };
    
    err = ledc_channel_config(&warm_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "配置暖色温通道失败: %d", err);
        return LED_ERR_HARDWARE_ERROR;
    }
    
    // 初始化GPIO
#if LED_EN_PIN >= 0
    gpio_config_t io_conf = {};
    io_conf.intr_type = GPIO_INTR_DISABLE;
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pin_bit_mask = (1ULL << LED_EN_PIN);
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    gpio_config(&io_conf);
    gpio_set_level(LED_EN_PIN, 0);
#endif
    
    // 计算初始占空比
    uint16_t cold_duty, warm_duty;
    calculateDutyCycle(s_stateInfo.brightness, s_stateInfo.color_temp, 
                     &cold_duty, &warm_duty);
    
    s_stateInfo.cold_duty = cold_duty;
    s_stateInfo.warm_duty = warm_duty;
    
    ESP_LOGI(TAG, "LED驱动初始化完成");
    return LED_ERR_NONE;
}

void led_deinit(void) {
    ESP_LOGI(TAG, "反初始化LED驱动...");
    
    // 停止过渡任务
    if (s_transitionRunning) {
        s_transitionRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    // 关闭LED
    led_off();
    
    // 释放资源
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_stateInfo.state = LED_STATE_UNINITIALIZED;
    ESP_LOGI(TAG, "LED驱动反初始化完成");
}

led_error_t led_start(void) {
    if (s_stateInfo.state == LED_STATE_RUNNING) {
        return LED_ERR_ALREADY_RUNNING;
    }
    
    ESP_LOGI(TAG, "启动LED驱动...");
    
    // 启动LED定时器
    ledc_timer_resume(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0);
    
    // 应用初始占空比
    applyDutyCycle(s_stateInfo.cold_duty, s_stateInfo.warm_duty);
    
    s_stateInfo.state = LED_STATE_RUNNING;
    s_lastError = LED_ERR_NONE;
    
    notifyEvent(LED_STATE_RUNNING);
    ESP_LOGI(TAG, "LED驱动已启动");
    return LED_ERR_NONE;
}

void led_stop(void) {
    if (s_stateInfo.state != LED_STATE_RUNNING) {
        return;
    }
    
    ESP_LOGI(TAG, "停止LED驱动...");
    
    // 停止过渡任务
    if (s_transitionRunning) {
        s_transitionRunning = false;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    // 关闭LED
    led_off();
    
    // 停止LED定时器
    ledc_timer_pause(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0);
    
    s_stateInfo.state = LED_STATE_INITIALIZED;
    notifyEvent(LED_STATE_INITIALIZED);
    
    ESP_LOGI(TAG, "LED驱动已停止");
}

led_error_t led_set_brightness(uint8_t brightness, bool smooth) {
    if (brightness > LED_BRIGHTNESS_MAX) {
        brightness = LED_BRIGHTNESS_MAX;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    if (smooth && s_config.smooth_transition) {
        s_targetBrightness = brightness;
        
        if (!s_transitionRunning) {
            s_transitionRunning = true;
            BaseType_t result = xTaskCreate(
                transitionTask,
                "LEDTransition",
                4096,
                NULL,
                3,
                &s_transitionTask
            );
            
            if (result != pdPASS) {
                ESP_LOGE(TAG, "创建过渡任务失败");
                s_transitionRunning = false;
                xSemaphoreGive(s_mutex);
                return LED_ERR_MEMORY_FAILED;
            }
        }
    } else {
        s_stateInfo.brightness = brightness;
        s_targetBrightness = brightness;
        
        uint16_t cold_duty, warm_duty;
        calculateDutyCycle(brightness, s_stateInfo.color_temp, 
                         &cold_duty, &warm_duty);
        
        s_stateInfo.cold_duty = cold_duty;
        s_stateInfo.warm_duty = warm_duty;
        
        applyDutyCycle(cold_duty, warm_duty);
        updateStats();
    }
    
    xSemaphoreGive(s_mutex);
    return LED_ERR_NONE;
}

led_error_t led_set_color_temp(uint16_t color_temp, bool smooth) {
    if (color_temp < LED_COLOR_TEMP_MIN) {
        color_temp = LED_COLOR_TEMP_MIN;
    } else if (color_temp > LED_COLOR_TEMP_MAX) {
        color_temp = LED_COLOR_TEMP_MAX;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    if (smooth && s_config.smooth_transition) {
        s_targetColorTemp = color_temp;
        
        if (!s_transitionRunning) {
            s_transitionRunning = true;
            BaseType_t result = xTaskCreate(
                transitionTask,
                "LEDTransition",
                4096,
                NULL,
                3,
                &s_transitionTask
            );
            
            if (result != pdPASS) {
                ESP_LOGE(TAG, "创建过渡任务失败");
                s_transitionRunning = false;
                xSemaphoreGive(s_mutex);
                return LED_ERR_MEMORY_FAILED;
            }
        }
    } else {
        s_stateInfo.color_temp = color_temp;
        s_targetColorTemp = color_temp;
        
        uint16_t cold_duty, warm_duty;
        calculateDutyCycle(s_stateInfo.brightness, color_temp, 
                         &cold_duty, &warm_duty);
        
        s_stateInfo.cold_duty = cold_duty;
        s_stateInfo.warm_duty = warm_duty;
        
        applyDutyCycle(cold_duty, warm_duty);
        updateStats();
    }
    
    xSemaphoreGive(s_mutex);
    return LED_ERR_NONE;
}

led_error_t led_set_brightness_color(uint8_t brightness, uint16_t color_temp, bool smooth) {
    if (brightness > LED_BRIGHTNESS_MAX) {
        brightness = LED_BRIGHTNESS_MAX;
    }
    
    if (color_temp < LED_COLOR_TEMP_MIN) {
        color_temp = LED_COLOR_TEMP_MIN;
    } else if (color_temp > LED_COLOR_TEMP_MAX) {
        color_temp = LED_COLOR_TEMP_MAX;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    if (smooth && s_config.smooth_transition) {
        s_targetBrightness = brightness;
        s_targetColorTemp = color_temp;
        
        if (!s_transitionRunning) {
            s_transitionRunning = true;
            BaseType_t result = xTaskCreate(
                transitionTask,
                "LEDTransition",
                4096,
                NULL,
                3,
                &s_transitionTask
            );
            
            if (result != pdPASS) {
                ESP_LOGE(TAG, "创建过渡任务失败");
                s_transitionRunning = false;
                xSemaphoreGive(s_mutex);
                return LED_ERR_MEMORY_FAILED;
            }
        }
    } else {
        s_stateInfo.brightness = brightness;
        s_stateInfo.color_temp = color_temp;
        s_targetBrightness = brightness;
        s_targetColorTemp = color_temp;
        
        uint16_t cold_duty, warm_duty;
        calculateDutyCycle(brightness, color_temp, &cold_duty, &warm_duty);
        
        s_stateInfo.cold_duty = cold_duty;
        s_stateInfo.warm_duty = warm_duty;
        
        applyDutyCycle(cold_duty, warm_duty);
        updateStats();
    }
    
    xSemaphoreGive(s_mutex);
    return LED_ERR_NONE;
}

led_error_t led_set_scene(led_scene_t scene) {
    uint8_t brightness;
    uint16_t color_temp;
    
    switch (scene) {
        case LED_SCENE_READING:
            brightness = 70;
            color_temp = 4500;
            break;
            
        case LED_SCENE_SLEEP:
            brightness = 10;
            color_temp = 2700;
            break;
            
        case LED_SCENE_RELAX:
            brightness = 40;
            color_temp = 3000;
            break;
            
        case LED_SCENE_WORK:
            brightness = 90;
            color_temp = 6000;
            break;
            
        case LED_SCENE_OFF:
            return led_off();
            
        case LED_SCENE_CUSTOM:
        default:
            return LED_ERR_INVALID_PARAM;
    }
    
    s_stateInfo.scene = scene;
    s_stats.scene_changes++;
    
    return led_set_brightness_color(brightness, color_temp, true);
}

led_error_t led_on(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
#if LED_EN_PIN >= 0
    gpio_set_level(LED_EN_PIN, 1);
#endif
    s_config.enabled = true;
    
    xSemaphoreGive(s_mutex);
    return LED_ERR_NONE;
}

led_error_t led_off(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
#if LED_EN_PIN >= 0
    gpio_set_level(LED_EN_PIN, 0);
#endif
    s_config.enabled = false;
    
    // 关闭PWM输出
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1);
    
    xSemaphoreGive(s_mutex);
    return LED_ERR_NONE;
}

led_error_t led_toggle(void) {
    if (s_config.enabled) {
        return led_off();
    } else {
        return led_on();
    }
}

uint8_t led_get_brightness(void) {
    return s_stateInfo.brightness;
}

uint16_t led_get_color_temp(void) {
    return s_stateInfo.color_temp;
}

led_scene_t led_get_scene(void) {
    return s_stateInfo.scene;
}

bool led_is_on(void) {
    return s_config.enabled;
}

led_state_t led_get_state(void) {
    return s_stateInfo.state;
}

void led_get_state_info(led_state_info_t* info) {
    if (info != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(info, &s_stateInfo, sizeof(led_state_info_t));
        xSemaphoreGive(s_mutex);
    }
}

void led_get_stats(led_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(stats, &s_stats, sizeof(led_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

void led_clear_stats(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memset(&s_stats, 0, sizeof(led_stats_t));
    xSemaphoreGive(s_mutex);
}

led_error_t led_set_config(const led_config_t* config) {
    if (config == NULL) {
        return LED_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memcpy(&s_config, config, sizeof(led_config_t));
    xSemaphoreGive(s_mutex);
    
    return LED_ERR_NONE;
}

void led_get_config(led_config_t* config) {
    if (config != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(config, &s_config, sizeof(led_config_t));
        xSemaphoreGive(s_mutex);
    }
}

void led_set_event_callback(led_event_callback_t callback, void* user_data) {
    s_eventCallback = callback;
    s_userData = user_data;
}

led_error_t led_get_last_error(void) {
    return s_lastError;
}

//=============================================================================
// 静态函数实现
//=============================================================================

static void calculateDutyCycle(uint8_t brightness, uint16_t color_temp, 
                            uint16_t* cold_duty, uint16_t* warm_duty) {
    // 计算总占空比（基于亮度）
    uint16_t max_duty = (1 << LED_PWM_RESOLUTION) - 1;
    uint16_t total_duty = (brightness * max_duty) / 100;
    
    // 计算冷暖比例（基于色温）
    // 2700K = 100% 暖光, 6500K = 100% 冷光
    float warm_ratio = (float)(LED_COLOR_TEMP_MAX - color_temp) / 
                      (LED_COLOR_TEMP_MAX - LED_COLOR_TEMP_MIN);
    float cold_ratio = 1.0f - warm_ratio;
    
    // 计算各通道占空比
    *warm_duty = (uint16_t)(total_duty * warm_ratio);
    *cold_duty = (uint16_t)(total_duty * cold_ratio);
}

static void applyDutyCycle(uint16_t cold_duty, uint16_t warm_duty) {
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, cold_duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1, warm_duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1);
}

static void transitionTask(void* pvParameters) {
    (void)pvParameters;
    
    uint8_t start_brightness = s_stateInfo.brightness;
    uint16_t start_color_temp = s_stateInfo.color_temp;
    
    int brightness_step = (s_targetBrightness - start_brightness) / 10;
    int color_temp_step = (s_targetColorTemp - start_color_temp) / 10;
    
    for (int i = 0; i < 10 && s_transitionRunning; i++) {
        uint8_t current_brightness = start_brightness + brightness_step * i;
        uint16_t current_color_temp = start_color_temp + color_temp_step * i;
        
        uint16_t cold_duty, warm_duty;
        calculateDutyCycle(current_brightness, current_color_temp, 
                         &cold_duty, &warm_duty);
        
        applyDutyCycle(cold_duty, warm_duty);
        
        vTaskDelay(pdMS_TO_TICKS(s_config.transition_time_ms / 10));
    }
    
    if (s_transitionRunning) {
        uint16_t cold_duty, warm_duty;
        calculateDutyCycle(s_targetBrightness, s_targetColorTemp, 
                         &cold_duty, &warm_duty);
        
        applyDutyCycle(cold_duty, warm_duty);
        
        s_stateInfo.brightness = s_targetBrightness;
        s_stateInfo.color_temp = s_targetColorTemp;
        s_stateInfo.cold_duty = cold_duty;
        s_stateInfo.warm_duty = warm_duty;
        
        updateStats();
    }
    
    s_transitionRunning = false;
    vTaskDelete(NULL);
}

static void notifyEvent(led_state_t state) {
    if (s_eventCallback != NULL) {
        s_eventCallback(state, s_userData);
    }
}

static void updateStats(void) {
    s_stats.brightness_changes++;
    s_stats.color_temp_changes++;
    
    if (s_config.enabled) {
        s_stats.total_on_time_ms += 100;
    }
}
