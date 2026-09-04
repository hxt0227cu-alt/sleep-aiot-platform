/**
 * @file coredump_flash.h
 * @brief Core Dump Flash 存储组件接口
 */

#ifndef COREDUMP_FLASH_H
#define COREDUMP_FLASH_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define COREDUMP_MAGIC 0x43444D50
#define COREDUMP_MAX_SIZE (64 * 1024)

typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t data_size;
    uint32_t crc32;
    uint8_t encrypted;
    uint8_t reserved[3];
    uint64_t timestamp;
} coredump_header_t;

typedef struct {
    bool has_pending;
    uint32_t data_size;
    uint64_t timestamp;
    bool encrypted;
} coredump_flash_status_t;

esp_err_t coredump_flash_init(void);
bool coredump_flash_has_pending(void);
esp_err_t coredump_flash_read(uint8_t *buffer, size_t buf_size, size_t *out_size);
esp_err_t coredump_flash_read_sanitized(uint8_t *buffer, size_t buf_size, size_t *out_size);
esp_err_t coredump_flash_clear(void);
void coredump_flash_get_status(coredump_flash_status_t *status);

#ifdef __cplusplus
}
#endif

#endif
