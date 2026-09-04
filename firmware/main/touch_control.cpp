#include "touch_control.h"
#include "config.h"

#include <string.h>
#include "driver/touch_pad.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

static const char* TAG = "TOUCH_CONTROL";

typedef struct {
    touch_pad_t pad;
    touch_control_event_type_t short_event_type;
    bool has_long_event;
    touch_control_event_type_t long_event_type;
    const char* sound;
    const char* name;
    uint32_t baseline;
    bool active;
    bool long_sent;
    int64_t pressed_at_ms;
    int64_t last_event_ms;
} touch_button_t;

static touch_button_t s_buttons[] = {
    {(touch_pad_t)TOUCH_LIGHT_SCENE_PAD, TOUCH_CONTROL_EVENT_LIGHT_SCENE, true, TOUCH_CONTROL_EVENT_VOLUME_UP, NULL, "TOUCH9", 0, false, false, 0, 0},
    {(touch_pad_t)TOUCH_NOISE_RAIN_PAD, TOUCH_CONTROL_EVENT_NOISE_PLAY, false, TOUCH_CONTROL_EVENT_NOISE_PLAY, "rain", "TOUCH10", 0, false, false, 0, 0},
    {(touch_pad_t)TOUCH_NOISE_WIND_PAD, TOUCH_CONTROL_EVENT_NOISE_PLAY, false, TOUCH_CONTROL_EVENT_NOISE_PLAY, "wind", "TOUCH11", 0, false, false, 0, 0},
    {(touch_pad_t)TOUCH_NOISE_BIRD_PAD, TOUCH_CONTROL_EVENT_NOISE_PLAY, false, TOUCH_CONTROL_EVENT_NOISE_PLAY, "bird", "TOUCH12", 0, false, false, 0, 0},
    {(touch_pad_t)TOUCH_NOISE_THUNDER_PAD, TOUCH_CONTROL_EVENT_NOISE_PLAY, false, TOUCH_CONTROL_EVENT_NOISE_PLAY, "thunder", "TOUCH13", 0, false, false, 0, 0},
    {(touch_pad_t)TOUCH_NOISE_STOP_PAD, TOUCH_CONTROL_EVENT_NOISE_STOP, true, TOUCH_CONTROL_EVENT_VOLUME_DOWN, NULL, "TOUCH14", 0, false, false, 0, 0},
};

static TaskHandle_t s_task = NULL;
static SemaphoreHandle_t s_mutex = NULL;
static bool s_initialized = false;
static volatile bool s_running = false;
static touch_control_event_callback_t s_callback = NULL;
static void* s_user_data = NULL;
static uint8_t s_light_scene_index = 0;

static bool read_touch(touch_pad_t pad, uint32_t* value);
static uint32_t read_touch_average(touch_pad_t pad);
static bool is_touched(uint32_t raw, uint32_t baseline);
static void dispatch_event(touch_button_t* button, touch_control_event_type_t event_type);
static void touch_task(void* arg);

bool touch_control_init(void) {
    if (s_initialized) {
        return true;
    }

    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "Failed to create mutex");
        return false;
    }

    esp_err_t err = touch_pad_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "touch_pad_init failed: %s", esp_err_to_name(err));
        return false;
    }

    err = touch_pad_set_fsm_mode(TOUCH_FSM_MODE_TIMER);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "touch_pad_set_fsm_mode failed: %s", esp_err_to_name(err));
    }

    for (size_t i = 0; i < sizeof(s_buttons) / sizeof(s_buttons[0]); ++i) {
        err = touch_pad_config(s_buttons[i].pad);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "touch_pad_config %s failed: %s",
                     s_buttons[i].name, esp_err_to_name(err));
            return false;
        }
    }

    err = touch_pad_fsm_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "touch_pad_fsm_start failed: %s", esp_err_to_name(err));
        return false;
    }

    vTaskDelay(pdMS_TO_TICKS(TOUCH_BASELINE_SETTLE_MS));
    for (size_t i = 0; i < sizeof(s_buttons) / sizeof(s_buttons[0]); ++i) {
        s_buttons[i].baseline = read_touch_average(s_buttons[i].pad);
        ESP_LOGI(TAG, "%s baseline=%u", s_buttons[i].name, (unsigned)s_buttons[i].baseline);
    }

    s_initialized = true;
    return true;
}

bool touch_control_start(void) {
    if (!s_initialized && !touch_control_init()) {
        return false;
    }
    if (s_running) {
        return true;
    }

    s_running = true;
    BaseType_t ok = xTaskCreatePinnedToCore(
        touch_task,
        "TouchCtrl",
        4096,
        NULL,
        TASK_PRIORITY_LOW,
        &s_task,
        0
    );

    if (ok != pdPASS) {
        s_running = false;
        s_task = NULL;
        ESP_LOGE(TAG, "Failed to create touch task");
        return false;
    }
    return true;
}

void touch_control_stop(void) {
    s_running = false;
}

void touch_control_set_event_callback(touch_control_event_callback_t callback, void* user_data) {
    if (s_mutex != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
    }
    s_callback = callback;
    s_user_data = user_data;
    if (s_mutex != NULL) {
        xSemaphoreGive(s_mutex);
    }
}

static bool read_touch(touch_pad_t pad, uint32_t* value) {
    if (value == NULL) {
        return false;
    }
    esp_err_t err = touch_pad_read_raw_data(pad, value);
    return err == ESP_OK;
}

static uint32_t read_touch_average(touch_pad_t pad) {
    uint64_t sum = 0;
    uint32_t raw = 0;
    int samples = 0;

    for (int i = 0; i < TOUCH_BASELINE_SAMPLES; ++i) {
        if (read_touch(pad, &raw) && raw > 0) {
            sum += raw;
            samples++;
        }
        vTaskDelay(pdMS_TO_TICKS(8));
    }

    if (samples == 0) {
        return 0;
    }
    return (uint32_t)(sum / (uint32_t)samples);
}

static bool is_touched(uint32_t raw, uint32_t baseline) {
    if (raw == 0 || baseline == 0) {
        return false;
    }

    uint32_t threshold = baseline / 6;
    if (threshold < TOUCH_MIN_DELTA) {
        threshold = TOUCH_MIN_DELTA;
    }

    return raw > baseline + threshold || raw + threshold < baseline;
}

static void dispatch_event(touch_button_t* button, touch_control_event_type_t event_type) {
    touch_control_event_callback_t callback = NULL;
    void* user_data = NULL;
    touch_control_event_t event = {};

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    callback = s_callback;
    user_data = s_user_data;
    event.type = event_type;
    event.sound = button->sound;
    if (event_type == TOUCH_CONTROL_EVENT_LIGHT_SCENE) {
        event.scene_index = s_light_scene_index;
        s_light_scene_index = (uint8_t)((s_light_scene_index + 1) % 3);
    }
    xSemaphoreGive(s_mutex);

    if (callback != NULL) {
        callback(&event, user_data);
    }
}

static void touch_task(void* arg) {
    (void)arg;
    ESP_LOGI(TAG, "Touch control task started");

    while (s_running) {
        int64_t now_ms = esp_timer_get_time() / 1000;

        for (size_t i = 0; i < sizeof(s_buttons) / sizeof(s_buttons[0]); ++i) {
            uint32_t raw = 0;
            if (!read_touch(s_buttons[i].pad, &raw)) {
                continue;
            }

            bool touched = is_touched(raw, s_buttons[i].baseline);
            if (touched && !s_buttons[i].active &&
                now_ms - s_buttons[i].last_event_ms >= TOUCH_DEBOUNCE_MS) {
                s_buttons[i].active = true;
                s_buttons[i].long_sent = false;
                s_buttons[i].pressed_at_ms = now_ms;
                ESP_LOGI(TAG, "%s press start raw=%u baseline=%u",
                         s_buttons[i].name, (unsigned)raw, (unsigned)s_buttons[i].baseline);
            } else if (touched && s_buttons[i].active &&
                       s_buttons[i].has_long_event &&
                       !s_buttons[i].long_sent &&
                       now_ms - s_buttons[i].pressed_at_ms >= TOUCH_LONG_PRESS_MS) {
                s_buttons[i].long_sent = true;
                s_buttons[i].last_event_ms = now_ms;
                ESP_LOGI(TAG, "%s long press", s_buttons[i].name);
                dispatch_event(&s_buttons[i], s_buttons[i].long_event_type);
            } else if (!touched) {
                if (s_buttons[i].active) {
                    int64_t held_ms = now_ms - s_buttons[i].pressed_at_ms;
                    if (!s_buttons[i].long_sent) {
                        s_buttons[i].last_event_ms = now_ms;
                        ESP_LOGI(TAG, "%s short press held=%lldms",
                                 s_buttons[i].name, (long long)held_ms);
                        dispatch_event(&s_buttons[i], s_buttons[i].short_event_type);
                    }
                }
                s_buttons[i].active = false;
                s_buttons[i].long_sent = false;
                s_buttons[i].pressed_at_ms = 0;
                if (raw > 0 && s_buttons[i].baseline > 0) {
                    s_buttons[i].baseline = (s_buttons[i].baseline * 31U + raw) / 32U;
                }
            }
        }

        vTaskDelay(pdMS_TO_TICKS(TOUCH_SAMPLE_INTERVAL_MS));
    }

    s_task = NULL;
    vTaskDelete(NULL);
}
