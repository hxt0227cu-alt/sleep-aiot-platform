#ifndef POTENTIOMETER_DRIVER_H
#define POTENTIOMETER_DRIVER_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t brightness;
    uint16_t color_temp;
} potentiometer_state_t;

typedef void (*potentiometer_change_callback_t)(
    const potentiometer_state_t* state,
    void* user_data
);

bool potentiometer_driver_init(void);
bool potentiometer_driver_start(void);
void potentiometer_driver_stop(void);
void potentiometer_driver_set_callback(potentiometer_change_callback_t callback, void* user_data);
void potentiometer_driver_get_state(potentiometer_state_t* state);

#ifdef __cplusplus
}
#endif

#endif
