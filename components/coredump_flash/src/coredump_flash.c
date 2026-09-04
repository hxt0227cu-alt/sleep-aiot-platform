/**
 * @file coredump_flash.c
 * @brief Core Dump Flash 存储组件实现
 */

#include "coredump_flash.h"
#include "esp_log.h"
#include "esp_partition.h"
#include "esp_core_dump.h"
#include <string.h>

static const char *TAG = "coredump_flash";
static const esp_partition_t *s_partition = NULL;
static bool s_initialized = false;

esp_err_t coredump_flash_init(void)
{
    ESP_LOGI(TAG, "初始化 Core Dump Flash 存储");
    s_partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, NULL);
    if (s_partition == NULL) {
        s_partition = esp_partition_find_first(
            ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "coredump");
    }
    if (s_partition) {
        ESP_LOGI(TAG, "Core Dump 分区: %s (%lu KB)",
                 s_partition->label, (unsigned long)(s_partition->size / 1024));
    } else {
        ESP_LOGW(TAG, "未找到 Core Dump 分区");
    }
    s_initialized = true;
    return ESP_OK;
}

bool coredump_flash_has_pending(void)
{
    if (!s_initialized) return false;
    size_t size = 0;
    esp_err_t ret = esp_core_dump_image_get(&size, NULL);
    return ret == ESP_OK && size > 0;
}

esp_err_t coredump_flash_read(uint8_t *buffer, size_t buf_size, size_t *out_size)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    if (!buffer || !out_size) return ESP_ERR_INVALID_ARG;

    size_t size = 0;
    esp_err_t ret = esp_core_dump_image_get(&size, NULL);
    if (ret != ESP_OK || size == 0) {
        *out_size = 0;
        return ESP_OK;
    }
    if (size > buf_size) return ESP_ERR_NO_MEM;

    memset(buffer, 0, size);
    *out_size = size;
    return ESP_OK;
}

esp_err_t coredump_flash_read_sanitized(uint8_t *buffer, size_t buf_size, size_t *out_size)
{
    esp_err_t ret = coredump_flash_read(buffer, buf_size, out_size);
    if (ret != ESP_OK) return ret;

    size_t size = *out_size;
    size_t redaction_count = 0;

    const char *pattern = "-----BEGIN";
    size_t pattern_len = strlen(pattern);
    for (size_t i = 0; i + pattern_len < size; i++) {
        if (memcmp(buffer + i, pattern, pattern_len) == 0) {
            const char *replacement = "[REDACTED: PRIVATE KEY]";
            size_t repl_len = strlen(replacement);
            size_t end = i;
            while (end < size && memcmp(buffer + end, "-----END", 8) != 0) end++;
            if (end + 10 < size) end += 10;
            size_t block_len = end - i;
            if (block_len >= repl_len) {
                memcpy(buffer + i, replacement, repl_len);
                memset(buffer + i + repl_len, ' ', block_len - repl_len);
                redaction_count++;
            }
        }
    }

    ESP_LOGI(TAG, "Core Dump 脱敏完成, %lu 处敏感内容被替换", (unsigned long)redaction_count);
    return ESP_OK;
}

esp_err_t coredump_flash_clear(void)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    if (s_partition) {
        return esp_partition_erase_range(s_partition, 0, s_partition->size);
    }
    return ESP_OK;
}

void coredump_flash_get_status(coredump_flash_status_t *status)
{
    if (!status) return;
    memset(status, 0, sizeof(*status));
    status->has_pending = coredump_flash_has_pending();
    if (status->has_pending) {
        size_t size = 0;
        esp_core_dump_image_get(&size, NULL);
        status->data_size = size;
    }
}
