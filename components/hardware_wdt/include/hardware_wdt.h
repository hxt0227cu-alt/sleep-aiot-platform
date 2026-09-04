/**
 * @file hardware_wdt.h
 * @brief 硬件看门狗组件接口
 */

#ifndef HARDWARE_WDT_H
#define HARDWARE_WDT_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define WDT_DEFAULT_TIMEOUT_SEC 30
#define WDT_MAX_TASKS 16

typedef struct {
    bool initialized;
    uint32_t timeout_seconds;
    uint8_t registered_tasks;
} hardware_wdt_status_t;

esp_err_t hardware_wdt_init(uint32_t timeout_seconds);
esp_err_t hardware_wdt_register_task(const char *task_name);
esp_err_t hardware_wdt_feed(void);
esp_err_t hardware_wdt_unregister_task(void);
void hardware_wdt_get_status(hardware_wdt_status_t *status);

#ifdef __cplusplus
}
#endif

#endif
