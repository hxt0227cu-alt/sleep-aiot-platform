/**
 * 硬件看门狗驱动
 *
 * 功能：
 *   基于 ESP32-S3 硬件定时器实现看门狗，
 *   检测系统死锁并自动复位。
 *
 * 安全特性：
 *   - 不可被应用层禁用（生产环境）
 *   - 超时时间可配置（默认 30 秒）
 *   - 支持任务级喂狗（每个关键任务独立喂狗）
 *   - 复位前记录崩溃信息到 Core Dump
 */

#include "esp_log.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>

static const char *TAG = "hardware_wdt";

#define WDT_TIMEOUT_SECONDS 30
#define WDT_MAX_TASKS 16

typedef struct {
    TaskHandle_t task_handle;
    char task_name[configMAX_TASK_NAME_LEN];
    bool registered;
    uint32_t last_feed_time;
    uint32_t feed_count;
} wdt_task_entry_t;

static wdt_task_entry_t s_tasks[WDT_MAX_TASKS];
static bool s_initialized = false;
static esp_task_wdt_config_t s_wdt_config;

/**
 * 初始化硬件看门狗
 */
extern "C" esp_err_t hardware_wdt_init(uint32_t timeout_seconds)
{
    if (s_initialized) {
        ESP_LOGW(TAG, "看门狗已初始化");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "初始化硬件看门狗，超时: %lu 秒", (unsigned long)timeout_seconds);

    s_wdt_config.timeout_ms = timeout_seconds * 1000;
    s_wdt_config.idle_core_mask = (1 << portNUM_PROCESSORS) - 1;
    s_wdt_config.trigger_panic = true;  // 超时触发 panic（记录 Core Dump）

    esp_err_t ret = esp_task_wdt_init(&s_wdt_config);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "看门狗初始化失败: %s", esp_err_to_name(ret));
        return ret;
    }

    // 注册 IDLE 任务
    ret = esp_task_wdt_add(NULL);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "注册 IDLE 任务失败: %s", esp_err_to_name(ret));
        return ret;
    }

    memset(s_tasks, 0, sizeof(s_tasks));
    s_initialized = true;

    ESP_LOGI(TAG, "硬件看门狗初始化完成");
    return ESP_OK;
}

/**
 * 注册任务到看门狗
 */
extern "C" esp_err_t hardware_wdt_register_task(const char *task_name)
{
    if (!s_initialized) {
        ESP_LOGE(TAG, "看门狗未初始化");
        return ESP_ERR_INVALID_STATE;
    }

    // 查找空闲槽位
    for (int i = 0; i < WDT_MAX_TASKS; i++) {
        if (!s_tasks[i].registered) {
            s_tasks[i].task_handle = xTaskGetCurrentTaskHandle();
            strncpy(s_tasks[i].task_name, task_name, configMAX_TASK_NAME_LEN - 1);
            s_tasks[i].registered = true;
            s_tasks[i].last_feed_time = xTaskGetTickCount();
            s_tasks[i].feed_count = 0;

            esp_err_t ret = esp_task_wdt_add(s_tasks[i].task_handle);
            if (ret != ESP_OK) {
                ESP_LOGE(TAG, "注册任务 %s 失败: %s", task_name, esp_err_to_name(ret));
                s_tasks[i].registered = false;
                return ret;
            }

            ESP_LOGI(TAG, "任务 %s 已注册到看门狗", task_name);
            return ESP_OK;
        }
    }

    ESP_LOGE(TAG, "看门狗任务槽位已满");
    return ESP_ERR_NO_MEM;
}

/**
 * 喂狗（任务级）
 */
extern "C" esp_err_t hardware_wdt_feed(void)
{
    if (!s_initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    TaskHandle_t current = xTaskGetCurrentTaskHandle();

    for (int i = 0; i < WDT_MAX_TASKS; i++) {
        if (s_tasks[i].registered && s_tasks[i].task_handle == current) {
            esp_err_t ret = esp_task_wdt_reset();
            if (ret == ESP_OK) {
                s_tasks[i].last_feed_time = xTaskGetTickCount();
                s_tasks[i].feed_count++;
            }
            return ret;
        }
    }

    // 当前任务未注册，返回错误
    return ESP_ERR_NOT_FOUND;
}

/**
 * 注销任务
 */
extern "C" esp_err_t hardware_wdt_unregister_task(void)
{
    if (!s_initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    TaskHandle_t current = xTaskGetCurrentTaskHandle();

    for (int i = 0; i < WDT_MAX_TASKS; i++) {
        if (s_tasks[i].registered && s_tasks[i].task_handle == current) {
            esp_task_wdt_delete(s_tasks[i].task_handle);
            s_tasks[i].registered = false;
            ESP_LOGI(TAG, "任务 %s 已从看门狗注销", s_tasks[i].task_name);
            return ESP_OK;
        }
    }

    return ESP_ERR_NOT_FOUND;
}

/**
 * 获取看门狗状态
 */
extern "C" void hardware_wdt_get_status(hardware_wdt_status_t *status)
{
    if (status == NULL) return;

    status->initialized = s_initialized;
    status->timeout_seconds = s_wdt_config.timeout_ms / 1000;
    status->registered_tasks = 0;

    for (int i = 0; i < WDT_MAX_TASKS; i++) {
        if (s_tasks[i].registered) {
            status->registered_tasks++;
        }
    }
}
