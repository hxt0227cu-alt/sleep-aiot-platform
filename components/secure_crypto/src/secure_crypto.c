/**
 * @file secure_crypto.c
 * @brief 安全加密组件实现
 */

#include "secure_crypto.h"
#include "esp_log.h"
#include "mbedtls/gcm.h"
#include "mbedtls/sha256.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include <string.h>

static const char *TAG = "secure_crypto";
static mbedtls_ctr_drbg_context s_ctr_drbg;
static bool s_initialized = false;

esp_err_t secure_crypto_init(void)
{
    if (s_initialized) return ESP_OK;
    ESP_LOGI(TAG, "初始化安全加密组件");

    mbedtls_entropy_context entropy;
    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&s_ctr_drbg);

    const char *pers = "secure_crypto";
    int ret = mbedtls_ctr_drbg_seed(&s_ctr_drbg, mbedtls_entropy_func, &entropy,
                                       (const unsigned char *)pers, strlen(pers));
    mbedtls_entropy_free(&entropy);

    if (ret != 0) {
        ESP_LOGE(TAG, "RNG 初始化失败: -0x%04x", -ret);
        return ESP_FAIL;
    }
    s_initialized = true;
    return ESP_OK;
}

esp_err_t secure_crypto_aes_gcm_encrypt(
    const uint8_t *key, const uint8_t *iv,
    const uint8_t *aad, size_t aad_len,
    const uint8_t *plaintext, size_t plaintext_len,
    uint8_t *ciphertext, uint8_t *tag)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    int ret = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, SECURE_CRYPTO_KEY_SIZE * 8);
    if (ret == 0) {
        ret = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, plaintext_len,
                                          iv, SECURE_CRYPTO_IV_SIZE, aad, aad_len,
                                          plaintext, ciphertext, SECURE_CRYPTO_TAG_SIZE, tag);
    }
    mbedtls_gcm_free(&gcm);
    return ret == 0 ? ESP_OK : ESP_FAIL;
}

esp_err_t secure_crypto_aes_gcm_decrypt(
    const uint8_t *key, const uint8_t *iv,
    const uint8_t *aad, size_t aad_len,
    const uint8_t *ciphertext, size_t ciphertext_len,
    const uint8_t *tag, uint8_t *plaintext)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    int ret = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, SECURE_CRYPTO_KEY_SIZE * 8);
    if (ret == 0) {
        ret = mbedtls_gcm_auth_decrypt(&gcm, ciphertext_len,
                                         iv, SECURE_CRYPTO_IV_SIZE, aad, aad_len,
                                         tag, SECURE_CRYPTO_TAG_SIZE, ciphertext, plaintext);
    }
    mbedtls_gcm_free(&gcm);
    return ret == 0 ? ESP_OK : ESP_ERR_INVALID_MAC;
}

esp_err_t secure_crypto_sha256(const uint8_t *data, size_t len, uint8_t *hash)
{
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0);
    mbedtls_sha256_update(&ctx, data, len);
    mbedtls_sha256_finish(&ctx, hash);
    mbedtls_sha256_free(&ctx);
    return ESP_OK;
}

esp_err_t secure_crypto_ecdsa_sign(
    const uint8_t *priv_key, const uint8_t *hash, uint8_t *signature)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    mbedtls_ecdsa_context ctx;
    mbedtls_ecdsa_init(&ctx);
    mbedtls_mpi d;
    mbedtls_mpi_init(&d);
    mbedtls_mpi_read_binary(&d, priv_key, SECURE_CRYPTO_KEY_SIZE);

    int ret = mbedtls_ecdsa_genkey(&ctx, MBEDTLS_ECP_DP_SECP256R1, NULL, NULL);
    if (ret == 0) {
        mbedtls_mpi_copy(&ctx.d, &d);
        mbedtls_ecp_mul(&ctx.grp, &ctx.Q, &ctx.d, &ctx.grp.G, NULL, NULL);
        mbedtls_mpi r, s;
        mbedtls_mpi_init(&r);
        mbedtls_mpi_init(&s);
        ret = mbedtls_ecdsa_sign(&ctx.grp, &r, &s, &ctx.d, hash, SECURE_CRYPTO_HASH_SIZE,
                                   mbedtls_ctr_drbg_random, &s_ctr_drbg);
        if (ret == 0) {
            mbedtls_mpi_write_binary(&r, signature, 32);
            mbedtls_mpi_write_binary(&s, signature + 32, 32);
        }
        mbedtls_mpi_free(&r);
        mbedtls_mpi_free(&s);
    }
    mbedtls_mpi_free(&d);
    mbedtls_ecdsa_free(&ctx);
    return ret == 0 ? ESP_OK : ESP_FAIL;
}

esp_err_t secure_crypto_ecdsa_verify(
    const uint8_t *pub_key, const uint8_t *hash, const uint8_t *signature)
{
    mbedtls_ecdsa_context ctx;
    mbedtls_ecdsa_init(&ctx);
    mbedtls_ecp_group_load(&ctx.grp, MBEDTLS_ECP_DP_SECP256R1);
    mbedtls_ecp_point_read_binary(&ctx.grp, &ctx.Q, pub_key, 65);

    mbedtls_mpi r, s;
    mbedtls_mpi_init(&r);
    mbedtls_mpi_init(&s);
    mbedtls_mpi_read_binary(&r, signature, 32);
    mbedtls_mpi_read_binary(&s, signature + 32, 32);

    int ret = mbedtls_ecdsa_verify(&ctx.grp, hash, SECURE_CRYPTO_HASH_SIZE, &ctx.Q, &r, &s);

    mbedtls_mpi_free(&r);
    mbedtls_mpi_free(&s);
    mbedtls_ecdsa_free(&ctx);
    return ret == 0 ? ESP_OK : ESP_ERR_INVALID_MAC;
}

esp_err_t secure_crypto_random(uint8_t *output, size_t len)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    return mbedtls_ctr_drbg_random(&s_ctr_drbg, output, len) == 0 ? ESP_OK : ESP_FAIL;
}

int secure_crypto_constant_time_cmp(const uint8_t *a, const uint8_t *b, size_t len)
{
    volatile uint8_t result = 0;
    for (size_t i = 0; i < len; i++) result |= a[i] ^ b[i];
    return result == 0 ? 0 : 1;
}

void secure_crypto_cleanse(void *ptr, size_t len)
{
    volatile uint8_t *p = (volatile uint8_t *)ptr;
    while (len--) *p++ = 0;
}
