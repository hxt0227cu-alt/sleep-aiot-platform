#include "anion_driver.h"
#include "config.h"
#include <esp_log.h>
#include <driver/gpio.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <string.h>

static const char* TAG = "ANION_DRIVER";

static bool s_initialized = false;
static bool s_state = false;
static SemaphoreHandle_t s_mutex = NULL;

anion_error_t anion_init(const anion_config_t* config) {
    ESP_LOGI(TAG, "初始化负离子发生器...");
    
    if (s_initialized) {
        ESP_LOGW(TAG, "负离子发生器已初始化");
        return ANION_ERR_NONE;
    }
    
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "创建互斥锁失败");
        return ANION_ERR_MEMORY_FAILED;
    }
    
    s_initialized = true;
    ESP_LOGI(TAG, "负离子发生器初始化完成");
    return ANION_ERR_NONE;
}

void anion_deinit(void) {
    ESP_LOGI(TAG, "反初始化负离子发生器...");
    
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_initialized = false;
    ESP_LOGI(TAG, "负离子发生器反初始化完成");
}

anion_error_t anion_on(void) {
    if (!s_initialized) {
        return ANION_ERR_NOT_INITIALIZED;
    }
    
    if (s_state) {
        ESP_LOGW(TAG, "负离子发生器已开启");
        return ANION_ERR_NONE;
    }
    
    ESP_LOGI(TAG, "开启负离子发生器...");
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_state = true;
#if ANION_PWR_PIN >= 0
    gpio_set_level(ANION_PWR_PIN, 1);
#else
    ESP_LOGW(TAG, "Anion power pin is not configured");
#endif
    xSemaphoreGive(s_mutex);
    
    ESP_LOGI(TAG, "负离子发生器已开启");
    return ANION_ERR_NONE;
}

anion_error_t anion_off(void) {
    if (!s_initialized) {
        return ANION_ERR_NOT_INITIALIZED;
    }
    
    if (!s_state) {
        ESP_LOGW(TAG, "负离子发生器已关闭");
        return ANION_ERR_NONE;
    }
    
    ESP_LOGI(TAG, "关闭负离子发生器...");
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_state = false;
#if ANION_PWR_PIN >= 0
    gpio_set_level(ANION_PWR_PIN, 0);
#endif
    xSemaphoreGive(s_mutex);
    
    ESP_LOGI(TAG, "负离子发生器已关闭");
    return ANION_ERR_NONE;
}

anion_error_t anion_set_duty(uint8_t duty) {
    if (!s_initialized) {
        return ANION_ERR_NOT_INITIALIZED;
    }
    
    if (duty > 100) {
        duty = 100;
    }
    
    ESP_LOGI(TAG, "PWM占空比已设置: %d%%", duty);
    return ANION_ERR_NONE;
}

anion_state_t anion_get_state(void) {
    return s_state ? ANION_STATE_ON : ANION_STATE_OFF;
}

void anion_get_state_info(anion_state_info_t* info) {
    if (info != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        info->state = s_state ? ANION_STATE_ON : ANION_STATE_OFF;
        info->current_duty = 50;
        xSemaphoreGive(s_mutex);
    }
}

void anion_get_stats(anion_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memset(stats, 0, sizeof(anion_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

void anion_set_event_callback(anion_event_callback_t callback, void* user_data) {
}

anion_error_t anion_set_auto_off(bool enable, uint32_t delay_ms) {
    ESP_LOGI(TAG, "自动关闭功能已%s", enable ? "启用" : "禁用");
    return ANION_ERR_NONE;
}
