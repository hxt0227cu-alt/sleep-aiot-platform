/**
 * 设备密钥生成模块
 *
 * 功能：
 *   在设备内部安全生成 ECDSA P-256 密钥对，
 *   私钥永不离开设备，仅导出公钥和 CSR。
 *
 * 安全特性：
 *   - 私钥在设备内部生成，不暴露给应用层
 *   - 使用硬件随机数生成器
 *   - 私钥存储在安全存储区（NVS 加密分区）
 *   - 支持生成 CSR（证书签名请求）
 */

#include "esp_log.h"
#include "esp_err.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "mbedtls/pk.h"
#include "mbedtls/ecp.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/x509_csr.h"
#include "mbedtls/pem.h"
#include <string.h>

static const char *TAG = "device_key_gen";

#define NVS_NAMESPACE "device_keys"
#define NVS_PRIV_KEY "ecdsapriv"
#define NVS_PUB_KEY "ecdsapub"
#define KEY_BUFFER_SIZE 512

static mbedtls_pk_context s_keypair;
static bool s_keypair_loaded = false;

/**
 * 初始化密钥生成模块
 */
esp_err_t device_key_gen_init(void)
{
    ESP_LOGI(TAG, "初始化设备密钥生成模块");

    mbedtls_pk_init(&s_keypair);

    // 尝试从 NVS 加载已有密钥
    nvs_handle_t handle;
    esp_err_t ret = nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle);
    if (ret == ESP_OK) {
        size_t key_len = KEY_BUFFER_SIZE;
        uint8_t key_buf[KEY_BUFFER_SIZE];

        ret = nvs_get_blob(handle, NVS_PRIV_KEY, key_buf, &key_len);
        if (ret == ESP_OK && key_len > 0) {
            // 解析私钥
            if (mbedtls_pk_parse_key(&s_keypair, key_buf, key_len, NULL, 0) == 0) {
                s_keypair_loaded = true;
                ESP_LOGI(TAG, "已从 NVS 加载设备密钥对");
            }
        }
        nvs_close(handle);
    }

    if (!s_keypair_loaded) {
        ESP_LOGI(TAG, "未找到已有密钥，将生成新密钥对");
    }

    return ESP_OK;
}

/**
 * 生成新的 ECDSA P-256 密钥对
 */
esp_err_t device_key_gen_generate(void)
{
    if (s_keypair_loaded) {
        ESP_LOGW(TAG, "密钥对已存在，跳过生成");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "生成 ECDSA P-256 密钥对...");

    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context ctr_drbg;

    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&ctr_drbg);

    const char *pers = "device_key_gen";
    int ret = mbedtls_ctr_drbg_seed(&ctr_drbg, mbedtls_entropy_func, &entropy,
                                      (const unsigned char *)pers, strlen(pers));
    if (ret != 0) {
        ESP_LOGE(TAG, "RNG 种子生成失败: -0x%04x", -ret);
        mbedtls_entropy_free(&entropy);
        mbedtls_ctr_drbg_free(&ctr_drbg);
        return ESP_FAIL;
    }

    // 生成 ECDSA P-256 密钥对
    ret = mbedtls_pk_setup(&s_keypair, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY));
    if (ret == 0) {
        ret = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, mbedtls_pk_ec(s_keypair),
                                    mbedtls_ctr_drbg_random, &ctr_drbg);
    }

    mbedtls_entropy_free(&entropy);
    mbedtls_ctr_drbg_free(&ctr_drbg);

    if (ret != 0) {
        ESP_LOGE(TAG, "密钥对生成失败: -0x%04x", -ret);
        return ESP_FAIL;
    }

    s_keypair_loaded = true;
    ESP_LOGI(TAG, "ECDSA P-256 密钥对生成成功");

    // 保存到 NVS
    return device_key_gen_save_to_nvs();
}

/**
 * 保存密钥对到 NVS 加密分区
 */
esp_err_t device_key_gen_save_to_nvs(void)
{
    if (!s_keypair_loaded) {
        return ESP_ERR_INVALID_STATE;
    }

    ESP_LOGI(TAG, "保存密钥对到 NVS...");

    uint8_t priv_buf[KEY_BUFFER_SIZE];
    int priv_len = mbedtls_pk_write_key_der(&s_keypair, priv_buf, sizeof(priv_buf));
    if (priv_len < 0) {
        ESP_LOGE(TAG, "导出私钥失败: -0x%04x", -priv_len);
        return ESP_FAIL;
    }

    nvs_handle_t handle;
    esp_err_t ret = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "打开 NVS 失败: %s", esp_err_to_name(ret));
        return ret;
    }

    // 私钥在 NVS 中存储（NVS 分区应启用加密）
    ret = nvs_set_blob(handle, NVS_PRIV_KEY, priv_buf + (sizeof(priv_buf) - priv_len), priv_len);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "保存私钥失败: %s", esp_err_to_name(ret));
    }

    nvs_commit(handle);
    nvs_close(handle);

    ESP_LOGI(TAG, "密钥对已保存到 NVS");
    return ret;
}

/**
 * 导出公钥（PEM 格式）
 */
esp_err_t device_key_gen_export_pubkey_pem(char *pem_buf, size_t buf_size)
{
    if (!s_keypair_loaded) {
        return ESP_ERR_INVALID_STATE;
    }

    int ret = mbedtls_pk_write_pubkey_pem(&s_keypair, (unsigned char *)pem_buf, buf_size);
    if (ret != 0) {
        ESP_LOGE(TAG, "导出公钥失败: -0x%04x", -ret);
        return ESP_FAIL;
    }

    return ESP_OK;
}

/**
 * 生成 CSR（证书签名请求）
 */
esp_err_t device_key_gen_generate_csr(const char *subject, char *csr_pem, size_t buf_size)
{
    if (!s_keypair_loaded) {
        return ESP_ERR_INVALID_STATE;
    }

    ESP_LOGI(TAG, "生成 CSR, Subject: %s", subject);

    mbedtls_x509write_csr csr;
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context ctr_drbg;

    mbedtls_x509write_csr_init(&csr);
    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&ctr_drbg);

    const char *pers = "device_csr_gen";
    mbedtls_ctr_drbg_seed(&ctr_drbg, mbedtls_entropy_func, &entropy,
                            (const unsigned char *)pers, strlen(pers));

    mbedtls_x509write_csr_set_key(&csr, &s_keypair);
    mbedtls_x509write_csr_set_md_alg(&csr, MBEDTLS_MD_SHA256);

    // 设置 Subject
    mbedtls_x509write_csr_set_subject_name(&csr, subject);

    // 生成 CSR PEM
    int ret = mbedtls_x509write_csr_pem(&csr, (unsigned char *)csr_pem, buf_size,
                                           mbedtls_ctr_drbg_random, &ctr_drbg);

    mbedtls_x509write_csr_free(&csr);
    mbedtls_entropy_free(&entropy);
    mbedtls_ctr_drbg_free(&ctr_drbg);

    if (ret != 0) {
        ESP_LOGE(TAG, "CSR 生成失败: -0x%04x", -ret);
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "CSR 生成成功");
    return ESP_OK;
}

/**
 * 使用设备私钥签名
 */
esp_err_t device_key_gen_sign(const uint8_t *data_hash, size_t hash_len,
                                uint8_t *signature, size_t *sig_len)
{
    if (!s_keypair_loaded) {
        return ESP_ERR_INVALID_STATE;
    }

    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context ctr_drbg;

    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&ctr_drbg);

    const char *pers = "device_sign";
    mbedtls_ctr_drbg_seed(&ctr_drbg, mbedtls_entropy_func, &entropy,
                            (const unsigned char *)pers, strlen(pers));

    int ret = mbedtls_pk_sign(&s_keypair, MBEDTLS_MD_SHA256, data_hash, hash_len,
                                signature, sig_len, mbedtls_ctr_drbg_random, &ctr_drbg);

    mbedtls_entropy_free(&entropy);
    mbedtls_ctr_drbg_free(&ctr_drbg);

    if (ret != 0) {
        ESP_LOGE(TAG, "签名失败: -0x%04x", -ret);
        return ESP_FAIL;
    }

    return ESP_OK;
}

/**
 * 检查密钥对是否已就绪
 */
bool device_key_gen_is_ready(void)
{
    return s_keypair_loaded;
}
