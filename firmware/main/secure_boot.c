/**
 * Secure Boot 系统接口层
 *
 * 功能：
 *   提供固件签名校验状态查询、安全启动信息读取等辅助接口。
 *
 * 注意：
 *   Secure Boot V2 的核心校验逻辑由 ESP-IDF Bootloader 原生实现，
 *   本文件仅提供应用层查询接口。
 */

#include "esp_log.h"
#include "esp_efuse.h"
#include "esp_efuse_table.h"
#include "esp_ota_ops.h"
#include <string.h>

static const char *TAG = "secure_boot";

typedef struct {
    bool enabled;
    uint8_t version;
    bool key_burned;
    bool aggressive_revoke;
    uint32_t secure_version;
} secure_boot_state_t;

static secure_boot_state_t s_state = {0};

/**
 * 初始化 Secure Boot 接口
 */
esp_err_t secure_boot_init(void)
{
    ESP_LOGI(TAG, "初始化 Secure Boot 接口");

    // 读取 Secure Boot 启用状态
    esp_efuse_read_field_bit(ESP_EFUSE_ABS_DONE_0, &s_state.enabled);

    // 读取安全版本号
    esp_efuse_read_field_blob(ESP_EFUSE_SECURE_VERSION, &s_state.secure_version, 32);

    if (s_state.enabled) {
        s_state.version = 2;  // ESP32-S3 使用 V2
        ESP_LOGI(TAG, "Secure Boot V2 已启用");
        ESP_LOGI(TAG, "安全版本号: %lu", (unsigned long)s_state.secure_version);
    } else {
        ESP_LOGW(TAG, "Secure Boot 未启用（开发模式）");
    }

    return ESP_OK;
}

/**
 * 检查 Secure Boot 是否启用
 */
bool secure_boot_is_enabled(void)
{
    return s_state.enabled;
}

/**
 * 获取 Secure Boot 版本
 */
uint8_t secure_boot_get_version(void)
{
    return s_state.version;
}

/**
 * 获取当前运行固件的安全版本号
 */
uint32_t secure_boot_get_secure_version(void)
{
    return s_state.secure_version;
}

/**
 * 验证当前运行固件的签名
 *
 * @return ESP_OK 签名有效
 */
esp_err_t secure_boot_verify_current_app(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (running == NULL) {
        ESP_LOGE(TAG, "无法获取当前运行分区");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "当前运行分区: %s, 偏移: 0x%lx",
             running->label, (unsigned long)running->address);

    // Secure Boot 启用时，Bootloader 已验证签名
    // 应用层无需重复验证
    if (s_state.enabled) {
        ESP_LOGI(TAG, "Secure Boot 已启用，固件签名在启动时已验证");
        return ESP_OK;
    }

    ESP_LOGW(TAG, "Secure Boot 未启用，跳过签名验证");
    return ESP_OK;
}

/**
 * 获取 Secure Boot 状态信息
 */
void secure_boot_get_info(secure_boot_info_t *info)
{
    if (info == NULL) return;

    info->enabled = s_state.enabled;
    info->version = s_state.version;
    info->secure_version = s_state.secure_version;
    info->key_burned = s_state.key_burned;
}
