/**
 * @file light_alarm.h
 * @brief 光闹钟服务头文件
 * @details 提供光闹钟管理、渐变唤醒、定时任务等功能
 * @version 1.0
 * @date 2026-03-26
 */

#ifndef LIGHT_ALARM_H
#define LIGHT_ALARM_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ==================== 宏定义 ==================== */

/** 最大闹钟数量 */
#define LIGHT_ALARM_MAX_COUNT          8

/** 闹钟名称最大长度 */
#define LIGHT_ALARM_NAME_MAX_LEN      32

/** 渐变时长范围（秒） */
#define LIGHT_ALARM_FADE_MIN_SEC      60
#define LIGHT_ALARM_FADE_MAX_SEC      1800

/** LED亮度范围（0-255） */
#define LIGHT_ALARM_BRIGHTNESS_MIN    0
#define LIGHT_ALARM_BRIGHTNESS_MAX    255

/** 默认渐变时长（秒） */
#define LIGHT_ALARM_DEFAULT_FADE_SEC  600

/** 默认目标亮度 */
#define LIGHT_ALARM_DEFAULT_BRIGHTNESS 200

/* ==================== 枚举定义 ==================== */

/**
 * @brief 闹钟重复周期
 */
typedef enum {
    LIGHT_ALARM_REPEAT_ONCE = 0,      /**< 单次 */
    LIGHT_ALARM_REPEAT_DAILY,         /**< 每天 */
    LIGHT_ALARM_REPEAT_WEEKDAY,       /**< 工作日（周一至周五） */
    LIGHT_ALARM_REPEAT_WEEKEND,       /**< 周末（周六、周日） */
    LIGHT_ALARM_REPEAT_CUSTOM,        /**< 自定义 */
} light_alarm_repeat_t;

/**
 * @brief 唤醒模式
 */
typedef enum {
    LIGHT_ALARM_MODE_FADE_ONLY = 0,   /**< 仅渐变光 */
    LIGHT_ALARM_MODE_FADE_SOUND,       /**< 渐变光+声音 */
    LIGHT_ALARM_MODE_FADE_VIBRATE,     /**< 渐变光+振动 */
    LIGHT_ALARM_MODE_FADE_ALL,        /**< 渐变光+声音+振动 */
} light_alarm_mode_t;

/**
 * @brief 闹钟状态
 */
typedef enum {
    LIGHT_ALARM_STATE_DISABLED = 0,    /**< 禁用 */
    LIGHT_ALARM_STATE_ENABLED,         /**< 启用 */
    LIGHT_ALARM_STATE_TRIGGERED,       /**< 已触发 */
    LIGHT_ALARM_STATE_SNOOZED,         /**< 已贪睡 */
} light_alarm_state_t;

/**
 * @brief 渐变状态
 */
typedef enum {
    LIGHT_ALARM_FADE_IDLE = 0,          /**< 空闲 */
    LIGHT_ALARM_FADE_RUNNING,          /**< 运行中 */
    LIGHT_ALARM_FADE_PAUSED,            /**< 暂停 */
    LIGHT_ALARM_FADE_COMPLETED,        /**< 完成 */
} light_alarm_fade_state_t;

/**
 * @brief 闹钟事件类型
 */
typedef enum {
    LIGHT_ALARM_EVENT_TRIGGERED = 0,    /**< 闹钟触发 */
    LIGHT_ALARM_EVENT_FADE_START,       /**< 渐变开始 */
    LIGHT_ALARM_EVENT_FADE_PROGRESS,    /**< 渐变进度更新 */
    LIGHT_ALARM_EVENT_FADE_COMPLETE,    /**< 渐变完成 */
    LIGHT_ALARM_EVENT_SNOOZE,          /**< 贪睡 */
    LIGHT_ALARM_EVENT_DISMISS,          /**< 关闭 */
} light_alarm_event_t;

/* ==================== 结构体定义 ==================== */

/**
 * @brief 闹钟时间配置
 */
typedef struct {
    uint8_t hour;                       /**< 小时（0-23） */
    uint8_t minute;                     /**< 分钟（0-59） */
    uint8_t second;                     /**< 秒（0-59） */
} light_alarm_time_t;

/**
 * @brief 自定义重复周期（星期掩码）
 * @details bit0=周日, bit1=周一, ..., bit6=周六
 */
typedef struct {
    uint8_t weekday_mask;               /**< 星期掩码 */
} light_alarm_repeat_custom_t;

/**
 * @brief 渐变配置
 */
typedef struct {
    uint16_t duration_sec;              /**< 渐变时长（秒） */
    uint8_t start_brightness;           /**< 起始亮度（0-255） */
    uint8_t target_brightness;          /**< 目标亮度（0-255） */
    uint8_t color_r;                    /**< RGB红色分量（0-255） */
    uint8_t color_g;                    /**< RGB绿色分量（0-255） */
    uint8_t color_b;                    /**< RGB蓝色分量（0-255） */
} light_alarm_fade_config_t;

/**
 * @brief 闹钟配置
 */
typedef struct {
    uint32_t id;                        /**< 闹钟ID（唯一标识） */
    char name[LIGHT_ALARM_NAME_MAX_LEN]; /**< 闹钟名称 */
    light_alarm_time_t time;            /**< 触发时间 */
    light_alarm_repeat_t repeat;        /**< 重复周期 */
    light_alarm_repeat_custom_t repeat_custom; /**< 自定义重复周期 */
    light_alarm_mode_t mode;            /**< 唤醒模式 */
    light_alarm_fade_config_t fade;     /**< 渐变配置 */
    light_alarm_state_t state;          /**< 闹钟状态 */
    bool enabled;                       /**< 是否启用 */
    uint32_t last_triggered;            /**< 上次触发时间戳（Unix时间） */
    uint32_t next_trigger;              /**< 下次触发时间戳（Unix时间） */
} light_alarm_config_t;

/**
 * @brief 渐变状态信息
 */
typedef struct {
    light_alarm_fade_state_t state;     /**< 渐变状态 */
    uint32_t start_time;                /**< 开始时间戳 */
    uint32_t elapsed_sec;               /**< 已经过时间（秒） */
    uint8_t current_brightness;         /**< 当前亮度 */
    uint8_t progress;                   /**< 进度（0-100） */
} light_alarm_fade_status_t;

/**
 * @brief 闹钟事件回调函数类型
 * @param event 事件类型
 * @param alarm_id 闹钟ID
 * @param data 事件数据（可选）
 * @param data_len 数据长度
 */
typedef void (*light_alarm_event_callback_t)(light_alarm_event_t event, 
                                               uint32_t alarm_id,
                                               const void *data,
                                               size_t data_len);

/* ==================== API函数声明 ==================== */

/**
 * @brief 初始化光闹钟服务
 * @details 初始化NVS存储、RTC定时器、LED驱动等
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
esp_err_t light_alarm_init(void);

/**
 * @brief 反初始化光闹钟服务
 * @return ESP_OK 成功
 */
esp_err_t light_alarm_deinit(void);

/**
 * @brief 启动光闹钟服务
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
esp_err_t light_alarm_start(void);

/**
 * @brief 停止光闹钟服务
 * @return ESP_OK 成功
 */
esp_err_t light_alarm_stop(void);

/**
 * @brief 添加闹钟
 * @param config 闹钟配置
 * @param alarm_id 返回的闹钟ID
 * @return ESP_OK 成功
 * @return ESP_ERR_INVALID_ARG 参数无效
 * @return ESP_ERR_NO_MEM 闹钟数量已达上限
 */
esp_err_t light_alarm_add(const light_alarm_config_t *config, uint32_t *alarm_id);

/**
 * @brief 删除闹钟
 * @param alarm_id 闹钟ID
 * @return ESP_OK 成功
 * @return ESP_ERR_NOT_FOUND 闹钟不存在
 */
esp_err_t light_alarm_remove(uint32_t alarm_id);

/**
 * @brief 修改闹钟配置
 * @param alarm_id 闹钟ID
 * @param config 新的闹钟配置
 * @return ESP_OK 成功
 * @return ESP_ERR_NOT_FOUND 闹钟不存在
 */
esp_err_t light_alarm_update(uint32_t alarm_id, const light_alarm_config_t *config);

/**
 * @brief 获取闹钟配置
 * @param alarm_id 闹钟ID
 * @param config 返回的闹钟配置
 * @return ESP_OK 成功
 * @return ESP_ERR_NOT_FOUND 闹钟不存在
 */
esp_err_t light_alarm_get(uint32_t alarm_id, light_alarm_config_t *config);

/**
 * @brief 获取所有闹钟
 * @param alarms 闹钟数组
 * @param max_count 数组最大容量
 * @param count 返回的闹钟数量
 * @return ESP_OK 成功
 */
esp_err_t light_alarm_get_all(light_alarm_config_t *alarms, 
                               size_t max_count, 
                               size_t *count);

/**
 * @brief 启用闹钟
 * @param alarm_id 闹钟ID
 * @return ESP_OK 成功
 * @return ESP_ERR_NOT_FOUND 闹钟不存在
 */
esp_err_t light_alarm_enable(uint32_t alarm_id);

/**
 * @brief 禁用闹钟
 * @param alarm_id 闹钟ID
 * @return ESP_OK 成功
 * @return ESP_ERR_NOT_FOUND 闹钟不存在
 */
esp_err_t light_alarm_disable(uint32_t alarm_id);

/**
 * @brief 触发闹钟（手动触发）
 * @param alarm_id 闹钟ID
 * @return ESP_OK 成功
 * @return ESP_ERR_NOT_FOUND 闹钟不存在
 */
esp_err_t light_alarm_trigger(uint32_t alarm_id);

/**
 * @brief 贪睡闹钟
 * @param alarm_id 闹钟ID
 * @param snooze_minutes 贪睡时长（分钟）
 * @return ESP_OK 成功
 * @return ESP_ERR_NOT_FOUND 闹钟不存在
 */
esp_err_t light_alarm_snooze(uint32_t alarm_id, uint8_t snooze_minutes);

/**
 * @brief 关闭闹钟
 * @param alarm_id 闹钟ID
 * @return ESP_OK 成功
 * @return ESP_ERR_NOT_FOUND 闹钟不存在
 */
esp_err_t light_alarm_dismiss(uint32_t alarm_id);

/**
 * @brief 获取渐变状态
 * @param status 返回的渐变状态
 * @return ESP_OK 成功
 */
esp_err_t light_alarm_get_fade_status(light_alarm_fade_status_t *status);

/**
 * @brief 暂停渐变
 * @return ESP_OK 成功
 * @return ESP_ERR_INVALID_STATE 状态不允许暂停
 */
esp_err_t light_alarm_fade_pause(void);

/**
 * @brief 恢复渐变
 * @return ESP_OK 成功
 * @return ESP_ERR_INVALID_STATE 状态不允许恢复
 */
esp_err_t light_alarm_fade_resume(void);

/**
 * @brief 停止渐变
 * @return ESP_OK 成功
 */
esp_err_t light_alarm_fade_stop(void);

/**
 * @brief 设置事件回调函数
 * @param callback 回调函数
 * @return ESP_OK 成功
 */
esp_err_t light_alarm_set_event_callback(light_alarm_event_callback_t callback);

/**
 * @brief 保存闹钟配置到NVS
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
esp_err_t light_alarm_save_config(void);

/**
 * @brief 从NVS加载闹钟配置
 * @return ESP_OK 成功
 * @return ESP_FAIL 失败
 */
esp_err_t light_alarm_load_config(void);

/**
 * @brief 获取下次触发时间
 * @param alarm_id 闹钟ID
 * @param next_trigger 返回的下次触发时间戳
 * @return ESP_OK 成功
 * @return ESP_ERR_NOT_FOUND 闹钟不存在
 */
esp_err_t light_alarm_get_next_trigger(uint32_t alarm_id, uint32_t *next_trigger);

/**
 * @brief 计算下次触发时间
 * @param config 闹钟配置
 * @param current_time 当前时间戳
 * @param next_trigger 返回的下次触发时间戳
 * @return ESP_OK 成功
 * @return ESP_ERR_INVALID_ARG 参数无效
 */
esp_err_t light_alarm_calc_next_trigger(const light_alarm_config_t *config,
                                         uint32_t current_time,
                                         uint32_t *next_trigger);

#ifdef __cplusplus
}
#endif

#endif /* LIGHT_ALARM_H */
