#include "white_noise_player.h"
#include "audio_driver.h"
#include "config.h"

#include <stdio.h>
#include <string.h>
#include <sys/unistd.h>
#include "esp_log.h"
#include "esp_spiffs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

static const char* TAG = "WHITE_NOISE";

typedef struct {
    const char* name;
    const char* file_name;
} sound_file_t;

typedef struct {
    uint16_t audio_format;
    uint16_t channels;
    uint32_t sample_rate;
    uint16_t bits_per_sample;
    long data_offset;
    uint32_t data_size;
} wav_info_t;

static const sound_file_t k_sound_files[] = {
    {"rain", "rain.wav"},
    {"wind", "wind.wav"},
    {"bird", "bird.wav"},
    {"thunder", "thunder.wav"},
};

static SemaphoreHandle_t s_mutex = NULL;
static TaskHandle_t s_task = NULL;
static bool s_initialized = false;
static bool s_mounted = false;
static volatile bool s_task_running = false;
static char s_current_sound[16] = "";
static uint8_t s_volume = WHITE_NOISE_DEFAULT_VOLUME;
static bool s_ducking_enabled = false;
static uint8_t s_duck_volume = WHITE_NOISE_VOICE_DUCK_VOLUME;

static bool mount_storage(void);
static const sound_file_t* find_sound(const char* sound);
static void build_sound_path(const sound_file_t* sound, char* path, size_t path_size);
static bool parse_wav(FILE* file, wav_info_t* info);
static bool read_u16_le(FILE* file, uint16_t* value);
static bool read_u32_le(FILE* file, uint32_t* value);
static void stop_playback(bool wait_for_exit);
static void playback_task(void* arg);
static uint8_t current_output_volume_locked(void);

bool white_noise_player_init(void) {
    if (s_initialized) {
        return true;
    }

    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "Failed to create mutex");
        return false;
    }

    if (!mount_storage()) {
        ESP_LOGE(TAG, "Failed to mount SPIFFS storage");
        return false;
    }

    audio_config_t audio_config = {};
    audio_config.amp_enabled = true;
    audio_config.amp_sample_rate = WHITE_NOISE_SAMPLE_RATE;
    audio_config.amp_bits_per_sample = 16;
    audio_config.amp_channels = 2;
    audio_config.mic_enabled = false;
    audio_config.mic_sample_rate = MIC_I2S_SAMPLE_RATE;
    audio_config.mic_bits_per_sample = MIC_I2S_BITS_PER_SAMPLE;
    audio_config.mic_channels = MIC_I2S_CHANNEL_NUM;
    audio_config.buffer_size = 4096;
    audio_config.enable_noise_gate = false;
    audio_config.noise_gate_threshold = 0;

    if (audio_init(&audio_config) != AUDIO_ERR_NONE || audio_start() != AUDIO_ERR_NONE) {
        ESP_LOGE(TAG, "Failed to initialize I2S audio output");
        return false;
    }
    audio_set_volume(current_output_volume_locked());

    s_initialized = true;
    ESP_LOGI(TAG, "White noise player ready, base=%s", WHITE_NOISE_BASE_PATH);
    return true;
}

void white_noise_player_deinit(void) {
    stop_playback(true);
    audio_stop();
    audio_deinit();

    if (s_mounted) {
        esp_vfs_spiffs_unregister("storage");
        s_mounted = false;
    }

    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    s_initialized = false;
}

bool white_noise_player_play(const char* sound, uint8_t volume) {
    if (!s_initialized || sound == NULL) {
        return false;
    }

    const sound_file_t* sound_file = find_sound(sound);
    if (sound_file == NULL) {
        ESP_LOGW(TAG, "Unsupported sound: %s", sound);
        return false;
    }

    if (volume > 100) {
        volume = 100;
    }

    stop_playback(true);

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    strncpy(s_current_sound, sound_file->name, sizeof(s_current_sound) - 1);
    s_current_sound[sizeof(s_current_sound) - 1] = '\0';
    s_volume = volume;
    s_task_running = true;
    xSemaphoreGive(s_mutex);

    BaseType_t ok = xTaskCreatePinnedToCore(
        playback_task,
        "WhiteNoise",
        6144,
        NULL,
        TASK_PRIORITY_LOW,
        &s_task,
        0
    );

    if (ok != pdPASS) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_task_running = false;
        s_current_sound[0] = '\0';
        s_task = NULL;
        xSemaphoreGive(s_mutex);
        ESP_LOGE(TAG, "Failed to create white noise task");
        return false;
    }

    ESP_LOGI(TAG, "Playing white noise: %s volume=%u", sound_file->name, volume);
    return true;
}

void white_noise_player_stop(void) {
    stop_playback(true);
}

void white_noise_player_set_volume(uint8_t volume) {
    if (volume > 100) {
        volume = 100;
    }

    if (s_mutex != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_volume = volume;
        audio_set_volume(current_output_volume_locked());
        xSemaphoreGive(s_mutex);
    } else {
        s_volume = volume;
        audio_set_volume(s_volume);
    }
}

void white_noise_player_set_ducking(bool enabled, uint8_t duck_volume) {
    if (duck_volume > 100) {
        duck_volume = 100;
    }

    if (s_mutex != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_ducking_enabled = enabled;
        s_duck_volume = duck_volume;
        audio_set_volume(current_output_volume_locked());
        xSemaphoreGive(s_mutex);
    } else {
        s_ducking_enabled = enabled;
        s_duck_volume = duck_volume;
        audio_set_volume(enabled ? duck_volume : s_volume);
    }
}

bool white_noise_player_is_ducked(void) {
    return s_ducking_enabled;
}

bool white_noise_player_is_supported_sound(const char* sound) {
    return find_sound(sound) != NULL;
}

void white_noise_player_get_state(white_noise_state_t* state) {
    if (state == NULL) {
        return;
    }

    memset(state, 0, sizeof(*state));
    if (s_mutex != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
    }

    state->initialized = s_initialized;
    state->mounted = s_mounted;
    state->playing = s_task_running && s_task != NULL;
    state->volume = s_volume;
    strncpy(state->sound, s_current_sound, sizeof(state->sound) - 1);

    if (s_mutex != NULL) {
        xSemaphoreGive(s_mutex);
    }
}

static bool mount_storage(void) {
    if (s_mounted || esp_spiffs_mounted("storage")) {
        s_mounted = true;
        return true;
    }

    esp_vfs_spiffs_conf_t conf = {};
    conf.base_path = "/storage";
    conf.partition_label = "storage";
    conf.max_files = 8;
    conf.format_if_mount_failed = false;

    esp_err_t err = esp_vfs_spiffs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_vfs_spiffs_register failed: %s", esp_err_to_name(err));
        return false;
    }

    size_t total = 0;
    size_t used = 0;
    err = esp_spiffs_info("storage", &total, &used);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "SPIFFS storage mounted: total=%u used=%u",
                 (unsigned)total, (unsigned)used);
    }
    s_mounted = true;
    return true;
}

static const sound_file_t* find_sound(const char* sound) {
    if (sound == NULL) {
        return NULL;
    }

    for (size_t i = 0; i < sizeof(k_sound_files) / sizeof(k_sound_files[0]); ++i) {
        if (strcmp(sound, k_sound_files[i].name) == 0) {
            return &k_sound_files[i];
        }
    }
    return NULL;
}

static void build_sound_path(const sound_file_t* sound, char* path, size_t path_size) {
    if (path == NULL || path_size == 0) {
        return;
    }
    snprintf(path, path_size, "%s/%s", WHITE_NOISE_BASE_PATH, sound->file_name);
}

static bool read_u16_le(FILE* file, uint16_t* value) {
    uint8_t bytes[2];
    if (fread(bytes, 1, sizeof(bytes), file) != sizeof(bytes)) {
        return false;
    }
    *value = (uint16_t)(bytes[0] | (bytes[1] << 8));
    return true;
}

static bool read_u32_le(FILE* file, uint32_t* value) {
    uint8_t bytes[4];
    if (fread(bytes, 1, sizeof(bytes), file) != sizeof(bytes)) {
        return false;
    }
    *value = (uint32_t)bytes[0] |
             ((uint32_t)bytes[1] << 8) |
             ((uint32_t)bytes[2] << 16) |
             ((uint32_t)bytes[3] << 24);
    return true;
}

static uint8_t current_output_volume_locked(void) {
    if (!s_ducking_enabled) {
        return s_volume;
    }
    return s_volume < s_duck_volume ? s_volume : s_duck_volume;
}

static bool parse_wav(FILE* file, wav_info_t* info) {
    if (file == NULL || info == NULL) {
        return false;
    }

    memset(info, 0, sizeof(*info));

    char id[4];
    uint32_t size = 0;
    if (fread(id, 1, 4, file) != 4 || memcmp(id, "RIFF", 4) != 0 ||
        !read_u32_le(file, &size) ||
        fread(id, 1, 4, file) != 4 || memcmp(id, "WAVE", 4) != 0) {
        return false;
    }

    bool has_fmt = false;
    bool has_data = false;

    while (fread(id, 1, 4, file) == 4 && read_u32_le(file, &size)) {
        long chunk_start = ftell(file);
        if (chunk_start < 0) {
            return false;
        }

        if (memcmp(id, "fmt ", 4) == 0) {
            uint32_t byte_rate = 0;
            uint16_t block_align = 0;
            has_fmt =
                read_u16_le(file, &info->audio_format) &&
                read_u16_le(file, &info->channels) &&
                read_u32_le(file, &info->sample_rate) &&
                read_u32_le(file, &byte_rate) &&
                read_u16_le(file, &block_align) &&
                read_u16_le(file, &info->bits_per_sample);
            (void)byte_rate;
            (void)block_align;
        } else if (memcmp(id, "data", 4) == 0) {
            info->data_offset = ftell(file);
            info->data_size = size;
            has_data = true;
        }

        long next_chunk = chunk_start + (long)size + (long)(size & 1U);
        if (fseek(file, next_chunk, SEEK_SET) != 0) {
            break;
        }

        if (has_fmt && has_data) {
            break;
        }
    }

    if (!has_fmt || !has_data) {
        return false;
    }

    if (info->audio_format != 1 ||
        info->channels != WHITE_NOISE_CHANNELS ||
        info->sample_rate != WHITE_NOISE_SAMPLE_RATE ||
        info->bits_per_sample != WHITE_NOISE_BITS_PER_SAMPLE ||
        info->data_offset <= 0 ||
        info->data_size == 0) {
        ESP_LOGE(TAG, "Unsupported WAV: format=%u channels=%u rate=%u bits=%u",
                 info->audio_format,
                 info->channels,
                 (unsigned)info->sample_rate,
                 info->bits_per_sample);
        return false;
    }

    return fseek(file, info->data_offset, SEEK_SET) == 0;
}

static void stop_playback(bool wait_for_exit) {
    if (s_mutex != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_task_running = false;
        xSemaphoreGive(s_mutex);
    } else {
        s_task_running = false;
    }

    audio_clear_buffer();

    if (wait_for_exit) {
        for (int i = 0; i < 50 && s_task != NULL; ++i) {
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }

    if (s_mutex != NULL && s_task == NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_current_sound[0] = '\0';
        xSemaphoreGive(s_mutex);
    }
}

static void playback_task(void* arg) {
    (void)arg;

    char sound_name[sizeof(s_current_sound)] = "";
    uint8_t volume = 0;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    strncpy(sound_name, s_current_sound, sizeof(sound_name) - 1);
    volume = s_volume;
    xSemaphoreGive(s_mutex);

    const sound_file_t* sound_file = find_sound(sound_name);
    char path[96] = "";
    if (sound_file != NULL) {
        build_sound_path(sound_file, path, sizeof(path));
    }

    FILE* file = (sound_file != NULL) ? fopen(path, "rb") : NULL;
    if (file == NULL) {
        ESP_LOGE(TAG, "Open WAV failed: %s", path);
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_task_running = false;
        s_current_sound[0] = '\0';
        s_task = NULL;
        xSemaphoreGive(s_mutex);
        vTaskDelete(NULL);
        return;
    }

    wav_info_t info = {};
    if (!parse_wav(file, &info)) {
        ESP_LOGE(TAG, "Invalid WAV file: %s", path);
        fclose(file);
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_task_running = false;
        s_current_sound[0] = '\0';
        s_task = NULL;
        xSemaphoreGive(s_mutex);
        vTaskDelete(NULL);
        return;
    }

    int16_t mono[WHITE_NOISE_CHUNK_FRAMES];
    int16_t stereo[WHITE_NOISE_CHUNK_FRAMES * 2];
    uint32_t remaining = info.data_size;

    while (s_task_running) {
        if (remaining < sizeof(mono)) {
            if (fseek(file, info.data_offset, SEEK_SET) != 0) {
                break;
            }
            remaining = info.data_size;
        }

        size_t bytes_to_read = sizeof(mono);
        if (remaining < bytes_to_read) {
            bytes_to_read = remaining;
        }

        size_t bytes_read = fread(mono, 1, bytes_to_read, file);
        if (bytes_read == 0) {
            if (fseek(file, info.data_offset, SEEK_SET) != 0) {
                break;
            }
            remaining = info.data_size;
            continue;
        }
        remaining -= (uint32_t)bytes_read;

        xSemaphoreTake(s_mutex, portMAX_DELAY);
        volume = current_output_volume_locked();
        xSemaphoreGive(s_mutex);

        size_t frames = bytes_read / sizeof(int16_t);
        for (size_t i = 0; i < frames; ++i) {
            int32_t sample = ((int32_t)mono[i] * volume) / 100;
            stereo[i * 2] = (int16_t)sample;
            stereo[i * 2 + 1] = (int16_t)sample;
        }

        if (audio_play_blocking(stereo, (uint32_t)(frames * 2)) != AUDIO_ERR_NONE) {
            ESP_LOGW(TAG, "I2S playback write failed");
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }

    fclose(file);
    audio_clear_buffer();

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_task_running = false;
    s_task = NULL;
    s_current_sound[0] = '\0';
    xSemaphoreGive(s_mutex);
    vTaskDelete(NULL);
}
