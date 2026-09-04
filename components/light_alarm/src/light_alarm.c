/**
 * @file light_alarm.c
 * @brief 光闹钟服务实现
 * @details 提供光闹钟管理、渐变唤醒、定时任务等功能
 * @version 1.0
 * @date 2026-03-26
 */

#include "light_alarm.h"
#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "freertos/timers.h"
#include "driver/ledc.h"
#include "soc/ledc_struct.h"
#include "esp_sntp.h"
#include <string.h>
#include <time.h>

/* ==================== 宏定义 ==================== */

/** NVS命名空间 */
#define LIGHT_ALARM_NVS_NAMESPACE      "light_alarm"

/** NVS键名 */
#define LIGHT_ALARM_NVS_KEY_COUNT      "alarm_count"
#define LIGHT_ALARM_NVS_KEY_PREFIX     "alarm_"

/** 任务优先级 */
#define LIGHT_ALARM_TASK_PRIORITY       5

/** 任务栈大小 */
#define LIGHT_ALARM_TASK_STACK_SIZE     4096

/** 定时器检查间隔（毫秒） */
#define LIGHT_ALARM_CHECK_INTERVAL_MS  1000

/** 渐变更新间隔（毫秒） */
#define LIGHT_ALARM_FADE_UPDATE_MS     100

/** LED PWM配置 */
#define LIGHT_ALARM_LED_PWM_FREQ       5000
#define LIGHT_ALARM_LED_PWM_RES        8
#define LIGHT_ALARM_LED_PWM_DUTY_MAX   255

/** LED通道配置 */
#define LIGHT_ALARM_LED_CHANNEL_R      LEDC_CHANNEL_0
#define LIGHT_ALARM_LED_CHANNEL_G      LEDC_CHANNEL_1
#define LIGHT_ALARM_LED_CHANNEL_B      LEDC_CHANNEL_2
#define LIGHT_ALARM_LED_SPEED_MODE     LEDC_LOW_SPEED_MODE
#define LIGHT_ALARM_LED_TIMER          LEDC_TIMER_0

/* ==================== 类型定义 ==================== */

/**
 * @brief 闹钟管理器结构体
 */
typedef struct {
    light_alarm_config_t alarms[LIGHT_ALARM_MAX_COUNT];  /**< 闹钟数组 */
    size_t alarm_count;                                   /**< 闹钟数量 */
    uint32_t next_alarm_id;                              /**< 下一个闹钟ID */
    SemaphoreHandle_t mutex;                             /**< 互斥锁 */
    bool initialized;                                    /**< 初始化标志 */
    bool running;                                        /**< 运行标志 */
} light_alarm_manager_t;

/**
 * @brief 渐变控制器结构体
 */
typedef struct {
    light_alarm_fade_state_t state;                      /**< 渐变状态 */
    light_alarm_fade_config_t config;                    /**< 渐变配置 */
    uint32_t start_time;                                 /**< 开始时间戳 */
    uint32_t elapsed_sec;                                /**< 已经过时间（秒） */
    uint8_t current_brightness;                          /**< 当前亮度 */
    uint8_t progress;                                    /**< 进度（0-100） */
    uint32_t active_alarm_id;                            /**< 激活的闹钟ID */
    TimerHandle_t timer;                                 /**< 渐变定时器 */
} light_alarm_fade_controller_t;

/**
 * @brief 定时任务结构体
 */
typedef struct {
    TaskHandle_t task_handle;                            /**< 任务句柄 */
    QueueHandle_t event_queue;                           /**< 事件队列 */
    TimerHandle_t check_timer;                           /**< 检查定时器 */
} light_alarm_scheduler_t;

/* ==================== 全局变量 ==================== */

static const char *TAG = "light_alarm";

static light_alarm_manager_t g_alarm_manager = {0};
static light_alarm_fade_controller_t g_fade_controller = {0};
static light_alarm_scheduler_t g_scheduler = {0};

static light_alarm_event_callback_t g_event_callback = NULL;

/* ==================== 内部函数声明 ==================== */

static esp_err_t light_alarm_manager_init(void);
static esp_err_t light_alarm_manager_deinit(void);
static int light_alarm_find_index(uint32_t alarm_id);
static esp_err_t light_alarm_validate_config(const light_alarm_config_t *config);
static void light_alarm_emit_event(light_alarm_event_t event, uint32_t alarm_id, 
                                    const void *data, size_t data_len);

static esp_err_t light_alarm_fade_init(void);
static esp_err_t light_alarm_fade_deinit(void);
static void light_alarm_fade_timer_callback(TimerHandle_t timer);
static esp_err_t light_alarm_fade_start(const light_alarm_fade_config_t *config, 
                                         uint32_t alarm_id);
static esp_err_t light_alarm_fade_update(void);
static esp_err_t light_alarm_led_init(void);
static esp_err_t light_alarm_led_set_color(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness);

static esp_err_t light_alarm_scheduler_init(void);
static esp_err_t light_alarm_scheduler_deinit(void);
static void light_alarm_scheduler_task(void *pvParameters);
static void light_alarm_check_timer_callback(TimerHandle_t timer);
static void light_alarm_check_alarms(void);
static bool light_alarm_should_trigger(const light_alarm_config_t *alarm, 
                                        const struct tm *now);

static esp_err_t light_alarm_config_save(void);
static esp_err_t light_alarm_config_load(void);

/* ==================== 内部函数实现 ==================== */

/**
 * @brief 初始化闹钟管理器
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
static esp_err_t light_alarm_manager_init(void)
{
    ESP_LOGI(TAG, "Initializing alarm manager...");

    memset(&g_alarm_manager, 0, sizeof(light_alarm_manager_t));

    g_alarm_manager.mutex = xSemaphoreCreateMutex();
    if (g_alarm_manager.mutex == NULL) {
        ESP_LOGE(TAG, "Failed to create mutex");
        return ESP_FAIL;
    }

    g_alarm_manager.next_alarm_id = 1;
    g_alarm_manager.initialized = true;

    ESP_LOGI(TAG, "Alarm manager initialized");
    return ESP_OK;
}

/**
 * @brief 反初始化闹钟管理器
 * @return ESP_OK 成功
 */
static esp_err_t light_alarm_manager_deinit(void)
{
    if (g_alarm_manager.mutex != NULL) {
        vSemaphoreDelete(g_alarm_manager.mutex);
        g_alarm_manager.mutex = NULL;
    }

    g_alarm_manager.initialized = false;
    return ESP_OK;
}

/**
 * @brief 查找闹钟索引
 * @param alarm_id 闹钟ID
 * @return 闹钟索引，未找到返回-1
 */
static int light_alarm_find_index(uint32_t alarm_id)
{
    for (size_t i = 0; i < g_alarm_manager.alarm_count; i++) {
        if (g_alarm_manager.alarms[i].id == alarm_id) {
            return (int)i;
        }
    }
    return -1;
}

/**
 * @brief 验证闹钟配置
 * @param config 闹钟配置
 * @return ESP_OK 有效
 * @return ESP_ERR_INVALID_ARG 无效
 */
static esp_err_t light_alarm_validate_config(const light_alarm_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (config->time.hour >= 24 || config->time.minute >= 60 || config->time.second >= 60) {
        ESP_LOGE(TAG, "Invalid time: %02d:%02d:%02d", 
                 config->time.hour, config->time.minute, config->time.second);
        return ESP_ERR_INVALID_ARG;
    }

    if (config->fade.duration_sec < LIGHT_ALARM_FADE_MIN_SEC || 
        config->fade.duration_sec > LIGHT_ALARM_FADE_MAX_SEC) {
        ESP_LOGE(TAG, "Invalid fade duration: %u", config->fade.duration_sec);
        return ESP_ERR_INVALID_ARG;
    }

    if (config->fade.start_brightness > LIGHT_ALARM_BRIGHTNESS_MAX ||
        config->fade.target_brightness > LIGHT_ALARM_BRIGHTNESS_MAX) {
        ESP_LOGE(TAG, "Invalid brightness: start=%u, target=%u",
                 config->fade.start_brightness, config->fade.target_brightness);
        return ESP_ERR_INVALID_ARG;
    }

    return ESP_OK;
}

/**
 * @brief 发送事件
 * @param event 事件类型
 * @param alarm_id 闹钟ID
 * @param data 事件数据
 * @param data_len 数据长度
 */
static void light_alarm_emit_event(light_alarm_event_t event, uint32_t alarm_id,
                                    const void *data, size_t data_len)
{
    if (g_event_callback != NULL) {
        g_event_callback(event, alarm_id, data, data_len);
    }
}

/**
 * @brief 初始化渐变控制器
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
static esp_err_t light_alarm_fade_init(void)
{
    ESP_LOGI(TAG, "Initializing fade controller...");

    memset(&g_fade_controller, 0, sizeof(light_alarm_fade_controller_t));
    g_fade_controller.state = LIGHT_ALARM_FADE_IDLE;

    esp_err_t ret = light_alarm_led_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize LED: %s", esp_err_to_name(ret));
        return ret;
    }

    g_fade_controller.timer = xTimerCreate("fade_timer",
                                           pdMS_TO_TICKS(LIGHT_ALARM_FADE_UPDATE_MS),
                                           pdTRUE,
                                           NULL,
                                           light_alarm_fade_timer_callback);
    if (g_fade_controller.timer == NULL) {
        ESP_LOGE(TAG, "Failed to create fade timer");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Fade controller initialized");
    return ESP_OK;
}

/**
 * @brief 反初始化渐变控制器
 * @return ESP_OK 成功
 */
static esp_err_t light_alarm_fade_deinit(void)
{
    if (g_fade_controller.timer != NULL) {
        xTimerDelete(g_fade_controller.timer, portMAX_DELAY);
        g_fade_controller.timer = NULL;
    }

    return ESP_OK;
}

/**
 * @brief 渐变定时器回调
 * @param timer 定时器句柄
 */
static void light_alarm_fade_timer_callback(TimerHandle_t timer)
{
    light_alarm_fade_update();
}

/**
 * @brief 启动渐变
 * @param config 渐变配置
 * @param alarm_id 闹钟ID
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
static esp_err_t light_alarm_fade_start(const light_alarm_fade_config_t *config,
                                         uint32_t alarm_id)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (g_fade_controller.state == LIGHT_ALARM_FADE_RUNNING) {
        ESP_LOGW(TAG, "Fade already running");
        return ESP_ERR_INVALID_STATE;
    }

    memcpy(&g_fade_controller.config, config, sizeof(light_alarm_fade_config_t));
    g_fade_controller.active_alarm_id = alarm_id;
    g_fade_controller.start_time = xTaskGetTickCount() * portTICK_PERIOD_MS;
    g_fade_controller.elapsed_sec = 0;
    g_fade_controller.current_brightness = config->start_brightness;
    g_fade_controller.progress = 0;
    g_fade_controller.state = LIGHT_ALARM_FADE_RUNNING;

    esp_err_t ret = light_alarm_led_set_color(config->color_r, config->color_g, 
                                               config->color_b, 
                                               config->start_brightness);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set LED color: %s", esp_err_to_name(ret));
        return ret;
    }

    if (xTimerStart(g_fade_controller.timer, 0) != pdPASS) {
        ESP_LOGE(TAG, "Failed to start fade timer");
        return ESP_FAIL;
    }

    light_alarm_emit_event(LIGHT_ALARM_EVENT_FADE_START, alarm_id, NULL, 0);

    ESP_LOGI(TAG, "Fade started for alarm %lu, duration %u seconds", 
             alarm_id, config->duration_sec);
    return ESP_OK;
}

/**
 * @brief 更新渐变
 * @return ESP_OK 成功
 */
static esp_err_t light_alarm_fade_update(void)
{
    if (g_fade_controller.state != LIGHT_ALARM_FADE_RUNNING) {
        return ESP_OK;
    }

    uint32_t current_time = xTaskGetTickCount() * portTICK_PERIOD_MS;
    g_fade_controller.elapsed_sec = (current_time - g_fade_controller.start_time) / 1000;

    if (g_fade_controller.elapsed_sec >= g_fade_controller.config.duration_sec) {
        g_fade_controller.elapsed_sec = g_fade_controller.config.duration_sec;
        g_fade_controller.current_brightness = g_fade_controller.config.target_brightness;
        g_fade_controller.progress = 100;
        g_fade_controller.state = LIGHT_ALARM_FADE_COMPLETED;

        xTimerStop(g_fade_controller.timer, 0);

        light_alarm_emit_event(LIGHT_ALARM_EVENT_FADE_COMPLETE, 
                               g_fade_controller.active_alarm_id, NULL, 0);

        ESP_LOGI(TAG, "Fade completed for alarm %lu", g_fade_controller.active_alarm_id);
    } else {
        float progress = (float)g_fade_controller.elapsed_sec / 
                         g_fade_controller.config.duration_sec;
        g_fade_controller.progress = (uint8_t)(progress * 100);

        int brightness_diff = g_fade_controller.config.target_brightness - 
                              g_fade_controller.config.start_brightness;
        g_fade_controller.current_brightness = g_fade_controller.config.start_brightness + 
                                               (uint8_t)(brightness_diff * progress);

        light_alarm_emit_event(LIGHT_ALARM_EVENT_FADE_PROGRESS,
                               g_fade_controller.active_alarm_id,
                               &g_fade_controller.progress,
                               sizeof(g_fade_controller.progress));
    }

    esp_err_t ret = light_alarm_led_set_color(g_fade_controller.config.color_r,
                                               g_fade_controller.config.color_g,
                                               g_fade_controller.config.color_b,
                                               g_fade_controller.current_brightness);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to update LED: %s", esp_err_to_name(ret));
        return ret;
    }

    return ESP_OK;
}

/**
 * @brief 初始化LED驱动
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
static esp_err_t light_alarm_led_init(void)
{
    ESP_LOGI(TAG, "Initializing LED driver...");

    ledc_timer_config_t timer_conf = {
        .speed_mode = LIGHT_ALARM_LED_SPEED_MODE,
        .duty_resolution = LIGHT_ALARM_LED_PWM_RES,
        .timer_num = LIGHT_ALARM_LED_TIMER,
        .freq_hz = LIGHT_ALARM_LED_PWM_FREQ,
        .clk_cfg = LEDC_AUTO_CLK,
    };

    esp_err_t ret = ledc_timer_config(&timer_conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure LED timer: %s", esp_err_to_name(ret));
        return ret;
    }

    ledc_channel_config_t channel_conf = {
        .speed_mode = LIGHT_ALARM_LED_SPEED_MODE,
        .timer_num = LIGHT_ALARM_LED_TIMER,
        .intr_type = LEDC_INTR_DISABLE,
        .channel = LIGHT_ALARM_LED_CHANNEL_R,
        .duty = 0,
        .gpio_num = GPIO_NUM_NC,
    };

    ret = ledc_channel_config(&channel_conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure LED channel R: %s", esp_err_to_name(ret));
        return ret;
    }

    channel_conf.channel = LIGHT_ALARM_LED_CHANNEL_G;
    ret = ledc_channel_config(&channel_conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure LED channel G: %s", esp_err_to_name(ret));
        return ret;
    }

    channel_conf.channel = LIGHT_ALARM_LED_CHANNEL_B;
    ret = ledc_channel_config(&channel_conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure LED channel B: %s", esp_err_to_name(ret));
        return ret;
    }

    ESP_LOGI(TAG, "LED driver initialized");
    return ESP_OK;
}

/**
 * @brief 设置LED颜色和亮度
 * @param r 红色分量（0-255）
 * @param g 绿色分量（0-255）
 * @param b 蓝色分量（0-255）
 * @param brightness 亮度（0-255）
 * @return ESP_OK 成功
 */
static esp_err_t light_alarm_led_set_color(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness)
{
    float brightness_factor = (float)brightness / 255.0f;

    uint32_t duty_r = (uint32_t)(r * brightness_factor);
    uint32_t duty_g = (uint32_t)(g * brightness_factor);
    uint32_t duty_b = (uint32_t)(b * brightness_factor);

    ledc_set_duty(LIGHT_ALARM_LED_SPEED_MODE, LIGHT_ALARM_LED_CHANNEL_R, duty_r);
    ledc_set_duty(LIGHT_ALARM_LED_SPEED_MODE, LIGHT_ALARM_LED_CHANNEL_G, duty_g);
    ledc_set_duty(LIGHT_ALARM_LED_SPEED_MODE, LIGHT_ALARM_LED_CHANNEL_B, duty_b);

    ledc_update_duty(LIGHT_ALARM_LED_SPEED_MODE, LIGHT_ALARM_LED_CHANNEL_R);
    ledc_update_duty(LIGHT_ALARM_LED_SPEED_MODE, LIGHT_ALARM_LED_CHANNEL_G);
    ledc_update_duty(LIGHT_ALARM_LED_SPEED_MODE, LIGHT_ALARM_LED_CHANNEL_B);

    return ESP_OK;
}

/**
 * @brief 初始化定时任务调度器
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
static esp_err_t light_alarm_scheduler_init(void)
{
    ESP_LOGI(TAG, "Initializing scheduler...");

    memset(&g_scheduler, 0, sizeof(light_alarm_scheduler_t));

    g_scheduler.event_queue = xQueueCreate(10, sizeof(light_alarm_event_t));
    if (g_scheduler.event_queue == NULL) {
        ESP_LOGE(TAG, "Failed to create event queue");
        return ESP_FAIL;
    }

    BaseType_t ret = xTaskCreatePinnedToCore(
        light_alarm_scheduler_task,
        "alarm_sched",
        LIGHT_ALARM_TASK_STACK_SIZE,
        NULL,
        LIGHT_ALARM_TASK_PRIORITY,
        &g_scheduler.task_handle,
        1
    );

    if (ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create scheduler task");
        vQueueDelete(g_scheduler.event_queue);
        return ESP_FAIL;
    }

    g_scheduler.check_timer = xTimerCreate("check_timer",
                                            pdMS_TO_TICKS(LIGHT_ALARM_CHECK_INTERVAL_MS),
                                            pdTRUE,
                                            NULL,
                                            light_alarm_check_timer_callback);
    if (g_scheduler.check_timer == NULL) {
        ESP_LOGE(TAG, "Failed to create check timer");
        vTaskDelete(g_scheduler.task_handle);
        vQueueDelete(g_scheduler.event_queue);
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Scheduler initialized");
    return ESP_OK;
}

/**
 * @brief 反初始化定时任务调度器
 * @return ESP_OK 成功
 */
static esp_err_t light_alarm_scheduler_deinit(void)
{
    if (g_scheduler.check_timer != NULL) {
        xTimerDelete(g_scheduler.check_timer, portMAX_DELAY);
        g_scheduler.check_timer = NULL;
    }

    if (g_scheduler.task_handle != NULL) {
        vTaskDelete(g_scheduler.task_handle);
        g_scheduler.task_handle = NULL;
    }

    if (g_scheduler.event_queue != NULL) {
        vQueueDelete(g_scheduler.event_queue);
        g_scheduler.event_queue = NULL;
    }

    return ESP_OK;
}

/**
 * @brief 调度器任务
 * @param pvParameters 任务参数
 */
static void light_alarm_scheduler_task(void *pvParameters)
{
    ESP_LOGI(TAG, "Scheduler task started");

    light_alarm_event_t event;

    while (g_alarm_manager.running) {
        if (xQueueReceive(g_scheduler.event_queue, &event, pdMS_TO_TICKS(100)) == pdTRUE) {
            ESP_LOGD(TAG, "Received event: %d", event);
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }

    ESP_LOGI(TAG, "Scheduler task stopped");
    vTaskDelete(NULL);
}

/**
 * @brief 检查定时器回调
 * @param timer 定时器句柄
 */
static void light_alarm_check_timer_callback(TimerHandle_t timer)
{
    light_alarm_check_alarms();
}

/**
 * @brief 检查闹钟触发
 */
static void light_alarm_check_alarms(void)
{
    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "Failed to take mutex in check");
        return;
    }

    time_t now_time = time(NULL);
    struct tm *now_tm = localtime(&now_time);

    for (size_t i = 0; i < g_alarm_manager.alarm_count; i++) {
        light_alarm_config_t *alarm = &g_alarm_manager.alarms[i];

        if (!alarm->enabled) {
            continue;
        }

        if (alarm->next_trigger == 0) {
            continue;
        }

        if (now_time >= alarm->next_trigger) {
            ESP_LOGI(TAG, "Alarm %lu triggered at %02d:%02d:%02d",
                     alarm->id, now_tm->tm_hour, now_tm->tm_min, now_tm->tm_sec);

            alarm->state = LIGHT_ALARM_STATE_TRIGGERED;
            alarm->last_triggered = now_time;

            light_alarm_emit_event(LIGHT_ALARM_EVENT_TRIGGERED, alarm->id, NULL, 0);

            light_alarm_fade_start(&alarm->fade, alarm->id);

            if (alarm->repeat == LIGHT_ALARM_REPEAT_ONCE) {
                alarm->enabled = false;
                alarm->next_trigger = 0;
            } else {
                light_alarm_calc_next_trigger(alarm, now_time, &alarm->next_trigger);
            }
        }
    }

    xSemaphoreGive(g_alarm_manager.mutex);
}

/**
 * @brief 判断闹钟是否应该触发
 * @param alarm 闹钟配置
 * @param now 当前时间
 * @return true 应该触发
 * @return false 不应该触发
 */
static bool light_alarm_should_trigger(const light_alarm_config_t *alarm,
                                        const struct tm *now)
{
    if (alarm->time.hour != now->tm_hour || alarm->time.minute != now->tm_min) {
        return false;
    }

    switch (alarm->repeat) {
        case LIGHT_ALARM_REPEAT_ONCE:
            return true;

        case LIGHT_ALARM_REPEAT_DAILY:
            return true;

        case LIGHT_ALARM_REPEAT_WEEKDAY:
            return (now->tm_wday >= 1 && now->tm_wday <= 5);

        case LIGHT_ALARM_REPEAT_WEEKEND:
            return (now->tm_wday == 0 || now->tm_wday == 6);

        case LIGHT_ALARM_REPEAT_CUSTOM:
            return (alarm->repeat_custom.weekday_mask & (1 << now->tm_wday)) != 0;

        default:
            return false;
    }
}

/**
 * @brief 保存配置到NVS
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
static esp_err_t light_alarm_config_save(void)
{
    ESP_LOGI(TAG, "Saving alarm config to NVS...");

    nvs_handle_t nvs_handle;
    esp_err_t ret = nvs_open(LIGHT_ALARM_NVS_NAMESPACE, NVS_READWRITE, &nvs_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open NVS: %s", esp_err_to_name(ret));
        return ret;
    }

    ret = nvs_set_u8(nvs_handle, LIGHT_ALARM_NVS_KEY_COUNT, g_alarm_manager.alarm_count);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to save alarm count: %s", esp_err_to_name(ret));
        nvs_close(nvs_handle);
        return ret;
    }

    char key[32];
    for (size_t i = 0; i < g_alarm_manager.alarm_count; i++) {
        snprintf(key, sizeof(key), "%s%zu", LIGHT_ALARM_NVS_KEY_PREFIX, i);
        ret = nvs_set_blob(nvs_handle, key, &g_alarm_manager.alarms[i], 
                           sizeof(light_alarm_config_t));
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "Failed to save alarm %zu: %s", i, esp_err_to_name(ret));
            nvs_close(nvs_handle);
            return ret;
        }
    }

    ret = nvs_commit(nvs_handle);
    nvs_close(nvs_handle);

    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "Alarm config saved successfully");
    } else {
        ESP_LOGE(TAG, "Failed to commit NVS: %s", esp_err_to_name(ret));
    }

    return ret;
}

/**
 * @brief 从NVS加载配置
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
static esp_err_t light_alarm_config_load(void)
{
    ESP_LOGI(TAG, "Loading alarm config from NVS...");

    nvs_handle_t nvs_handle;
    esp_err_t ret = nvs_open(LIGHT_ALARM_NVS_NAMESPACE, NVS_READONLY, &nvs_handle);
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "No saved alarm config found: %s", esp_err_to_name(ret));
        return ESP_ERR_NOT_FOUND;
    }

    uint8_t count = 0;
    ret = nvs_get_u8(nvs_handle, LIGHT_ALARM_NVS_KEY_COUNT, &count);
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Failed to get alarm count: %s", esp_err_to_name(ret));
        nvs_close(nvs_handle);
        return ESP_ERR_NOT_FOUND;
    }

    if (count > LIGHT_ALARM_MAX_COUNT) {
        ESP_LOGW(TAG, "Invalid alarm count: %u", count);
        nvs_close(nvs_handle);
        return ESP_ERR_INVALID_ARG;
    }

    g_alarm_manager.alarm_count = count;

    char key[32];
    size_t required_size = sizeof(light_alarm_config_t);
    for (size_t i = 0; i < count; i++) {
        snprintf(key, sizeof(key), "%s%zu", LIGHT_ALARM_NVS_KEY_PREFIX, i);
        ret = nvs_get_blob(nvs_handle, key, &g_alarm_manager.alarms[i], &required_size);
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "Failed to load alarm %zu: %s", i, esp_err_to_name(ret));
            nvs_close(nvs_handle);
            return ret;
        }

        if (g_alarm_manager.alarms[i].id >= g_alarm_manager.next_alarm_id) {
            g_alarm_manager.next_alarm_id = g_alarm_manager.alarms[i].id + 1;
        }
    }

    nvs_close(nvs_handle);

    ESP_LOGI(TAG, "Loaded %zu alarms from NVS", count);
    return ESP_OK;
}

/* ==================== 公共API实现 ==================== */

esp_err_t light_alarm_init(void)
{
    ESP_LOGI(TAG, "Initializing light alarm service...");

    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS flash needs erase, erasing...");
        ret = nvs_flash_erase();
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "Failed to erase NVS flash: %s", esp_err_to_name(ret));
            return ret;
        }
        ret = nvs_flash_init();
    }
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init NVS flash: %s", esp_err_to_name(ret));
        return ret;
    }

    ret = light_alarm_manager_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init alarm manager: %s", esp_err_to_name(ret));
        return ret;
    }

    ret = light_alarm_fade_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init fade controller: %s", esp_err_to_name(ret));
        light_alarm_manager_deinit();
        return ret;
    }

    ret = light_alarm_scheduler_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init scheduler: %s", esp_err_to_name(ret));
        light_alarm_fade_deinit();
        light_alarm_manager_deinit();
        return ret;
    }

    light_alarm_load_config();

    ESP_LOGI(TAG, "Light alarm service initialized");
    return ESP_OK;
}

esp_err_t light_alarm_deinit(void)
{
    ESP_LOGI(TAG, "Deinitializing light alarm service...");

    light_alarm_scheduler_deinit();
    light_alarm_fade_deinit();
    light_alarm_manager_deinit();

    ESP_LOGI(TAG, "Light alarm service deinitialized");
    return ESP_OK;
}

esp_err_t light_alarm_start(void)
{
    ESP_LOGI(TAG, "Starting light alarm service...");

    if (!g_alarm_manager.initialized) {
        ESP_LOGE(TAG, "Service not initialized");
        return ESP_ERR_INVALID_STATE;
    }

    g_alarm_manager.running = true;

    if (xTimerStart(g_scheduler.check_timer, 0) != pdPASS) {
        ESP_LOGE(TAG, "Failed to start check timer");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Light alarm service started");
    return ESP_OK;
}

esp_err_t light_alarm_stop(void)
{
    ESP_LOGI(TAG, "Stopping light alarm service...");

    g_alarm_manager.running = false;

    if (g_scheduler.check_timer != NULL) {
        xTimerStop(g_scheduler.check_timer, 0);
    }

    light_alarm_fade_stop();

    ESP_LOGI(TAG, "Light alarm service stopped");
    return ESP_OK;
}

esp_err_t light_alarm_add(const light_alarm_config_t *config, uint32_t *alarm_id)
{
    if (config == NULL || alarm_id == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t ret = light_alarm_validate_config(config);
    if (ret != ESP_OK) {
        return ret;
    }

    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    if (g_alarm_manager.alarm_count >= LIGHT_ALARM_MAX_COUNT) {
        ESP_LOGE(TAG, "Maximum alarm count reached");
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NO_MEM;
    }

    light_alarm_config_t new_alarm;
    memcpy(&new_alarm, config, sizeof(light_alarm_config_t));
    new_alarm.id = g_alarm_manager.next_alarm_id++;
    new_alarm.state = LIGHT_ALARM_STATE_ENABLED;
    new_alarm.last_triggered = 0;

    time_t now = time(NULL);
    light_alarm_calc_next_trigger(&new_alarm, now, &new_alarm.next_trigger);

    g_alarm_manager.alarms[g_alarm_manager.alarm_count++] = new_alarm;
    *alarm_id = new_alarm.id;

    xSemaphoreGive(g_alarm_manager.mutex);

    light_alarm_save_config();

    ESP_LOGI(TAG, "Alarm %lu added, next trigger at %lu", new_alarm.id, new_alarm.next_trigger);
    return ESP_OK;
}

esp_err_t light_alarm_remove(uint32_t alarm_id)
{
    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    int index = light_alarm_find_index(alarm_id);
    if (index < 0) {
        ESP_LOGE(TAG, "Alarm %lu not found", alarm_id);
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    for (size_t i = index; i < g_alarm_manager.alarm_count - 1; i++) {
        g_alarm_manager.alarms[i] = g_alarm_manager.alarms[i + 1];
    }

    g_alarm_manager.alarm_count--;

    xSemaphoreGive(g_alarm_manager.mutex);

    light_alarm_save_config();

    ESP_LOGI(TAG, "Alarm %lu removed", alarm_id);
    return ESP_OK;
}

esp_err_t light_alarm_update(uint32_t alarm_id, const light_alarm_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t ret = light_alarm_validate_config(config);
    if (ret != ESP_OK) {
        return ret;
    }

    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    int index = light_alarm_find_index(alarm_id);
    if (index < 0) {
        ESP_LOGE(TAG, "Alarm %lu not found", alarm_id);
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    uint32_t old_id = g_alarm_manager.alarms[index].id;
    memcpy(&g_alarm_manager.alarms[index], config, sizeof(light_alarm_config_t));
    g_alarm_manager.alarms[index].id = old_id;

    time_t now = time(NULL);
    light_alarm_calc_next_trigger(&g_alarm_manager.alarms[index], now, 
                                  &g_alarm_manager.alarms[index].next_trigger);

    xSemaphoreGive(g_alarm_manager.mutex);

    light_alarm_save_config();

    ESP_LOGI(TAG, "Alarm %lu updated", alarm_id);
    return ESP_OK;
}

esp_err_t light_alarm_get(uint32_t alarm_id, light_alarm_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    int index = light_alarm_find_index(alarm_id);
    if (index < 0) {
        ESP_LOGE(TAG, "Alarm %lu not found", alarm_id);
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    memcpy(config, &g_alarm_manager.alarms[index], sizeof(light_alarm_config_t));

    xSemaphoreGive(g_alarm_manager.mutex);

    return ESP_OK;
}

esp_err_t light_alarm_get_all(light_alarm_config_t *alarms, 
                               size_t max_count, 
                               size_t *count)
{
    if (alarms == NULL || count == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    size_t copy_count = (g_alarm_manager.alarm_count < max_count) ? 
                        g_alarm_manager.alarm_count : max_count;

    memcpy(alarms, g_alarm_manager.alarms, copy_count * sizeof(light_alarm_config_t));
    *count = copy_count;

    xSemaphoreGive(g_alarm_manager.mutex);

    return ESP_OK;
}

esp_err_t light_alarm_enable(uint32_t alarm_id)
{
    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    int index = light_alarm_find_index(alarm_id);
    if (index < 0) {
        ESP_LOGE(TAG, "Alarm %lu not found", alarm_id);
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    g_alarm_manager.alarms[index].enabled = true;
    g_alarm_manager.alarms[index].state = LIGHT_ALARM_STATE_ENABLED;

    time_t now = time(NULL);
    light_alarm_calc_next_trigger(&g_alarm_manager.alarms[index], now,
                                  &g_alarm_manager.alarms[index].next_trigger);

    xSemaphoreGive(g_alarm_manager.mutex);

    light_alarm_save_config();

    ESP_LOGI(TAG, "Alarm %lu enabled", alarm_id);
    return ESP_OK;
}

esp_err_t light_alarm_disable(uint32_t alarm_id)
{
    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    int index = light_alarm_find_index(alarm_id);
    if (index < 0) {
        ESP_LOGE(TAG, "Alarm %lu not found", alarm_id);
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    g_alarm_manager.alarms[index].enabled = false;
    g_alarm_manager.alarms[index].state = LIGHT_ALARM_STATE_DISABLED;
    g_alarm_manager.alarms[index].next_trigger = 0;

    xSemaphoreGive(g_alarm_manager.mutex);

    light_alarm_save_config();

    ESP_LOGI(TAG, "Alarm %lu disabled", alarm_id);
    return ESP_OK;
}

esp_err_t light_alarm_trigger(uint32_t alarm_id)
{
    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    int index = light_alarm_find_index(alarm_id);
    if (index < 0) {
        ESP_LOGE(TAG, "Alarm %lu not found", alarm_id);
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    light_alarm_config_t *alarm = &g_alarm_manager.alarms[index];

    xSemaphoreGive(g_alarm_manager.mutex);

    alarm->state = LIGHT_ALARM_STATE_TRIGGERED;
    alarm->last_triggered = time(NULL);

    light_alarm_emit_event(LIGHT_ALARM_EVENT_TRIGGERED, alarm_id, NULL, 0);

    light_alarm_fade_start(&alarm->fade, alarm_id);

    ESP_LOGI(TAG, "Alarm %lu manually triggered", alarm_id);
    return ESP_OK;
}

esp_err_t light_alarm_snooze(uint32_t alarm_id, uint8_t snooze_minutes)
{
    if (snooze_minutes == 0 || snooze_minutes > 60) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    int index = light_alarm_find_index(alarm_id);
    if (index < 0) {
        ESP_LOGE(TAG, "Alarm %lu not found", alarm_id);
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    light_alarm_config_t *alarm = &g_alarm_manager.alarms[index];
    alarm->state = LIGHT_ALARM_STATE_SNOOZED;

    time_t now = time(NULL);
    alarm->next_trigger = now + snooze_minutes * 60;

    xSemaphoreGive(g_alarm_manager.mutex);

    light_alarm_fade_stop();

    light_alarm_emit_event(LIGHT_ALARM_EVENT_SNOOZE, alarm_id, &snooze_minutes, 
                           sizeof(snooze_minutes));

    ESP_LOGI(TAG, "Alarm %lu snoozed for %u minutes", alarm_id, snooze_minutes);
    return ESP_OK;
}

esp_err_t light_alarm_dismiss(uint32_t alarm_id)
{
    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    int index = light_alarm_find_index(alarm_id);
    if (index < 0) {
        ESP_LOGE(TAG, "Alarm %lu not found", alarm_id);
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    light_alarm_config_t *alarm = &g_alarm_manager.alarms[index];
    alarm->state = LIGHT_ALARM_STATE_ENABLED;

    xSemaphoreGive(g_alarm_manager.mutex);

    light_alarm_fade_stop();

    light_alarm_emit_event(LIGHT_ALARM_EVENT_DISMISS, alarm_id, NULL, 0);

    ESP_LOGI(TAG, "Alarm %lu dismissed", alarm_id);
    return ESP_OK;
}

esp_err_t light_alarm_get_fade_status(light_alarm_fade_status_t *status)
{
    if (status == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    status->state = g_fade_controller.state;
    status->start_time = g_fade_controller.start_time;
    status->elapsed_sec = g_fade_controller.elapsed_sec;
    status->current_brightness = g_fade_controller.current_brightness;
    status->progress = g_fade_controller.progress;

    return ESP_OK;
}

esp_err_t light_alarm_fade_pause(void)
{
    if (g_fade_controller.state != LIGHT_ALARM_FADE_RUNNING) {
        return ESP_ERR_INVALID_STATE;
    }

    g_fade_controller.state = LIGHT_ALARM_FADE_PAUSED;

    if (g_fade_controller.timer != NULL) {
        xTimerStop(g_fade_controller.timer, 0);
    }

    ESP_LOGI(TAG, "Fade paused");
    return ESP_OK;
}

esp_err_t light_alarm_fade_resume(void)
{
    if (g_fade_controller.state != LIGHT_ALARM_FADE_PAUSED) {
        return ESP_ERR_INVALID_STATE;
    }

    g_fade_controller.state = LIGHT_ALARM_FADE_RUNNING;

    if (g_fade_controller.timer != NULL) {
        xTimerStart(g_fade_controller.timer, 0);
    }

    ESP_LOGI(TAG, "Fade resumed");
    return ESP_OK;
}

esp_err_t light_alarm_fade_stop(void)
{
    if (g_fade_controller.timer != NULL) {
        xTimerStop(g_fade_controller.timer, 0);
    }

    g_fade_controller.state = LIGHT_ALARM_FADE_IDLE;
    g_fade_controller.elapsed_sec = 0;
    g_fade_controller.current_brightness = 0;
    g_fade_controller.progress = 0;

    light_alarm_led_set_color(0, 0, 0, 0);

    ESP_LOGI(TAG, "Fade stopped");
    return ESP_OK;
}

esp_err_t light_alarm_set_event_callback(light_alarm_event_callback_t callback)
{
    g_event_callback = callback;
    return ESP_OK;
}

esp_err_t light_alarm_save_config(void)
{
    return light_alarm_config_save();
}

esp_err_t light_alarm_load_config(void)
{
    return light_alarm_config_load();
}

esp_err_t light_alarm_get_next_trigger(uint32_t alarm_id, uint32_t *next_trigger)
{
    if (next_trigger == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(g_alarm_manager.mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGE(TAG, "Failed to take mutex");
        return ESP_FAIL;
    }

    int index = light_alarm_find_index(alarm_id);
    if (index < 0) {
        ESP_LOGE(TAG, "Alarm %lu not found", alarm_id);
        xSemaphoreGive(g_alarm_manager.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    *next_trigger = g_alarm_manager.alarms[index].next_trigger;

    xSemaphoreGive(g_alarm_manager.mutex);

    return ESP_OK;
}

esp_err_t light_alarm_calc_next_trigger(const light_alarm_config_t *config,
                                         uint32_t current_time,
                                         uint32_t *next_trigger)
{
    if (config == NULL || next_trigger == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    struct tm *current_tm = localtime((time_t *)&current_time);
    struct tm next_tm = *current_tm;

    next_tm.tm_hour = config->time.hour;
    next_tm.tm_min = config->time.minute;
    next_tm.tm_sec = config->time.second;

    time_t next_time = mktime(&next_tm);

    if (next_time <= current_time) {
        next_time += 86400;
    }

    if (config->repeat == LIGHT_ALARM_REPEAT_ONCE) {
        *next_trigger = (uint32_t)next_time;
        return ESP_OK;
    }

    while (true) {
        struct tm *check_tm = localtime(&next_time);
        bool should_trigger = false;

        switch (config->repeat) {
            case LIGHT_ALARM_REPEAT_DAILY:
                should_trigger = true;
                break;

            case LIGHT_ALARM_REPEAT_WEEKDAY:
                should_trigger = (check_tm->tm_wday >= 1 && check_tm->tm_wday <= 5);
                break;

            case LIGHT_ALARM_REPEAT_WEEKEND:
                should_trigger = (check_tm->tm_wday == 0 || check_tm->tm_wday == 6);
                break;

            case LIGHT_ALARM_REPEAT_CUSTOM:
                should_trigger = (config->repeat_custom.weekday_mask & (1 << check_tm->tm_wday)) != 0;
                break;

            default:
                should_trigger = false;
                break;
        }

        if (should_trigger) {
            *next_trigger = (uint32_t)next_time;
            return ESP_OK;
        }

        next_time += 86400;
    }

    return ESP_OK;
}
