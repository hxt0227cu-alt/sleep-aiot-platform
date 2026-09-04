#ifndef __PROVISIONING_SERVICE_H__
#define __PROVISIONING_SERVICE_H__

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PROVISIONING_BIND_TOKEN_MAX_LEN 96
#define PROVISIONING_DEVICE_NAME_MAX_LEN 32

typedef enum {
    PROVISIONING_REASON_BOOT_NO_WIFI = 0,
    PROVISIONING_REASON_WIFI_FAILED,
    PROVISIONING_REASON_BUTTON_RESET,
    PROVISIONING_REASON_SOFTAP_ONLY,
} provisioning_reason_t;

bool provisioning_service_init(void);
bool provisioning_service_start(provisioning_reason_t reason);
bool provisioning_service_is_running(void);
bool provisioning_service_get_bind_token(char* buffer, size_t buffer_size);
bool provisioning_service_clear_bind_token(void);

#ifdef __cplusplus
}
#endif

#endif /* __PROVISIONING_SERVICE_H__ */
