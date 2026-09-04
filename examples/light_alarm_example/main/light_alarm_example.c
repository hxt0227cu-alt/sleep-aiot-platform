/**
 * @file light_alarm_example.c
 * @brief 光闹钟服务使用示例
 * @details 演示如何使用光闹钟服务的各项功能
 * @version 1.0
 * @date 2026-03-26
 */

#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "esp_sntp.h"
#include "light_alarm.h"

static const char *TAG = "light_alarm_example";

/**
 * @brief 事件回调函数
 * @param event 事件类型
 * @param alarm_id 闹钟ID
 *ahuang @param data 事件数据
 * @param data_len 数据长度
 */
static void light_alarm_event_handler(light_alarm_event_t event, 
                                     uint32_t alarm_id,
                                     const void *data,
                                     size_t data_len)
{
    switch (event) {
        case LIGHT_ALARM_EVENT_TRIGGERED:
            ESP_LOGI(TAG, "Event: Alarm %lu triggered", alarm_id);
            break;

        case LIGHT_ALARM_EVENT_FADE_START:
            ESP_LOGI(TAG, "Event: Fade started for alarm %lu", alarm_id);
            break;

        case LIGHT_ALARM_EVENT_FADE_PROGRESS:
            if (data != NULL && data_len >= sizeof(uint8_t)) {
                uint8_t progress = *(uint8_t *)data;
                ESP_LOGD(TAG, "Event: Fade progress %u%% for alarm %lu", 
                         progress, alarm_id);
            }
            break;

        case LIGHT_ALARM_EVENT_FADE_COMPLETE:
            ESP_LOGI(TAG, "Event: Fade completed for alarm %lu", alarm_id);
            break;

        case LIGHT_ALARM_EVENT_SNOOZE:
            if (data != NULL && data_len >= sizeof(uint8_t)) {
                uint8_t snooze_minutes = *(uint8_t *)data;
                ESP_LOGI(TAG, "Event: Alarm %lu snoozed for %u minutes", 
                         alarm_id, snooze_minutes);
            }
            break;

        case LIGHT_ALARM_EVENT_DISMISS:
            ESP_LOGI(TAG, "Event: Alarm %lu dismissed", alarm_id);
            break;

        default:
            ESP_LOGW(TAG, "Event: Unknown event %d for alarm %lu", event, alarm_id);
            break;
    }
}

/**
 * @brief 初始化SNTP时间同步
 */
static void initialize_sntp(void)
{
    ESP_LOGI(TAG, "Initializing SNTP");

    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "pool.ntp.org");
    esp_sntp_init();

    ESP_LOGI(TAG, "Waiting for time sync...");
    int retry = 0;
    const int retry_count = 10;

    while (sntp_get_sync_status() == SNTP_SYNC_STATUS_RESET && ++retry < retry_count) {
        ESP_LOGI(TAG, "Waiting for SNTP sync... (%d/%d)", retry, retry_count);
        vTaskDelay(2000 / portTICK_PERIOD_MS);
    }

    if (retry < retry_count) {
        time_t now = time(NULL);
        struct tm *timeinfo = localtime(&now);
        ESP_LOGI(TAG, "Time synchronized: %04d-%02d-%02d %02d:%02d:%02d",
                 timeinfo->tm_year + 1900, timeinfo->tm_mon + 1, timeinfo->tm_mday,
                 timeinfo->tm_hour, timeinfo->tm_min, timeinfo->tm_sec);
    } else {
        ESP_LOGW(TAG, "Failed to synchronize time");
    }
}

/**
 * @brief 示例1：创建一个简单的每日闹钟
 */
static void example_simple_alarm(void)
{
    ESP_LOGI(TAG, "=== Example 1: Simple Daily Alarm ===");

    light_alarm_config_t alarm = {0};

    strcpy(alarm.name, "Morning Alarm");
    alarm.time.hour = 7;
    alarm.time.minute = 0;
    alarm.time.second = 0;
    alarm.repeat = LIGHT_ALARM_REPEAT_DAILY;
    alarm.mode = LIGHT_ALARM_MODE_FADE_ONLY;
    alarm.enabled = true;

    alarm.fade.duration_sec = 600;
    alarm.fade.start_brightness = 0;
    alarm.fade.target_brightness = 200;
    alarm.fade.color_r = 255;
    alarm.fade.color_g = 200;
    alarm.fade.color_b = 150;

    uint32_t alarm_id;
    esp_err_t ret = light_alarm_add(&alarm, &alarm_id);
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "Alarm added successfully, ID: %lu", alarm_id);

        uint32_t next_trigger;
        light_alarm_get_next_trigger(alarm_id, &next_trigger);
        struct tm *next_tm = localtime((time_t *)&next_trigger);
        ESP_LOGI(TAG, "Next trigger: %04d-%02d-%02d %02d:%02d:%02d",
                 next_tm->tm_year + 1900, next_tm->tm_mon + 1, next_tm->tm_mday,
                 next_tm->tm_hour, next_tm->tm_min, next_tm->tm_sec);
    } else {
        ESP_LOGE(TAG, "Failed to add alarm: %s", esp_err_to_name(ret));
    }
}

/**
 * @brief 示例2：创建工作日闹钟
 */
static void example_weekday_alarm(void)
{
    ESP_LOGI(TAG, "=== Example 2: Weekday Alarm ===");

    light_alarm_config_t alarm = {0};

    strcpy(alarm.name, "Workday Alarm");
    alarm.time.hour = 6;
    alarm.time.minute = 30;
    alarm.time.second = 0;
    alarm.repeat = LIGHT_ALARM_REPEAT_WEEKDAY;
    alarm.mode = LIGHT_ALARM_MODE_FADE_SOUND;
    alarm.enabled = true;

    alarm.fade.duration_sec = 900;
    alarm.fade.start_brightness = 0;
    alarm.fade.target_brightness = 255;
    alarm.fade.color_r = 255;
    alarm.fade.color_g = 255;
    alarm.fade.color_b = 255;

    uint32_t alarm_id;
    esp_err_t ret = light_alarm_add(&alarm, &alarm_id);
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "Workday alarm added, ID: %lu", alarm_id);
    } else {
        ESP_LOGE(TAG, "Failed to add work: %s", esp_err_to_name(ret));
    }
}

/**
 * @brief 示例3：创建自定义重复闹钟
 */
static void example_custom_repeat_alarm(void)
{
    ESP_LOGI(TAG, "=== Example 3: Custom Repeat Alarm ===");

    light_alarm_config_t alarm = {0};

    strcpy(alarm.name, "Weekend Alarm");
    alarm.time.hour = 8;
    alarm.time.minute = 0;
    alarm.time.second = 0;
    alarm.repeat = LIGHT_ALARM_REPEAT_CUSTOM;
    alarm.repeat_custom.weekday_mask = 0x41;
    alarm.mode = LIGHT_ALARM_MODE_FADE_ONLY;
    alarm.enabled = true;

    alarm.fade.duration_sec = 1200;
    alarm.fade.start_brightness = 0;
    alarm.fade.target_brightness = 180;
    alarm.fade.color_r = 255;
    alarm.fade.color_g = 180;
    alarm.fade.color_b = 100;

    uint32_t alarm_id;
    esp_err_t ret = light_alarm_add(&alarm, &alarm_id);
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "Custom repeat alarm added, ID: %lu", alarm_id);
    } else {
        ESP_LOGE(TAG, "Failed to add custom alarm: %s", esp_err_to_name(ret));
    }
}

/**
 * @brief 示例4：查询所有闹钟
 */
static void example_list_alarms(void)
{
    ESP_LOGI(TAG, "=== Example 4: List All Alarms ===");

    light_alarm_config_t alarms[LIGHT_ALARM_MAX_COUNT];
    size_t count = 0;

    esp_err_t ret = light_alarm_get_all(alarms, LIGHT_ALARM_MAX_COUNT, &count);
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "Total alarms: %zu", count);

        for (size_t i = 0; i < count; i++) {
            ESP_LOGI(TAG, "Alarm %zu: ID=%lu, Name=%s, Time=%02d:%02d:%02d, Enabled=%d",
                     i, alarms[i].id, alarms[i].name,
                     alarms[i].time.hour, alarms[i].time.minute, alarms[i].time.second,
                     alarms[i].enabled);
        }
    } else {
        ESP_LOGE(TAG, "Failed to get alarms: %s", esp_err_to_name(ret));
    }
}

/**
 * @brief 示例5：手动触发闹钟
 */
static void example_manual_trigger(void)
{
    ESP_LOGI(TAG, "=== Example 5: Manual Trigger ===");

    light_alarm_config_t alarms[LIGHT_ALARM_MAX_COUNT];
    size_t count = 0;

    esp_err_t ret = light_alarm_get_all(alarms, LIGHT_ALARM_MAX_COUNT, &count);
    if (ret == ESP_OK && count > 0) {
        ESP_LOGI(TAG, "Manually triggering alarm %lu", alarms[0].id);
        light_alarm_trigger(alarms[0].id);
    } else {
        ESP_LOGW(TAG, "No alarms to trigger");
    }
}

/**
 * @brief 示例6：贪睡功能
 */
static void example_snooze(void)
{
    ESP_LOGI(TAG, "=== Example 6: Snooze Function ===");

    light_alarm_config_t alarms[LIGHT_ALARM_MAX_COUNT];
    size_t count = 0;

    esp_err_t ret = light_alarm_get_all(alarms, LIGHT_ALARM_MAX_COUNT, &count);
    if (ret == ESP_OK && count > 0) {
        ESP_LOGI(TAG, "Snoozing alarm %lu for 5 minutes", alarms[0].id);
        light_alarm_snooze(alarms[0].id, 5);
    } else {
        ESP_LOGW(TAG, "No alarms to snooze");
    }
}

/**
 * @brief 示例7：获取渐变状态
 */
static void example_fade_status(void)
{
    ESP_LOGI(TAG, "=== Example 7: Fade Status ===");

    light_alarm_fade_status_t status;
    esp_err_t ret = light_alarm_get_fade_status(&status);
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "Fade state: %d", status.state);
        ESP_LOGI(TAG, "Elapsed: %lu seconds", status.elapsed_sec);
        ESP_LOGI(TAG, "Current brightness: %u", status.current_brightness);
        ESP_LOGI(TAG, "Progress: %u%%", status.progress);
    } else {
        ESP_LOGE(TAG, "Failed to get fade status: %s", esp_err_to_name(ret));
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Light Alarm Example Starting...");

    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS flash needs erase, erasing...");
        nvs_flash_erase();
        ret = nvs_flash_init();
    }
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init NVS flash: %s", esp_err_to_name(ret));
        return;
    }

    initialize_sntp();

    ret = light_alarm_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init light alarm: %s", esp_err_to_name(ret));
        return;
    }

    light_alarm_set_event_callback(light_alarm_event_handler);

    example_simple_alarm();
    vTaskDelay(1000 / portTICK_PERIOD_MS);

    example_weekday_alarm();
    vTaskDelay(1000 / portTICK_PERIOD_MS);

    example_custom_repeat_alarm();
    vTaskDelay(1000 / portTICK_PERIOD_MS);

    example_list_alarms();
    vTaskDelay(1000 / portTICK_PERIOD_MS);

    ret = light_alarm_start();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start light alarm: %s", esp_err_to_name(ret));
        return;
    }

    ESP_LOGI(TAG, "Light alarm service started");
    ESP_LOGI(TAG, "Press 't' to manually trigger first alarm");
    ESP_LOGI(TAG, "Press 's' to snooze first alarm");
    ESP_LOGI(TAG, "Press 'd' to dismiss first alarm");
    ESP_LOGI(TAG, "Press 'l' to list all alarms");
    ESP_LOGI(TAG, "Press 'f' to show fade status");

    while (1) {
        vTaskDelay(10000 / portTICK_PERIOD_MS);
        example_fade_status();
    }
}
