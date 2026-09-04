/**
 * 边缘报警引擎
 *
 * 功能：
 *   在设备本地执行报警检测，
 *   支持呼吸暂停、心率异常、体动异常等报警类型。
 *
 * 特性：
 *   - 本地实时检测（低延迟）
 *   - 可配置报警阈值
 *   - 报警去抖（避免误报）
 *   - 报警优先级管理
 *   - 与云端报警结果对比（双版本）
 */

#include "esp_log.h"
#include "esp_err.h"
#include <string.h>
#include <math.h>

static const char *TAG = "edge_alarm";

#define ALARM_BUFFER_SIZE 256
#define ALARM_DEBOUNCE_COUNT 3  // 连续 N 次检测到才触发报警
#define MAX_ALARM_TYPES 8

typedef enum {
    ALARM_TYPE_NONE = 0,
    ALARM_TYPE_APNEA = 1,           // 呼吸暂停
    ALARM_TYPE_HYPOPNEA = 2,        // 低通气
    ALARM_TYPE_TACHYCARDIA = 3,     // 心动过速
    ALARM_TYPE_BRADYCARDIA = 4,     // 心动过缓
    ALARM_TYPE_ARRHYTHMIA = 5,      // 心律失常
    ALARM_TYPE_RESTLESS = 6,        // 体动异常
    ALARM_TYPE_ABNORMAL_SPO2 = 7,   // 血氧异常
} alarm_type_t;

typedef enum {
    ALARM_PRIORITY_LOW = 0,
    ALARM_PRIORITY_MEDIUM = 1,
    ALARM_PRIORITY_HIGH = 2,
    ALARM_PRIORITY_CRITICAL = 3,
} alarm_priority_t;

typedef struct {
    alarm_type_t type;
    alarm_priority_t priority;
    float threshold;
    float hysteresis;
    uint8_t debounce_count;
    uint8_t current_count;
    bool triggered;
    uint32_t last_trigger_time;
    uint32_t trigger_count;
} alarm_detector_t;

typedef struct {
    bool initialized;
    alarm_detector_t detectors[MAX_ALARM_TYPES];
    uint8_t detector_count;
    uint32_t total_alarms;
    uint32_t false_alarms;
} edge_alarm_state_t;

static edge_alarm_state_t s_state = {0};

/**
 * 初始化边缘报警引擎
 */
esp_err_t edge_alarm_engine_init(void)
{
    ESP_LOGI(TAG, "初始化边缘报警引擎");

    memset(&s_state, 0, sizeof(s_state));
    s_state.initialized = true;

    // 注册默认报警检测器
    edge_alarm_engine_register(ALARM_TYPE_APNEA, ALARM_PRIORITY_HIGH,
                                 10.0, 2.0, ALARM_DEBOUNCE_COUNT);
    edge_alarm_engine_register(ALARM_TYPE_TACHYCARDIA, ALARM_PRIORITY_MEDIUM,
                                 100.0, 5.0, ALARM_DEBOUNCE_COUNT);
    edge_alarm_engine_register(ALARM_TYPE_BRADYCARDIA, ALARM_PRIORITY_MEDIUM,
                                 40.0, 5.0, ALARM_DEBOUNCE_COUNT);
    edge_alarm_engine_register(ALARM_TYPE_ABNORMAL_SPO2, ALARM_PRIORITY_HIGH,
                                 90.0, 2.0, ALARM_DEBOUNCE_COUNT);

    ESP_LOGI(TAG, "边缘报警引擎初始化完成，注册 %d 个检测器", s_state.detector_count);
    return ESP_OK;
}

/**
 * 注册报警检测器
 */
esp_err_t edge_alarm_engine_register(alarm_type_t type, alarm_priority_t priority,
                                       float threshold, float hysteresis, uint8_t debounce)
{
    if (!s_state.initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    if (s_state.detector_count >= MAX_ALARM_TYPES) {
        ESP_LOGE(TAG, "检测器数量已达上限");
        return ESP_ERR_NO_MEM;
    }

    alarm_detector_t *detector = &s_state.detectors[s_state.detector_count];
    detector->type = type;
    detector->priority = priority;
    detector->threshold = threshold;
    detector->hysteresis = hysteresis;
    detector->debounce_count = debounce;
    detector->current_count = 0;
    detector->triggered = false;
    detector->last_trigger_time = 0;
    detector->trigger_count = 0;

    s_state.detector_count++;
    ESP_LOGI(TAG, "注册检测器: 类型=%d, 优先级=%d, 阈值=%.2f", type, priority, threshold);

    return ESP_OK;
}

/**
 * 处理一帧数据，执行报警检测
 *
 * @param heart_rate 心率 (BPM)
 * @param respiration_rate 呼吸率 (次/分钟)
 * @param spo2 血氧饱和度 (%)
 * @param movement_index 体动指数
 * @param timestamp 时间戳
 * @param triggered_alarms 输出触发的报警类型数组
 * @param max_alarms 输出数组最大大小
 * @return 触发的报警数量
 */
uint8_t edge_alarm_engine_process(float heart_rate, float respiration_rate,
                                    float spo2, float movement_index,
                                    uint32_t timestamp,
                                    alarm_type_t *triggered_alarms, uint8_t max_alarms)
{
    if (!s_state.initialized || triggered_alarms == NULL) {
        return 0;
    }

    uint8_t triggered_count = 0;

    for (uint8_t i = 0; i < s_state.detector_count && triggered_count < max_alarms; i++) {
        alarm_detector_t *detector = &s_state.detectors[i];
        bool condition_met = false;

        // 根据报警类型检查条件
        switch (detector->type) {
            case ALARM_TYPE_APNEA:
                condition_met = (respiration_rate > 0 && respiration_rate < detector->threshold);
                break;
            case ALARM_TYPE_TACHYCARDIA:
                condition_met = (heart_rate > detector->threshold);
                break;
            case ALARM_TYPE_BRADYCARDIA:
                condition_met = (heart_rate > 0 && heart_rate < detector->threshold);
                break;
            case ALARM_TYPE_ABNORMAL_SPO2:
                condition_met = (spo2 > 0 && spo2 < detector->threshold);
                break;
            case ALARM_TYPE_RESTLESS:
                condition_met = (movement_index > detector->threshold);
                break;
            default:
                break;
        }

        // 去抖逻辑
        if (condition_met && !detector->triggered) {
            detector->current_count++;
            if (detector->current_count >= detector->debounce_count) {
                detector->triggered = true;
                detector->current_count = 0;
                detector->last_trigger_time = timestamp;
                detector->trigger_count++;
                s_state.total_alarms++;

                if (triggered_count < max_alarms) {
                    triggered_alarms[triggered_count++] = detector->type;
                }

                ESP_LOGW(TAG, "报警触发: 类型=%d, 优先级=%d, 计数=%lu",
                         detector->type, detector->priority,
                         (unsigned long)detector->trigger_count);
            }
        } else if (!condition_met && detector->triggered) {
            // 使用滞回恢复
            bool recovered = false;
            switch (detector->type) {
                case ALARM_TYPE_APNEA:
                    recovered = (respiration_rate >= detector->threshold + detector->hysteresis);
                    break;
                case ALARM_TYPE_TACHYCARDIA:
                    recovered = (heart_rate <= detector->threshold - detector->hysteresis);
                    break;
                case ALARM_TYPE_BRADYCARDIA:
                    recovered = (heart_rate >= detector->threshold + detector->hysteresis);
                    break;
                case ALARM_TYPE_ABNORMAL_SPO2:
                    recovered = (spo2 >= detector->threshold + detector->hysteresis);
                    break;
                default:
                    recovered = true;
                    break;
            }

            if (recovered) {
                detector->triggered = false;
                detector->current_count = 0;
                ESP_LOGI(TAG, "报警恢复: 类型=%d", detector->type);
            }
        } else if (!condition_met) {
            detector->current_count = 0;
        }
    }

    return triggered_count;
}

/**
 * 获取报警检测器状态
 */
void edge_alarm_engine_get_status(edge_alarm_status_t *status)
{
    if (status == NULL) return;

    status->initialized = s_state.initialized;
    status->detector_count = s_state.detector_count;
    status->total_alarms = s_state.total_alarms;
    status->active_alarms = 0;

    for (uint8_t i = 0; i < s_state.detector_count; i++) {
        if (s_state.detectors[i].triggered) {
            status->active_alarms++;
        }
    }
}

/**
 * 重置报警引擎状态
 */
void edge_alarm_engine_reset(void)
{
    for (uint8_t i = 0; i < s_state.detector_count; i++) {
        s_state.detectors[i].triggered = false;
        s_state.detectors[i].current_count = 0;
    }
    ESP_LOGI(TAG, "边缘报警引擎状态已重置");
}
