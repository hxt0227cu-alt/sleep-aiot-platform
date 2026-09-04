#ifndef WHITE_NOISE_PLAYER_H
#define WHITE_NOISE_PLAYER_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool initialized;
    bool mounted;
    bool playing;
    char sound[16];
    uint8_t volume;
} white_noise_state_t;

bool white_noise_player_init(void);
void white_noise_player_deinit(void);
bool white_noise_player_play(const char* sound, uint8_t volume);
void white_noise_player_stop(void);
void white_noise_player_set_volume(uint8_t volume);
void white_noise_player_set_ducking(bool enabled, uint8_t duck_volume);
bool white_noise_player_is_ducked(void);
bool white_noise_player_is_supported_sound(const char* sound);
void white_noise_player_get_state(white_noise_state_t* state);

#ifdef __cplusplus
}
#endif

#endif
