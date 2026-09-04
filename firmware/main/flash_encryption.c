/**
 * Flash Encryption 系统接口层
 *
 * 功能：
 *   提供加密状态查询、加密分区访问控制等辅助接口。
 *
 * 注意：
 *   Flash Encryption 的核心加解密由 ESP-IDF Flash 加密引擎原生实现，
 *   本文件仅提供应用层查询接口。
 */

#include "esp_log.h"
#include "esp_efuse.h"
#include "esp_efuse_table.h"
#include "esp_flash_encrypt.h"
#include <string.h>

static const char *TAG = "flash_encryption";

typedef struct {
    bool enabled;
    esp_flash_enc_mode_t mode;
    bool key_burned;
    bool key_read_protected;
} flash_encryption_state_t;

static flash_encryption_state_t s_state = {0};

/**
 * 初始化 Flash Encryption 接口
 */
esp_err_t flash_encryption_init(void)
{
    ESP_LOGI(TAG, "初始化 Flash Encryption 接口");

    // 读取 Flash Encryption 启用状态
    esp_efuse_read_field_bit(ESP_EFUSE_FLASH_CRYPT_CNT, &s_state.enabled);

    // 读取加密模式
    s_state.mode = esp_flash_encryption_mode();

    if (s_state.enabled) {
        ESP_LOGI(TAG, "Flash Encryption 已启用");
        ESP_LOGI(TAG, "加密模式: %s",
                 s_state.mode == ESP_FLASH_ENC_MODE_RELEASE ? "Release" :
                 s_state.mode == ESP_FLASH_ENC_MODE_DEVELOPMENT ? "Development" : "Unknown");
    } else {
        ESP_LOGW(TAG, "Flash Encryption 未启用（开发模式）");
    }

    return ESP_OK;
}

/**
 * 检查 Flash Encryption 是否启用
 */
bool flash_encryption_is_enabled(void)
{
    return s_state.enabled;
}

/**
 * 获取加密模式
 */
esp_flash_enc_mode_t flash_encryption_get_mode(void)
{
    return s_state.mode;
}

/**
 * 检查是否为 Release 模式（生产环境）
 */
bool flash_encryption_is_release_mode(void)
{
    return s_state.enabled && s_state.mode == ESP_FLASH_ENC_MODE_RELEASE;
}

/**
 * 获取 Flash Encryption 状态信息
 */
void flash_encryption_get_info(flash_encryption_info_t *info)
{
    if (info == NULL) return;

    info->enabled = s_state.enabled;
    info->mode = s_state.mode;
    info->is_release_mode = flash_encryption_is_release_mode();
    info->key_burned = s_state.key_burned;
    info->key_read_protected = s_state.key_read_protected;
}
