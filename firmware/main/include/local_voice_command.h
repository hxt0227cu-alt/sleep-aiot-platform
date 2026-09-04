#ifndef LOCAL_VOICE_COMMAND_H
#define LOCAL_VOICE_COMMAND_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*local_voice_command_callback_t)(
    const char* command,
    const char* params_json,
    void* user_data
);

typedef enum {
    LOCAL_VOICE_EVENT_WAKE_WORD = 1,
    LOCAL_VOICE_EVENT_COMMAND_DETECTED = 2,
    LOCAL_VOICE_EVENT_COMMAND_TIMEOUT = 3,
    LOCAL_VOICE_EVENT_ERROR = 4,
} local_voice_event_t;

typedef void (*local_voice_event_callback_t)(
    local_voice_event_t event,
    const char* detail,
    void* user_data
);

bool local_voice_command_init(void);
void local_voice_command_set_callback(local_voice_command_callback_t callback, void* user_data);
void local_voice_command_set_event_callback(local_voice_event_callback_t callback, void* user_data);
bool local_voice_command_handle_text(const char* text);
void local_voice_command_mic_callback(const int32_t* data, uint32_t len, void* user_data);
bool local_voice_command_is_ready(void);
bool local_voice_command_is_command_window_active(void);
void local_voice_command_get_wake_word(char* buffer, uint32_t buffer_size);
void local_voice_command_get_last_command(char* buffer, uint32_t buffer_size);
void local_voice_command_get_last_error(char* buffer, uint32_t buffer_size);

#ifdef __cplusplus
}
#endif

#endif
