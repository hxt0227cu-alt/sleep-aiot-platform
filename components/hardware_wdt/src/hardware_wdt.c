/**
 * @file hardware_wdt.c
 * @brief 硬件看门狗组件实现
 */

#include "hardware_wdt.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>

static const char *TAG = "hw_wdt";

typedef struct {
    TaskHandle_t handle;
    char name[configMAX_TASK_NAME_LEN];
    bool registered;
} wdt_task_t;

static wdt_task_t s_tasks[WDT_MAX_TASKS];
static bool s_initialized = false;
static uint32_t s_timeout = WDT_DEFAULT_TIMEOUT_SEC;

esp_err_t hardware_wdt_init(uint32_t timeout_seconds)
{
    if (s_initialized) return ESP_OK;
    ESP_LOGI(TAG, "初始化硬件看门狗, 超时: %lus", timeout_seconds);

    esp_task_wdt_config_t config = {
        .timeout_ms = timeout_seconds * 1000,
        .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
        .trigger_panic = true,
    };

    esp_err_t ret = esp_task_wdt_init(&config);
    if (ret != ESP_OK) return ret;

    esp_task_wdt_add(NULL);
    memset(s_tasks, 0, sizeof(s_tasks));
    s_initialized = true;
    s_timeout = timeout_seconds;
    return ESP_OK;
}

esp_err_t hardware_wdt_register_task(const char *task_name)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    for (int i = 0; i < WDT_MAX_TASKS; i++) {
        if (!s_tasks[i].registered) {
            s_tasks[i].handle = xTaskGetCurrentTaskHandle();
            strncpy(s_tasks[i].name, task_name, configMAX_TASK_NAME_LEN - 1);
            s_tasks[i].registered = true;
            esp_err_t ret = esp_task_wdt_add(s_tasks[i].handle);
            if (ret != ESP_OK) {
                s_tasks[i].registered = false;
                return ret;
            }
            ESP_LOGI(TAG, "任务 '%s' 已注册", task_name);
            return ESP_OK;
        }
    }
    return ESP_ERR_NO_MEM;
}

esp_err_t hardware_wdt_feed(void)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    return esp_task_wdt_reset();
}

esp_err_t hardware_wdt_unregister_task(void)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    TaskHandle_t current = xTaskGetCurrentTaskHandle();
    for (int i = 0; i < WDT_MAX_TASKS; i++) {
        if (s_tasks[i].registered && s_tasks[i].handle == current) {
            esp_task_wdt_delete(s_tasks[i].handle);
            s_tasks[i].registered = false;
            return ESP_OK;
        }
    }
    return ESP_ERR_NOT_FOUND;
}

void hardware_wdt_get_status(hardware_wdt_status_t *status)
{
    if (!status) return;
    status->initialized = s_initialized;
    status->timeout_seconds = s_timeout;
    status->registered_tasks = 0;
    for (int i = 0; i < WDT_MAX_TASKS; i++) {
        if (s_tasks[i].registered) status->registered_tasks++;
    }
}
