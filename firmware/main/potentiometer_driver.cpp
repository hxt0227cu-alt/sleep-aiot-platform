#include "potentiometer_driver.h"
#include "config.h"
#include "light_control.h"

#include <esp_log.h>
#include <driver/adc.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <string.h>
#include <stdlib.h>

static const char* TAG = "POT_DRIVER";
static const uint8_t POT_EFFECTIVE_DEADBAND = 5;
static const uint8_t POT_ARM_DELTA = 12;
static const uint8_t POT_OFF_THRESHOLD = 2;
static const uint8_t POT_MIN_ACTIVE_BRIGHTNESS = 6;
static const uint8_t POT_ARM_CONFIRM_SAMPLES = 3;
static const uint32_t POT_BOOT_IGNORE_MS = 3000;

static TaskHandle_t s_task = NULL;
static volatile bool s_running = false;
static bool s_initialized = false;
static bool s_manual_control_armed = false;
static potentiometer_state_t s_state = {50, 4000};
static potentiometer_change_callback_t s_callback = NULL;
static void* s_user_data = NULL;
static TickType_t s_ignore_until_tick = 0;
static uint8_t s_boot_observed_brightness = 0;
static uint8_t s_arm_candidate_brightness = 0;
static uint8_t s_arm_candidate_samples = 0;

static uint8_t raw_to_brightness(int raw) {
    if (raw < 0) raw = 0;
    if (raw > 4095) raw = 4095;
    return (uint8_t)((raw * LED_BRIGHTNESS_MAX) / 4095);
}

static uint8_t normalize_brightness(uint8_t brightness) {
    if (brightness <= POT_OFF_THRESHOLD) {
        return 0;
    }
    if (brightness < POT_MIN_ACTIVE_BRIGHTNESS) {
        return POT_MIN_ACTIVE_BRIGHTNESS;
    }
    return brightness;
}

static int smooth_read(adc1_channel_t channel) {
    int sum = 0;
    for (int i = 0; i < 16; ++i) {
        sum += adc1_get_raw(channel);
    }
    return sum / 16;
}

static bool changed_enough(const potentiometer_state_t* next) {
    int brightness_delta = abs((int)next->brightness - (int)s_state.brightness);
    return brightness_delta >= POT_EFFECTIVE_DEADBAND;
}

static bool manual_arm_requested(uint8_t brightness) {
    int arm_delta = abs((int)brightness - (int)s_boot_observed_brightness);
    if (arm_delta < POT_ARM_DELTA) {
        s_arm_candidate_samples = 0;
        return false;
    }

    if (brightness == s_arm_candidate_brightness) {
        if (s_arm_candidate_samples < POT_ARM_CONFIRM_SAMPLES) {
            ++s_arm_candidate_samples;
        }
    } else {
        s_arm_candidate_brightness = brightness;
        s_arm_candidate_samples = 1;
    }

    return s_arm_candidate_samples >= POT_ARM_CONFIRM_SAMPLES;
}

static void pot_task(void* arg) {
    (void)arg;
    ESP_LOGI(TAG, "Potentiometer task started");

    while (s_running) {
        light_config_t current = {};
        light_control_get_config(&current);

        potentiometer_state_t next = {
            normalize_brightness(raw_to_brightness(smooth_read(ADC_LIGHT_CHANNEL))),
            current.color_temp,
        };

        if (!s_manual_control_armed) {
            if (xTaskGetTickCount() < s_ignore_until_tick) {
                vTaskDelay(pdMS_TO_TICKS(POT_SAMPLE_INTERVAL_MS));
                continue;
            }

            if (manual_arm_requested(next.brightness)) {
                s_manual_control_armed = true;
                s_state = next;
                ESP_LOGI(TAG, "Potentiometer manual control armed at brightness=%u", s_state.brightness);
            } else {
                vTaskDelay(pdMS_TO_TICKS(POT_SAMPLE_INTERVAL_MS));
                continue;
            }
        }

        if (changed_enough(&next)) {
            s_state = next;

            if (next.brightness == 0) {
                light_control_off();
            } else {
                light_control_on();
                light_control_set_brightness(next.brightness);
            }

            if (s_callback != NULL) {
                s_callback(&s_state, s_user_data);
            }

            ESP_LOGD(TAG, "Manual light brightness=%u", s_state.brightness);
        }

        vTaskDelay(pdMS_TO_TICKS(POT_SAMPLE_INTERVAL_MS));
    }

    s_task = NULL;
    vTaskDelete(NULL);
}

bool potentiometer_driver_init(void) {
    if (s_initialized) {
        return true;
    }

    adc1_config_width(ADC_WIDTH_BIT_12);
    adc1_config_channel_atten(ADC_LIGHT_CHANNEL, ADC_ATTEN_DB_11);

    light_config_t current = {};
    light_control_get_config(&current);
    s_state.brightness = normalize_brightness(current.brightness);
    s_state.color_temp = current.color_temp;
    s_manual_control_armed = false;
    s_ignore_until_tick = xTaskGetTickCount() + pdMS_TO_TICKS(POT_BOOT_IGNORE_MS);
    s_boot_observed_brightness = normalize_brightness(raw_to_brightness(smooth_read(ADC_LIGHT_CHANNEL)));
    s_arm_candidate_brightness = 0;
    s_arm_candidate_samples = 0;
    s_initialized = true;

    ESP_LOGI(TAG, "Potentiometer ADC initialized: light GPIO%d", ADC_LIGHT_PIN);
    return true;
}

bool potentiometer_driver_start(void) {
    if (!s_initialized && !potentiometer_driver_init()) {
        return false;
    }
    if (s_running) {
        return true;
    }

    s_running = true;
    BaseType_t ok = xTaskCreatePinnedToCore(
        pot_task,
        "PotTask",
        3072,
        NULL,
        TASK_PRIORITY_LOW,
        &s_task,
        0
    );

    if (ok != pdPASS) {
        s_running = false;
        ESP_LOGE(TAG, "Failed to create potentiometer task");
        return false;
    }
    return true;
}

void potentiometer_driver_stop(void) {
    s_running = false;
}

void potentiometer_driver_set_callback(potentiometer_change_callback_t callback, void* user_data) {
    s_callback = callback;
    s_user_data = user_data;
}

void potentiometer_driver_get_state(potentiometer_state_t* state) {
    if (state != NULL) {
        memcpy(state, &s_state, sizeof(s_state));
    }
}
