/**
 * 设备加密模块
 *
 * 功能：
 *   基于设备唯一密钥实现数据加解密，
 *   支持敏感配置加密存储和传输。
 *
 * 安全特性：
 *   - 使用设备唯一密钥（从 eFuse MAC 派生）
 *   - 支持 AES-256-GCM 认证加密
 *   - 密钥不暴露给应用层
 *   - 支持硬件加密引擎加速
 */

#include "esp_log.h"
#include "esp_system.h"
#include "esp_mac.h"
#include "mbedtls/gcm.h"
#include "mbedtls/sha256.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include <string.h>

static const char *TAG = "device_crypto";

#define DEVICE_KEY_SIZE 32
#define GCM_IV_SIZE 12
#define GCM_TAG_SIZE 16

static uint8_t s_device_key[DEVICE_KEY_SIZE];
static bool s_key_derived = false;
static mbedtls_ctr_drbg_context s_ctr_drbg;
static bool s_rng_initialized = false;

/**
 * 从设备 MAC 地址派生唯一密钥
 */
static esp_err_t derive_device_key(void)
{
    uint8_t mac[6];
    esp_err_t ret = esp_read_mac(mac, ESP_MAC_WIFI_STA);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "读取 MAC 地址失败: %s", esp_err_to_name(ret));
        return ret;
    }

    // 使用 MAC + 固定盐值派生密钥
    const char *salt = "sleep-monitor-device-key-v1";
    uint8_t input[6 + 32];
    memcpy(input, mac, 6);
    memcpy(input + 6, salt, strlen(salt));

    // SHA-256 派生
    mbedtls_sha256_context sha_ctx;
    mbedtls_sha256_init(&sha_ctx);
    mbedtls_sha256_starts(&sha_ctx, 0);  // SHA-256
    mbedtls_sha256_update(&sha_ctx, input, sizeof(input));
    mbedtls_sha256_finish(&sha_ctx, s_device_key);
    mbedtls_sha256_free(&sha_ctx);

    s_key_derived = true;
    ESP_LOGI(TAG, "设备密钥已派生 (MAC: %02x:%02x:%02x:%02x:%02x:%02x)",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    return ESP_OK;
}

/**
 * 初始化随机数生成器
 */
static esp_err_t init_rng(void)
{
    mbedtls_entropy_context entropy;
    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&s_ctr_drbg);

    const char *pers = "device_crypto_rng";
    int ret = mbedtls_ctr_drbg_seed(&s_ctr_drbg, mbedtls_entropy_func, &entropy,
                                       (const unsigned char *)pers, strlen(pers));
    mbedtls_entropy_free(&entropy);

    if (ret != 0) {
        ESP_LOGE(TAG, "RNG 初始化失败: -0x%04x", -ret);
        return ESP_FAIL;
    }

    s_rng_initialized = true;
    return ESP_OK;
}

/**
 * 初始化设备加密模块
 */
esp_err_t device_crypto_init(void)
{
    ESP_LOGI(TAG, "初始化设备加密模块");

    esp_err_t ret = derive_device_key();
    if (ret != ESP_OK) return ret;

    ret = init_rng();
    if (ret != ESP_OK) return ret;

    return ESP_OK;
}

/**
 * AES-256-GCM 加密
 *
 * @param plaintext 明文
 * @param plaintext_len 明文长度
 * @param aad 附加认证数据（可选）
 * @param aad_len AAD 长度
 * @param ciphertext 输出密文（长度 = 明文长度）
 * @param iv 输出 IV（12字节）
 * @param tag 输出认证标签（16字节）
 * @return ESP_OK 成功
 */
esp_err_t device_crypto_encrypt(const uint8_t *plaintext, size_t plaintext_len,
                                  const uint8_t *aad, size_t aad_len,
                                  uint8_t *ciphertext, uint8_t *iv, uint8_t *tag)
{
    if (!s_key_derived) {
        ESP_LOGE(TAG, "设备密钥未派生");
        return ESP_ERR_INVALID_STATE;
    }

    if (plaintext == NULL || ciphertext == NULL || iv == NULL || tag == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    // 生成随机 IV
    if (mbedtls_ctr_drbg_random(&s_ctr_drbg, iv, GCM_IV_SIZE) != 0) {
        ESP_LOGE(TAG, "生成 IV 失败");
        return ESP_FAIL;
    }

    // AES-256-GCM 加密
    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);

    int ret = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, s_device_key, DEVICE_KEY_SIZE * 8);
    if (ret != 0) {
        mbedtls_gcm_free(&gcm);
        ESP_LOGE(TAG, "设置 GCM 密钥失败: -0x%04x", -ret);
        return ESP_FAIL;
    }

    ret = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, plaintext_len,
                                      iv, GCM_IV_SIZE, aad, aad_len,
                                      plaintext, ciphertext, GCM_TAG_SIZE, tag);

    mbedtls_gcm_free(&gcm);

    if (ret != 0) {
        ESP_LOGE(TAG, "GCM 加密失败: -0x%04x", -ret);
        return ESP_FAIL;
    }

    return ESP_OK;
}

/**
 * AES-256-GCM 解密
 */
esp_err_t device_crypto_decrypt(const uint8_t *ciphertext, size_t ciphertext_len,
                                  const uint8_t *aad, size_t aad_len,
                                  const uint8_t *iv, const uint8_t *tag,
                                  uint8_t *plaintext)
{
    if (!s_key_derived) {
        return ESP_ERR_INVALID_STATE;
    }

    if (ciphertext == NULL || plaintext == NULL || iv == NULL || tag == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);

    int ret = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, s_device_key, DEVICE_KEY_SIZE * 8);
    if (ret != 0) {
        mbedtls_gcm_free(&gcm);
        return ESP_FAIL;
    }

    ret = mbedtls_gcm_auth_decrypt(&gcm, ciphertext_len,
                                     iv, GCM_IV_SIZE, aad, aad_len,
                                     tag, GCM_TAG_SIZE, ciphertext, plaintext);

    mbedtls_gcm_free(&gcm);

    if (ret != 0) {
        ESP_LOGW(TAG, "GCM 解密失败（认证标签不匹配）: -0x%04x", -ret);
        return ESP_ERR_INVALID_MAC;
    }

    return ESP_OK;
}

/**
 * 生成随机数
 */
esp_err_t device_crypto_random(uint8_t *output, size_t len)
{
    if (!s_rng_initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    if (mbedtls_ctr_drbg_random(&s_ctr_drbg, output, len) != 0) {
        return ESP_FAIL;
    }

    return ESP_OK;
}
