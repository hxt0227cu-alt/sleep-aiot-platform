/**
 * @file ota_service.h
 * @brief OTA升级服务头文件
 * @details 实现固件下载、版本校验、MD5校验、升级执行、进度上报、回滚机制
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __OTA_SERVICE_H__
#define __OTA_SERVICE_H__

#include <stdint.h>
#include <stdbool.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#ifdef __cplusplus
extern "C" {
#endif

//=============================================================================
// 版本信息
//=============================================================================
#define OTA_SERVICE_VERSION_MAJOR  1
#define OTA_SERVICE_VERSION_MINOR  0
#define OTA_SERVICE_VERSION_PATCH  0
#define OTA_SERVICE_VERSION_STR    "1.0.0"

//=============================================================================
// 配置常量
//=============================================================================
#define OTA_MAX_URL_LENGTH        256         ///< 最大URL长度
#define OTA_MAX_VERSION_LENGTH    32          ///< 最大版本号长度
#define OTA_MAX_MD5_LENGTH       32          ///< 最大MD5长度
#define OTA_BUFFER_SIZE          4096        ///< 缓冲区大小
#ifndef OTA_TIMEOUT_MS
#define OTA_TIMEOUT_MS           30000       ///< 超时时时间(ms)
#endif
#define OTA_REBOOT_DELAY_MS      2000        ///< 重启延迟(ms)

//=============================================================================
// OTA状态枚举
//=============================================================================
typedef enum {
    OTA_STATE_IDLE = 0,
    OTA_STATE_DOWNLOADING,
    OTA_STATE_VERIFYING,
    OTA_STATE_INSTALLING,
    OTA_STATE_COMPLETED,
    OTA_STATE_FAILED,
    OTA_STATE_ROLLBACK
} ota_state_t;

//=============================================================================
// OTA事件枚举
//=============================================================================
typedef enum {
    OTA_EVENT_START = 0,
    OTA_EVENT_PROGRESS,
    OTA_EVENT_SUCCESS,
    OTA_EVENT_FAILED,
    OTA_EVENT_ROLLBACK
} ota_event_t;

//=============================================================================
// OTA配置结构
//=============================================================================
typedef struct {
    char url[OTA_MAX_URL_LENGTH];      ///< 固件下载URL
    char version[OTA_MAX_VERSION_LENGTH]; ///< 目标版本号
    char md5[OTA_MAX_MD5_LENGTH];     ///< MD5校验值
    bool verify_md5;                  ///< 是否启用MD5校验
    bool auto_reboot;                 ///< 升级完成后自动重启
    uint32_t timeout_ms;               ///< 超时时间(ms)
} ota_config_t;

//=============================================================================
// OTA状态信息结构
//=============================================================================
typedef struct {
    ota_state_t state;                ///< 当前状态
    uint32_t total_size;               ///< 总大小(字节)
    uint32_t downloaded_size;           ///< 已下载大小(字节)
    uint8_t progress;                  ///< 进度(0-100)
    char current_version[OTA_MAX_VERSION_LENGTH]; ///< 当前版本号
    char error_message[128];          ///< 错误信息
} ota_status_t;

//=============================================================================
// 统计信息结构
//=============================================================================
typedef struct {
    uint32_t total_attempts;            ///< 总尝试次数
    uint32_t success_count;             ///< 成功次数
    uint32_t failed_count;             ///< 失败次数
    uint32_t rollback_count;            ///< 回滚次数
    uint32_t last_update_time;          ///< 最后更新时间
} ota_stats_t;

//=============================================================================
// 错误码枚举
//=============================================================================
typedef enum {
    OTA_ERR_NONE = 0,
    OTA_ERR_NOT_INITIALIZED,
    OTA_ERR_ALREADY_RUNNING,
    OTA_ERR_INVALID_URL,
    OTA_ERR_DOWNLOAD_FAILED,
    OTA_ERR_VERIFY_FAILED,
    OTA_ERR_INSTALL_FAILED,
    OTA_ERR_ROLLBACK_FAILED,
    OTA_ERR_MEMORY_FAILED,
    OTA_ERR_NETWORK_ERROR,
    OTA_ERR_INVALID_PARAM,
    OTA_ERR_HARDWARE_ERROR
} ota_error_t;

//=============================================================================
// 回调函数类型定义
//=============================================================================

/**
 * @brief OTA事件回调函数类型
 * @param event 事件类型
 * @param status OTA状态信息
 * @param user_data 用户数据
 */
typedef void (*ota_event_callback_t)(
    ota_event_t event,
    const ota_status_t* status,
    void* user_data
);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化OTA服务
 * @param config 配置，为NULL时使用默认配置
 * @return 成功返回OTA_ERR_NONE，失败返回错误码
 */
ota_error_t ota_service_init(const ota_config_t* config);

/**
 * @brief 反初始化OTA服务
 */
void ota_service_deinit(void);

/**
 * @brief 开始OTA升级
 * @param url 固件下载URL
 * @param version 目标版本号
 * @param md5 MD5校验值，为NULL时不校验
 * @return 成功返回OTA_ERR_NONE，失败返回错误码
 */
ota_error_t ota_service_start(const char* url, const char* version, const char* md5);

/**
 * @brief 取消OTA升级
 * @return 成功返回OTA_ERR_NONE，失败返回错误码
 */
ota_error_t ota_service_cancel(void);

/**
 * @brief 获取当前状态
 * @return OTA状态
 */
ota_state_t ota_service_get_state(void);

/**
 * @brief 获取状态信息
 * @param status 状态结构指针，用于存储结果
 */
void ota_service_get_status(ota_status_t* status);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构指针
 */
void ota_service_get_stats(ota_stats_t* stats);

/**
 * @brief 设置事件回调
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void ota_service_set_event_callback(ota_event_callback_t callback, void* user_data);

/**
 * @brief 获取当前固件版本
 * @param version 版本号缓冲区
 * @param max_len 缓冲区最大长度
 * @return 成功返回OTA_ERR_NONE，失败返回错误码
 */
ota_error_t ota_service_get_current_version(char* version, size_t max_len);

/**
 * @brief 检查是否有可用更新
 * @param update_url 更新检查URL
 * @param latest_version 最新版本号缓冲区
 * @param max_len 缓冲区最大长度
 * @return 成功返回OTA_ERR_NONE，失败返回错误码
 */
ota_error_t ota_service_check_update(const char* update_url, char* latest_version, size_t max_len);

#ifdef __cplusplus
}
#endif

#endif /* __OTA_SERVICE_H__ */
