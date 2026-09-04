/**
 * 系统初始化模块
 *
 * 功能：
 *   按依赖顺序初始化所有安全与业务模块，
 *   确保系统启动时所有组件就绪。
 *
 * 初始化顺序：
 *   1. NVS / Flash 加密
 *   2. 硬件密钥 / Secure Boot / Flash Encryption 接口
 *   3. 设备加密 / 密钥生成
 *   4. 硬件看门狗
 *   5. CRL 客户端
 *   6. Core Dump 存储
 *   7. 本地序列号管理器
 *   8. 边缘报警引擎
 *   9. 算法参数校验器
 */

#include "esp_log.h"
#include "esp_err.h"
#include "nvs_flash.h"
#include "esp_system.h"
#include <string.h>

static const char *TAG = "system_init";

#define FIRMWARE_VERSION "1.0.0"

typedef struct {
    const char *name;
    esp_err_t (*init_func)(void);
    bool required;  // 初始化失败是否终止启动
} init_module_t;

// 前向声明
extern "C" esp_err_t efuse_hw_key_init(void);
extern "C" esp_err_t secure_boot_init(void);
extern "C" esp_err_t flash_encryption_init(void);
extern "C" esp_err_t device_crypto_init(void);
extern "C" esp_err_t device_key_gen_init(void);
extern "C" esp_err_t hardware_wdt_init(uint32_t timeout_seconds);
extern "C" esp_err_t coredump_storage_init(void);
extern "C" esp_err_t local_sequence_manager_init(void);
extern "C" esp_err_t edge_alarm_engine_init(void);
extern "C" esp_err_t algorithm_param_validator_init(const char *firmware_version);

static init_module_t s_init_modules[] = {
    {"NVS Flash", NULL, true},  // 特殊处理
    {"eFuse HW Key", efuse_hw_key_init, false},
    {"Secure Boot", secure_boot_init, false},
    {"Flash Encryption", flash_encryption_init, false},
    {"Device Crypto", device_crypto_init, true},
    {"Device Key Gen", device_key_gen_init, true},
    {"Hardware WDT", NULL, false},  // 特殊处理
    {"Core Dump Storage", coredump_storage_init, false},
    {"Local Sequence", local_sequence_manager_init, true},
    {"Edge Alarm Engine", edge_alarm_engine_init, false},
    {"Algorithm Param Validator", NULL, false},  // 特殊处理
};

#define INIT_MODULE_COUNT (sizeof(s_init_modules) / sizeof(s_init_modules[0]))

typedef struct {
    bool initialized;
    uint32_t initialized_count;
    uint32_t failed_count;
    uint64_t init_start_time;
    uint64_t init_end_time;
} system_init_state_t;

static system_init_state_t s_state = {0};

/**
 * 执行系统初始化
 */
esp_err_t system_init_execute(void)
{
    ESP_LOGI(TAG, "=");
    ESP_LOGI(TAG, "系统初始化开始");
    ESP_LOGI(TAG, "固件版本: %s", FIRMWARE_VERSION);
    ESP_LOGI(TAG, "=");

    s_state.init_start_time = esp_timer_get_time();
    s_state.initialized_count = 0;
    s_state.failed_count = 0;

    // 1. 初始化 NVS
    ESP_LOGI(TAG, "[1/%d] 初始化 NVS Flash...", INIT_MODULE_COUNT);
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS 需要擦除，执行擦除...");
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "NVS 初始化失败: %s", esp_err_to_name(ret));
        return ret;
    }
    s_state.initialized_count++;
    ESP_LOGI(TAG, "  NVS 初始化完成");

    // 2. 初始化硬件看门狗（需要尽早启动）
    ESP_LOGI(TAG, "[2/%d] 初始化硬件看门狗...", INIT_MODULE_COUNT);
    ret = hardware_wdt_init(30);  // 30秒超时
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "  硬件看门狗初始化失败（非致命）: %s", esp_err_to_name(ret));
    } else {
        s_state.initialized_count++;
    }

    // 3. 依次初始化其他模块
    for (uint32_t i = 2; i < INIT_MODULE_COUNT; i++) {
        init_module_t *module = &s_init_modules[i];

        ESP_LOGI(TAG, "[%d/%d] 初始化 %s...", i + 1, INIT_MODULE_COUNT, module->name);

        esp_err_t module_ret = ESP_OK;

        if (module->init_func != NULL) {
            module_ret = module->init_func();
        } else if (strcmp(module->name, "Algorithm Param Validator") == 0) {
            module_ret = algorithm_param_validator_init(FIRMWARE_VERSION);
        }

        if (module_ret == ESP_OK) {
            s_state.initialized_count++;
            ESP_LOGI(TAG, "  %s 初始化完成", module->name);
        } else {
            s_state.failed_count++;
            if (module->required) {
                ESP_LOGE(TAG, "  %s 初始化失败（致命）: %s", module->name, esp_err_to_name(module_ret));
                return module_ret;
            } else {
                ESP_LOGW(TAG, "  %s 初始化失败（非致命）: %s", module->name, esp_err_to_name(module_ret));
            }
        }
    }

    s_state.init_end_time = esp_timer_get_time();
    s_state.initialized = true;

    uint64_t duration_ms = (s_state.init_end_time - s_state.init_start_time) / 1000;

    ESP_LOGI(TAG, "=");
    ESP_LOGI(TAG, "系统初始化完成");
    ESP_LOGI(TAG, "  成功: %lu / %d", (unsigned long)s_state.initialized_count, INIT_MODULE_COUNT);
    ESP_LOGI(TAG, "  失败: %lu", (unsigned long)s_state.failed_count);
    ESP_LOGI(TAG, "  耗时: %llu ms", duration_ms);
    ESP_LOGI(TAG, "=");

    return ESP_OK;
}

/**
 * 获取系统初始化状态
 */
void system_init_get_status(system_init_status_t *status)
{
    if (status == NULL) return;

    status->initialized = s_state.initialized;
    status->initialized_count = s_state.initialized_count;
    status->failed_count = s_state.failed_count;
    status->total_modules = INIT_MODULE_COUNT;
    status->init_duration_ms = (s_state.init_end_time - s_state.init_start_time) / 1000;
}

/**
 * 获取固件版本
 */
const char *system_init_get_firmware_version(void)
{
    return FIRMWARE_VERSION;
}
