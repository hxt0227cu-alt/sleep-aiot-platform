/**
 * @file wifi_manager.h
 * @brief WiFi 管理模块头文件
 * @details 提供 WiFi 连接、SmartConfig 配网、断线重连等功能
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#ifndef __WIFI_MANAGER_H__
#define __WIFI_MANAGER_H__

#include <esp_wifi.h>
#include <esp_event.h>
#include <esp_smartconfig.h>
#include <esp_netif.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/event_groups.h>

#ifdef __cplusplus
extern "C" {
#endif

//=============================================================================
// 常量定义
//=============================================================================

#define WIFI_MAX_SSID_LEN           32      ///< SSID 最大长度
#define WIFI_MAX_PASS_LEN           64      ///< 密码最大长度
#define WIFI_MAX_RETRY_COUNT        5       ///< 最大重连次数
#define WIFI_RECONNECT_DELAY_MS     5000    ///< 重连延迟(ms)
#define WIFI_CONNECT_TIMEOUT_MS     30000   ///< 连接超时(ms)
#define WIFI_SCAN_TIMEOUT_MS        10000   ///< 扫描超时(ms)
#define SMARTCONFIG_TIMEOUT_MS      120000  ///< SmartConfig超时(ms)

// WiFi 事件组位定义
#define WIFI_CONNECTED_BIT      BIT0
#define WIFI_FAIL_BIT           BIT1
#define WIFI_GOT_IP_BIT         BIT2

//=============================================================================
// 枚举定义
//=============================================================================

/**
 * @brief WiFi 状态枚举
 */
typedef enum {
    WIFI_STATE_DISCONNECTED = 0,     ///< 未连接
    WIFI_STATE_CONNECTING,          ///< 正在连接
    WIFI_STATE_CONNECTED,           ///< 已连接
    WIFI_STATE_GOT_IP,              ///< 已获取IP
    WIFI_STATE_RECONNECTING,        ///< 正在重连
    WIFI_STATE_SMARTCONFIG,       ///< SmartConfig配网中
    WIFI_STATE_ERROR                ///< 错误状态
} wifi_state_t;

/**
 * @brief WiFi 事件类型
 */
typedef enum {
    WIFI_MANAGER_EVENT_NONE = 0,            ///< 无事件
    WIFI_MANAGER_EVENT_CONNECTED,           ///< 已连接
    WIFI_MANAGER_EVENT_DISCONNECTED,        ///< 已断开
    WIFI_MANAGER_EVENT_GOT_IP,              ///< 获取IP
    WIFI_MANAGER_EVENT_LOST_IP,             ///< 丢失IP
    WIFI_MANAGER_EVENT_SMARTCONFIG_DONE,    ///< SmartConfig完成
    WIFI_MANAGER_EVENT_SMARTCONFIG_TIMEOUT  ///< SmartConfig超时
} wifi_manager_event_t;

//=============================================================================
// 数据结构
//=============================================================================

/**
 * @brief WiFi 配置结构体
 */
typedef struct {
    char ssid[WIFI_MAX_SSID_LEN + 1];       ///< SSID
    char password[WIFI_MAX_PASS_LEN + 1]; ///< 密码
    uint8_t channel;                        ///< 信道 (0=自动)
    int8_t rssi;                            ///< 信号强度
    bool static_ip;                         ///< 是否使用静态IP
    uint32_t ip;                            ///< IP地址
    uint32_t gateway;                       ///< 网关
    uint32_t subnet;                        ///< 子网掩码
} wifi_manager_config_t;

/**
 * @brief WiFi 信息结构体
 */
typedef struct {
    wifi_state_t state;                     ///< 当前状态
    wifi_manager_config_t config;           ///< 当前配置
    uint32_t connect_time;                  ///< 连接时间(秒)
    uint32_t disconnect_count;              ///< 断开次数
    uint32_t reconnect_count;               ///< 重连次数
    char local_ip[16];                      ///< 本地IP地址
    char gateway_ip[16];                    ///< 网关IP
    char subnet_mask[16];                   ///< 子网掩码
    char mac_addr[18];                      ///< MAC地址
} wifi_info_t;

/**
 * @brief WiFi 扫描结果
 */
typedef struct {
    char ssid[WIFI_MAX_SSID_LEN + 1];       ///< SSID
    uint8_t bssid[6];                       ///< BSSID
    int8_t rssi;                            ///< 信号强度
    uint8_t channel;                        ///< 信道
    bool secure;                            ///< 是否需要密码
} wifi_ap_info_t;

/**
 * @brief WiFi 事件回调函数类型
 */
typedef void (*wifi_event_callback_t)(wifi_manager_event_t event, void* data);

//=============================================================================
// 函数声明
//=============================================================================

/**
 * @brief 初始化 WiFi 管理器
 * @return true 成功, false 失败
 */
bool wifi_manager_init(void);

/**
 * @brief 反初始化 WiFi 管理器
 */
void wifi_manager_deinit(void);

/**
 * @brief 连接到指定 WiFi
 * @param ssid SSID
 * @param password 密码
 * @param timeout_ms 超时时间(ms)
 * @return true 成功, false 失败
 */
bool wifi_manager_connect(const char* ssid, const char* password, uint32_t timeout_ms);

/**
 * @brief 断开 WiFi 连接
 */
void wifi_manager_disconnect(void);

/**
 * @brief 开始 SmartConfig 配网
 * @param timeout_ms 超时时间(ms), 0=无超时
 * @return true 开始成功, false 失败
 */
bool wifi_manager_start_smartconfig(uint32_t timeout_ms);

/**
 * @brief 停止 SmartConfig 配网
 */
void wifi_manager_stop_smartconfig(void);

/**
 * @brief 扫描 WiFi 热点
 * @param results 扫描结果数组
 * @param max_count 最大返回数量
 * @param timeout_ms 超时时间(ms)
 * @return int 实际扫描到的数量, -1=失败
 */
int wifi_manager_scan(wifi_ap_info_t* results, int max_count, uint32_t timeout_ms);

/**
 * @brief 获取 WiFi 信息
 * @return wifi_info_t* WiFi信息指针
 */
const wifi_info_t* wifi_manager_get_info(void);

/**
 * @brief 获取当前 WiFi 状态
 * @return wifi_state_t 状态
 */
wifi_state_t wifi_manager_get_state(void);

/**
 * @brief 检查是否已连接
 * @return true 已连接, false 未连接
 */
bool wifi_manager_is_connected(void);

/**
 * @brief 获取 RSSI (信号强度)
 * @return int8_t RSSI值, 0=未连接
 */
int8_t wifi_manager_get_rssi(void);

/**
 * @brief 设置 WiFi 事件回调
 * @param callback 回调函数
 */
void wifi_manager_set_event_callback(wifi_event_callback_t callback);

/**
 * @brief 保存 WiFi 配置到 NVS
 * @return true 成功, false 失败
 */
bool wifi_manager_save_config(void);

/**
 * @brief 从 NVS 加载 WiFi 配置
 * @return true 成功, false 失败
 */
bool wifi_manager_load_config(void);

/**
 * @brief 清除保存的 WiFi 配置
 * @return true 成功, false 失败
 */
bool wifi_manager_clear_config(void);

/**
 * @brief 设置静态 IP
 * @param ip IP地址
 * @param gateway 网关
 * @param subnet 子网掩码
 * @return true 成功, false 失败
 */
bool wifi_manager_set_static_ip(uint32_t ip, uint32_t gateway, uint32_t subnet);

/**
 * @brief 启用 DHCP
 * @return true 成功, false 失败
 */
bool wifi_manager_enable_dhcp(void);

/**
 * @brief 获取 MAC 地址
 * @param mac 输出缓冲区(至少6字节)
 */
void wifi_manager_get_mac(uint8_t* mac);

/**
 * @brief 获取 MAC 地址字符串
 * @return const char* MAC地址字符串
 */
const char* wifi_manager_get_mac_str(void);

#ifdef __cplusplus
}
#endif

#endif /* __WIFI_MANAGER_H__ */
