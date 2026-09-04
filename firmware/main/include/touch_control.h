#ifndef TOUCH_CONTROL_H
#define TOUCH_CONTROL_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    TOUCH_CONTROL_EVENT_LIGHT_SCENE = 0,
    TOUCH_CONTROL_EVENT_NOISE_PLAY,
    TOUCH_CONTROL_EVENT_NOISE_STOP,
    TOUCH_CONTROL_EVENT_VOLUME_UP,
    TOUCH_CONTROL_EVENT_VOLUME_DOWN,
} touch_control_event_type_t;

typedef struct {
    touch_control_event_type_t type;
    uint8_t scene_index;
    const char* sound;
} touch_control_event_t;

typedef void (*touch_control_event_callback_t)(const touch_control_event_t* event, void* user_data);

bool touch_control_init(void);
bool touch_control_start(void);
void touch_control_stop(void);
void touch_control_set_event_callback(touch_control_event_callback_t callback, void* user_data);

#ifdef __cplusplus
}
#endif

#endif
