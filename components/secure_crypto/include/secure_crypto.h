/**
 * @file secure_crypto.h
 * @brief 安全加密组件 - 硬件加速的加密操作接口
 */

#ifndef SECURE_CRYPTO_H
#define SECURE_CRYPTO_H

#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SECURE_CRYPTO_KEY_SIZE 32
#define SECURE_CRYPTO_IV_SIZE 12
#define SECURE_CRYPTO_TAG_SIZE 16
#define SECURE_CRYPTO_HASH_SIZE 32
#define SECURE_CRYPTO_SIGN_SIZE 64

esp_err_t secure_crypto_init(void);

esp_err_t secure_crypto_aes_gcm_encrypt(
    const uint8_t *key, const uint8_t *iv,
    const uint8_t *aad, size_t aad_len,
    const uint8_t *plaintext, size_t plaintext_len,
    uint8_t *ciphertext, uint8_t *tag);

esp_err_t secure_crypto_aes_gcm_decrypt(
    const uint8_t *key, const uint8_t *iv,
    const uint8_t *aad, size_t aad_len,
    const uint8_t *ciphertext, size_t ciphertext_len,
    const uint8_t *tag, uint8_t *plaintext);

esp_err_t secure_crypto_sha256(const uint8_t *data, size_t len, uint8_t *hash);

esp_err_t secure_crypto_ecdsa_sign(
    const uint8_t *priv_key, const uint8_t *hash, uint8_t *signature);

esp_err_t secure_crypto_ecdsa_verify(
    const uint8_t *pub_key, const uint8_t *hash, const uint8_t *signature);

esp_err_t secure_crypto_random(uint8_t *output, size_t len);

int secure_crypto_constant_time_cmp(const uint8_t *a, const uint8_t *b, size_t len);

void secure_crypto_cleanse(void *ptr, size_t len);

#ifdef __cplusplus
}
#endif

#endif
