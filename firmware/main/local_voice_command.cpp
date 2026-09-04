#include "local_voice_command.h"
#include "config.h"

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <string.h>

#include "esp_mn_models.h"
#include "esp_mn_speech_commands.h"
#include "esp_wn_models.h"
#include "model_path.h"

static const char* TAG = "LOCAL_VOICE";
static const char* VOICE_WAKE_WORD_ID = "hiesp";

typedef enum {
    VOICE_CMD_LIGHT_ON = 1,
    VOICE_CMD_LIGHT_OFF = 2,
    VOICE_CMD_BRIGHTER = 3,
    VOICE_CMD_DIMMER = 4,
    VOICE_CMD_COOLER = 5,
    VOICE_CMD_WARMER = 6,
    VOICE_CMD_SLEEP = 7,
    VOICE_CMD_READING = 8,
    VOICE_CMD_NOISE_START = 9,
    VOICE_CMD_NOISE_RAIN = 10,
    VOICE_CMD_NOISE_WIND = 11,
    VOICE_CMD_NOISE_BIRD = 12,
    VOICE_CMD_NOISE_THUNDER = 13,
    VOICE_CMD_NOISE_STOP = 14,
    VOICE_CMD_SLEEP_REPORT = 15,
} voice_command_id_t;

typedef enum {
    VOICE_STATE_WAIT_WAKE = 0,
    VOICE_STATE_COMMAND,
} voice_state_t;

typedef struct {
    int id;
    const char* label;
    const char* phrase;
    const char* command;
    const char* params_json;
} voice_phrase_t;

static const voice_phrase_t VOICE_PHRASES[] = {
    {VOICE_CMD_LIGHT_ON, "light_on", "da kai tai deng", "light_control", "{\"power\":true,\"source\":\"voice\"}"},
    {VOICE_CMD_LIGHT_ON, "light_on", "kai deng", "light_control", "{\"power\":true,\"source\":\"voice\"}"},
    {VOICE_CMD_LIGHT_ON, "light_on", "da kai deng", "light_control", "{\"power\":true,\"source\":\"voice\"}"},
    {VOICE_CMD_LIGHT_OFF, "light_off", "guan bi tai deng", "light_control", "{\"power\":false,\"source\":\"voice\"}"},
    {VOICE_CMD_LIGHT_OFF, "light_off", "guan deng", "light_control", "{\"power\":false,\"source\":\"voice\"}"},
    {VOICE_CMD_BRIGHTER, "brightness_up", "tiao liang yi dian", "light_control", "{\"brightness_delta\":10,\"source\":\"voice\"}"},
    {VOICE_CMD_BRIGHTER, "brightness_up", "zeng jia liang du", "light_control", "{\"brightness_delta\":10,\"source\":\"voice\"}"},
    {VOICE_CMD_DIMMER, "brightness_down", "tiao an yi dian", "light_control", "{\"brightness_delta\":-10,\"source\":\"voice\"}"},
    {VOICE_CMD_DIMMER, "brightness_down", "jiang di liang du", "light_control", "{\"brightness_delta\":-10,\"source\":\"voice\"}"},
    {VOICE_CMD_COOLER, "color_temp_cooler", "tiao leng yi dian", "light_control", "{\"color_temp_delta\":300,\"source\":\"voice\"}"},
    {VOICE_CMD_COOLER, "color_temp_cooler", "se wen tiao leng", "light_control", "{\"color_temp_delta\":300,\"source\":\"voice\"}"},
    {VOICE_CMD_WARMER, "color_temp_warmer", "tiao nuan yi dian", "light_control", "{\"color_temp_delta\":-300,\"source\":\"voice\"}"},
    {VOICE_CMD_WARMER, "color_temp_warmer", "se wen tiao nuan", "light_control", "{\"color_temp_delta\":-300,\"source\":\"voice\"}"},
    {VOICE_CMD_SLEEP, "scene_sleep", "shui mian mo shi", "light_control", "{\"scene\":\"sleep\",\"source\":\"voice\"}"},
    {VOICE_CMD_READING, "scene_reading", "yue du mo shi", "light_control", "{\"scene\":\"reading\",\"source\":\"voice\"}"},
    {VOICE_CMD_LIGHT_ON, "light_on", "da kai deng guang", "light_control", "{\"power\":true,\"source\":\"voice\"}"},
    {VOICE_CMD_LIGHT_OFF, "light_off", "guan bi deng guang", "light_control", "{\"power\":false,\"source\":\"voice\"}"},
    {VOICE_CMD_NOISE_START, "noise_default", "bo fang bai zao yin", "audio_control", "{\"action\":\"play\",\"sound\":\"rain\",\"source\":\"voice\"}"},
    {VOICE_CMD_NOISE_START, "noise_default", "da kai bai zao yin", "audio_control", "{\"action\":\"play\",\"sound\":\"rain\",\"source\":\"voice\"}"},
    {VOICE_CMD_NOISE_RAIN, "noise_rain", "bo fang yu sheng", "audio_control", "{\"action\":\"play\",\"sound\":\"rain\",\"source\":\"voice\"}"},
    {VOICE_CMD_NOISE_WIND, "noise_wind", "bo fang feng sheng", "audio_control", "{\"action\":\"play\",\"sound\":\"wind\",\"source\":\"voice\"}"},
    {VOICE_CMD_NOISE_BIRD, "noise_bird", "bo fang niao jiao", "audio_control", "{\"action\":\"play\",\"sound\":\"bird\",\"source\":\"voice\"}"},
    {VOICE_CMD_NOISE_THUNDER, "noise_thunder", "bo fang lei sheng", "audio_control", "{\"action\":\"play\",\"sound\":\"thunder\",\"source\":\"voice\"}"},
    {VOICE_CMD_NOISE_STOP, "noise_stop", "ting zhi bai zao yin", "audio_control", "{\"action\":\"stop\",\"source\":\"voice\"}"},
    {VOICE_CMD_SLEEP_REPORT, "sleep_report", "wo zuo tian wan shang shui de zen me yang", "voice_query", "{\"query\":\"我昨天晚上睡得怎么样？\",\"query_type\":\"sleep_report\",\"report_date\":\"yesterday\",\"source\":\"voice\",\"require_online\":true}"},
    {VOICE_CMD_SLEEP_REPORT, "sleep_report", "zuo tian wan shang shui de zen me yang", "voice_query", "{\"query\":\"我昨天晚上睡得怎么样？\",\"query_type\":\"sleep_report\",\"report_date\":\"yesterday\",\"source\":\"voice\",\"require_online\":true}"},
    {VOICE_CMD_SLEEP_REPORT, "sleep_report", "zuo wan shui de zen me yang", "voice_query", "{\"query\":\"我昨天晚上睡得怎么样？\",\"query_type\":\"sleep_report\",\"report_date\":\"yesterday\",\"source\":\"voice\",\"require_online\":true}"},
    {VOICE_CMD_SLEEP_REPORT, "sleep_report", "shui mian bao gao", "voice_query", "{\"query\":\"请告诉我昨天晚上的睡眠报告。\",\"query_type\":\"sleep_report\",\"report_date\":\"yesterday\",\"source\":\"voice\",\"require_online\":true}"},
};

static local_voice_command_callback_t s_callback = NULL;
static void* s_user_data = NULL;
static local_voice_event_callback_t s_event_callback = NULL;
static void* s_event_user_data = NULL;
static SemaphoreHandle_t s_lock = NULL;

static srmodel_list_t* s_models = NULL;
static const esp_wn_iface_t* s_wn = NULL;
static model_iface_data_t* s_wn_data = NULL;
static esp_mn_iface_t* s_mn = NULL;
static model_iface_data_t* s_mn_data = NULL;

static voice_state_t s_state = VOICE_STATE_WAIT_WAKE;
static int16_t* s_frame = NULL;
static int s_frame_capacity = 0;
static int s_frame_fill = 0;
static int s_wn_chunksize = 0;
static int s_mn_chunksize = 0;
static bool s_ready = false;
static char s_last_command[32] = "";
static char s_last_error[96] = "";

static const voice_phrase_t* find_phrase_by_id(int command_id);
static void update_last_command(const char* label);
static void update_last_error(const char* error);
static void notify_event(local_voice_event_t event, const char* detail);
static void dispatch_command(int command_id);
static bool add_multinet_commands(void);
static int16_t convert_i2s_sample(int32_t sample);
static void process_frame(void);

static const voice_phrase_t* find_phrase_by_id(int command_id) {
    for (size_t i = 0; i < sizeof(VOICE_PHRASES) / sizeof(VOICE_PHRASES[0]); ++i) {
        if (VOICE_PHRASES[i].id == command_id) {
            return &VOICE_PHRASES[i];
        }
    }
    return NULL;
}

static void update_last_command(const char* label) {
    if (label == NULL) {
        label = "";
    }
    strncpy(s_last_command, label, sizeof(s_last_command) - 1);
    s_last_command[sizeof(s_last_command) - 1] = '\0';
}

static void update_last_error(const char* error) {
    if (error == NULL) {
        error = "";
    }
    strncpy(s_last_error, error, sizeof(s_last_error) - 1);
    s_last_error[sizeof(s_last_error) - 1] = '\0';
}

static void notify_event(local_voice_event_t event, const char* detail) {
    if (s_event_callback != NULL) {
        s_event_callback(event, detail, s_event_user_data);
    }
}

static void dispatch_command(int command_id) {
    const voice_phrase_t* phrase = find_phrase_by_id(command_id);
    if (phrase == NULL) {
        return;
    }

    update_last_command(phrase->label);
    notify_event(LOCAL_VOICE_EVENT_COMMAND_DETECTED, phrase->label);

    if (s_callback != NULL) {
        ESP_LOGI(TAG, "ESP-SR command id=%d label=%s params=%s",
                 command_id,
                 phrase->label,
                 phrase->params_json);
        s_callback(phrase->command, phrase->params_json, s_user_data);
    }
}

static bool add_multinet_commands(void) {
    if (esp_mn_commands_alloc(s_mn, s_mn_data) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to allocate MultiNet command list");
        return false;
    }

    for (size_t i = 0; i < sizeof(VOICE_PHRASES) / sizeof(VOICE_PHRASES[0]); ++i) {
        esp_err_t err = esp_mn_commands_add(VOICE_PHRASES[i].id, VOICE_PHRASES[i].phrase);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to add phrase '%s': %s",
                     VOICE_PHRASES[i].phrase,
                     esp_err_to_name(err));
        }
    }

    esp_mn_error_t* command_errors = esp_mn_commands_update();
    if (command_errors != NULL && command_errors->num > 0) {
        ESP_LOGW(TAG, "MultiNet rejected %d phrase(s)", command_errors->num);
    }
    esp_mn_commands_print();
    esp_mn_active_commands_print();
    return true;
}

bool local_voice_command_init(void) {
    s_ready = false;
    update_last_command("");
    update_last_error("");

    if (s_lock == NULL) {
        s_lock = xSemaphoreCreateMutex();
        if (s_lock == NULL) {
            ESP_LOGE(TAG, "Failed to create voice mutex");
            update_last_error("voice_mutex_create_failed");
            return false;
        }
    }

    s_models = esp_srmodel_init("model");
    if (s_models == NULL || s_models->num <= 0) {
        ESP_LOGE(TAG, "No ESP-SR model found in 'model' partition");
        update_last_error("model_partition_missing");
        return false;
    }

    char* wn_name = esp_srmodel_filter(s_models, ESP_WN_PREFIX, VOICE_WAKE_WORD_ID);
    if (wn_name == NULL) {
        wn_name = esp_srmodel_filter(s_models, ESP_WN_PREFIX, NULL);
    }
    char* mn_name = esp_srmodel_filter(s_models, ESP_MN_PREFIX, ESP_MN_CHINESE);

    if (wn_name == NULL || mn_name == NULL) {
        ESP_LOGE(TAG, "Missing ESP-SR models: WakeNet=%s MultiNet=%s",
                 wn_name ? wn_name : "NULL",
                 mn_name ? mn_name : "NULL");
        update_last_error("voice_model_missing");
        return false;
    }

    s_wn = esp_wn_handle_from_name(wn_name);
    s_mn = esp_mn_handle_from_name(mn_name);
    if (s_wn == NULL || s_mn == NULL) {
        ESP_LOGE(TAG, "Failed to get ESP-SR model handles");
        update_last_error("voice_model_handle_failed");
        return false;
    }

    s_wn_data = s_wn->create(wn_name, DET_MODE_90);
    s_mn_data = s_mn->create(mn_name, 6000);
    if (s_wn_data == NULL || s_mn_data == NULL) {
        ESP_LOGE(TAG, "Failed to create ESP-SR model instances");
        update_last_error("voice_model_create_failed");
        return false;
    }

    if (s_mn->switch_loader_mode != NULL) {
        s_mn_data = s_mn->switch_loader_mode(s_mn_data, ESP_MN_LOAD_FROM_PSRAM_FLASH);
    }

    s_wn_chunksize = s_wn->get_samp_chunksize(s_wn_data);
    s_mn_chunksize = s_mn->get_samp_chunksize(s_mn_data);
    s_frame_capacity = s_wn_chunksize > s_mn_chunksize ? s_wn_chunksize : s_mn_chunksize;
    s_frame = (int16_t*)heap_caps_calloc(
        s_frame_capacity,
        sizeof(int16_t),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
    );
    if (s_frame == NULL) {
        s_frame = (int16_t*)heap_caps_calloc(
            s_frame_capacity,
            sizeof(int16_t),
            MALLOC_CAP_8BIT
        );
    }
    if (s_frame == NULL) {
        ESP_LOGE(TAG, "Failed to allocate ESP-SR audio frame");
        update_last_error("voice_frame_alloc_failed");
        return false;
    }

    if (!add_multinet_commands()) {
        update_last_error("voice_command_list_failed");
        return false;
    }

    s_ready = true;
    update_last_error("");
    ESP_LOGI(TAG, "ESP-SR ready: wake=%s words=%s mn=%s wn_chunk=%d mn_chunk=%d",
             wn_name,
             esp_srmodel_get_wake_words(s_models, wn_name),
             mn_name,
             s_wn_chunksize,
             s_mn_chunksize);
    return true;
}

void local_voice_command_set_callback(local_voice_command_callback_t callback, void* user_data) {
    s_callback = callback;
    s_user_data = user_data;
}

void local_voice_command_set_event_callback(local_voice_event_callback_t callback, void* user_data) {
    s_event_callback = callback;
    s_event_user_data = user_data;
}

bool local_voice_command_handle_text(const char* text) {
    if (text == NULL) {
        return false;
    }

    for (size_t i = 0; i < sizeof(VOICE_PHRASES) / sizeof(VOICE_PHRASES[0]); ++i) {
        if (strstr(text, VOICE_PHRASES[i].phrase) != NULL) {
            dispatch_command(VOICE_PHRASES[i].id);
            return true;
        }
    }

    return false;
}

static int16_t convert_i2s_sample(int32_t sample) {
    return (int16_t)(sample >> 16);
}

static void process_frame(void) {
    if (s_state == VOICE_STATE_WAIT_WAKE) {
        wakenet_state_t wake = s_wn->detect(s_wn_data, s_frame);
        if (wake == WAKENET_DETECTED) {
            ESP_LOGI(TAG, "WakeNet detected wake word, listening for command");
            s_state = VOICE_STATE_COMMAND;
            s_frame_fill = 0;
            s_mn->clean(s_mn_data);
            notify_event(LOCAL_VOICE_EVENT_WAKE_WORD, VOICE_WAKE_WORD_ID);
        }
        return;
    }

    esp_mn_state_t mn_state = s_mn->detect(s_mn_data, s_frame);
    if (mn_state == ESP_MN_STATE_DETECTED) {
        esp_mn_results_t* results = s_mn->get_results(s_mn_data);
        if (results != NULL && results->num > 0) {
            ESP_LOGI(TAG, "MultiNet detected id=%d phrase='%s' prob=%.3f raw='%s'",
                     results->command_id[0],
                     esp_mn_commands_get_string(results->command_id[0]),
                     results->prob[0],
                     results->raw_string);
            dispatch_command(results->command_id[0]);
        }
        s_state = VOICE_STATE_WAIT_WAKE;
        s_frame_fill = 0;
        s_wn->clean(s_wn_data);
    } else if (mn_state == ESP_MN_STATE_TIMEOUT) {
        ESP_LOGI(TAG, "MultiNet command window timed out");
        s_state = VOICE_STATE_WAIT_WAKE;
        s_frame_fill = 0;
        s_wn->clean(s_wn_data);
        notify_event(LOCAL_VOICE_EVENT_COMMAND_TIMEOUT, "command_timeout");
    }
}

void local_voice_command_mic_callback(const int32_t* data, uint32_t len, void* user_data) {
    (void)user_data;
    if (data == NULL || len == 0 || s_frame == NULL || s_wn == NULL || s_mn == NULL) {
        return;
    }

    if (xSemaphoreTake(s_lock, 0) != pdTRUE) {
        return;
    }

    uint32_t index = 0;
    while (index < len) {
        int target = (s_state == VOICE_STATE_WAIT_WAKE) ? s_wn_chunksize : s_mn_chunksize;
        while (index < len && s_frame_fill < target) {
            s_frame[s_frame_fill++] = convert_i2s_sample(data[index++]);
        }

        if (s_frame_fill >= target) {
            process_frame();
            s_frame_fill = 0;
        }
    }

    xSemaphoreGive(s_lock);
}

bool local_voice_command_is_ready(void) {
    return s_ready;
}

bool local_voice_command_is_command_window_active(void) {
    return s_state == VOICE_STATE_COMMAND;
}

void local_voice_command_get_wake_word(char* buffer, uint32_t buffer_size) {
    if (buffer == NULL || buffer_size == 0) {
        return;
    }
    strncpy(buffer, VOICE_WAKE_WORD_ID, buffer_size - 1);
    buffer[buffer_size - 1] = '\0';
}

void local_voice_command_get_last_command(char* buffer, uint32_t buffer_size) {
    if (buffer == NULL || buffer_size == 0) {
        return;
    }
    strncpy(buffer, s_last_command, buffer_size - 1);
    buffer[buffer_size - 1] = '\0';
}

void local_voice_command_get_last_error(char* buffer, uint32_t buffer_size) {
    if (buffer == NULL || buffer_size == 0) {
        return;
    }
    strncpy(buffer, s_last_error, buffer_size - 1);
    buffer[buffer_size - 1] = '\0';
}
