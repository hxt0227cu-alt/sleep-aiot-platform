//=============================================================================
// SIM800C GSM驱动模块 - 头文件
// 功能：AT指令通信、短信发送、电话拨打、网络连接
// 硬件：SIM800C模块，UART通信
// 框架：ESP-IDF 5.4.1
//=============================================================================

#ifndef GSM_DRIVER_H
#define GSM_DRIVER_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"
#include "driver/gpio.h"
#include "driver/uart.h"

#ifdef __cplusplus
extern "C" {
#endif

//=============================================================================
// 宏定义 - 硬件配置
//=============================================================================

// GSM模块UART配置
#define GSM_UART_NUM          UART_NUM_1      // 使用UART1
#define GSM_TX_PIN            GPIO_NUM_47     // ESP TX -> SIM800C_RXD, netlist U1.24
#define GSM_RX_PIN            GPIO_NUM_46     // ESP RX <- SIM800C_TXD, netlist U1.16
#define GSM_BAUD_RATE         115200         // 默认波特率
#define GSM_UART_BUF_SIZE     1024           // UART缓冲区大小
#define GSM_CMD_TIMEOUT_MS    5000           // AT指令超时时间
#define GSM_RESP_TIMEOUT_MS   10000          // 响应超时时间
#define GSM_MAX_AT_LEN        256            // AT指令最大长度
#define GSM_MAX_RESP_LEN      512            // 响应最大长度
#define GSM_MAX_SMS_LEN       160            // 短信最大长度（英文）
#define GSM_MAX_PHONE_LEN     20             // 手机号最大长度

// GSM模块电源控制引脚（可选）
#define GSM_PWR_PIN           (-1)           // Optional; not present in current netlist
#define GSM_RST_PIN           (-1)           // Optional; not present in current netlist

// GSM模块状态灯（可选）
#define GSM_NET_LED_PIN       GPIO_NUM_NC    // 网络状态灯（未使用）

//=============================================================================
// 枚举定义 - 错误码
//=============================================================================

typedef enum {
    GSM_ERR_NONE = 0,              // 无错误
    GSM_ERR_NOT_INIT,             // 未初始化
    GSM_ERR_UART_FAIL,             // UART通信失败
    GSM_ERR_TIMEOUT,              // 超时
    GSM_ERR_NO_RESPONSE,           // 无响应
    GSM_ERR_INVALID_RESPONSE,     // 响应无效
    GSM_ERR_CMD_FAILED,            // 指令执行失败
    GSM_ERR_NO_SIM,                // 无SIM卡
    GSM_ERR_NO_NETWORK,           // 无网络
    GSM_ERR_INVALID_PARAM,         // 参数无效
    GSM_ERR_BUFFER_OVERFLOW,      // 缓冲区溢出
    GSM_ERR_NOT_SUPPORTED,        // 不支持的功能
    GSM_ERR_BUSY,                  // 模块忙
    GSM_ERR_MEMORY,                // 内存不足
    GSM_ERR_UNKNOWN                // 未知错误
} gsm_error_t;

//=============================================================================
// 枚举定义 - 模块状态
//=============================================================================

typedef enum {
    GSM_STATE_UNINITIALIZED = 0,  // 未初始化
    GSM_STATE_INITIALIZED,        // 已初始化
    GSM_STATE_READY,              // 就绪（SIM卡正常）
    GSM_STATE_NETWORK_REGISTERED,  // 已注册网络
    GSM_STATE_GPRS_ATTACHED,      // GPRS已附着
    GSM_STATE_CONNECTED,          // 已连接（TCP/UDP）
    GSM_STATE_ERROR                // 错误状态
} gsm_state_t;

//=============================================================================
// 枚举定义 - 短信模式
//=============================================================================

typedef enum {
    GSM_SMS_MODE_TEXT = 0,         // 文本模式
    GSM_SMS_MODE_PDU              // PDU模式
} gsm_sms_mode_t;

//=============================================================================
// 枚举定义 - 字符集
//=============================================================================

typedef enum {
    GSM_CHARSET_GSM = 0,           // GSM字符集（英文）
    GSM_CHARSET_UCS2,              // UCS2字符集（中英文）
    GSM_CHARSET_IRA,               // IRA字符集
    GSM_CHARSET_UTF8               // UTF8字符集
} gsm_charset_t;

//=============================================================================
// 枚举定义 - 网络连接类型
//=============================================================================

typedef enum {
    GSM_NET_TYPE_TCP = 0,          // TCP连接
    GSM_NET_TYPE_UDP               // UDP连接
} gsm_net_type_t;

//=============================================================================
// 枚举定义 - 信号质量
//=============================================================================

typedef enum {
    GSM_SIGNAL_UNKNOWN = 0,        // 未知
    GSM_SIGNAL_POOR,               // 差（0-7）
    GSM_SIGNAL_FAIR,              // 一般（8-15）
    GSM_SIGNAL_GOOD,               // 良好（16-23）
    GSM_SIGNAL_EXCELLENT          // 优秀（24-31）
} gsm_signal_quality_t;

//=============================================================================
// 结构体定义 - 模块信息
//=============================================================================

typedef struct {
    char manufacturer[32];         // 厂商
    char model[32];                // 型号
    char revision[32];             // 版本
    char imei[16];                 // IMEI号
    char imsi[16];                 // IMSI号
    char ccid[21];                 // CCID号
} gsm_module_info_t;

//=============================================================================
// 结构体定义 - 网络信息
//=============================================================================

typedef struct {
    bool registered;               // 是否注册网络
    int signal_strength;           // 信号强度（0-31）
    int signal_ber;                // 误码率（0-7）
    gsm_signal_quality_t quality;  // 信号质量
    char operator_name[32];       // 运营商名称
    int operator_mode;             // 运营商模式
} gsm_network_info_t;

//=============================================================================
// 结构体定义 - 短信信息
//=============================================================================

typedef struct {
    int index;                     // 短信索引
    char phone[GSM_MAX_PHONE_LEN]; // 发送方号码
    char timestamp[32];            // 时间戳
    char content[GSM_MAX_SMS_LEN + 1]; // 短信内容
    bool read;                     // 是否已读
} gsm_sms_info_t;

//=============================================================================
// 结构体定义 - 网络连接信息
//=============================================================================

typedef struct {
    bool connected;                // 是否连接
    gsm_net_type_t type;           // 连接类型
    char remote_ip[16];            // 远程IP
    uint16_t remote_port;          // 远程端口
    uint16_t local_port;           // 本地端口
} gsm_net_connection_t;

//=============================================================================
// 结构体定义 - 统计信息
//=============================================================================

typedef struct {
    uint32_t total_commands;       // 总指令数
    uint32_t success_commands;     // 成功指令数
    uint32_t failed_commands;      // 失败指令数
    uint32_t timeout_count;        // 超时次数
    uint32_t sms_sent;             // 发送短信数
    uint32_t sms_received;         // 接收短信数
    uint32_t calls_made;           // 拨打电话数
    uint32_t bytes_sent;           // 发送字节数
    uint32_t bytes_received;       // 接收字节数
} gsm_stats_t;

//=============================================================================
// 回调函数类型定义
//=============================================================================

/**
 * @brief 短信接收回调函数
 * @param sms 短信信息
 * @param user_data 用户数据
 */
typedef void (*gsm_sms_callback_t)(const gsm_sms_info_t* sms, void* user_data);

/**
 * @brief 来电回调函数
 * @param phone 来电号码
 * @param user_data 用户数据
 */
typedef void (*gsm_call_callback_t)(const char* phone, void* user_data);

/**
 * @brief 网络数据接收回调函数
 * @param data 数据指针
 * @param len 数据长度
 * @param user_data 用户数据
 */
typedef void (*gsm_data_callback_t)(const uint8_t* data, size_t len, void* user_data);

/**
 * @brief 模块状态变化回调函数
 * @param state 新状态
 * @param user_data 用户数据
 */
typedef void (*gsm_state_callback_t)(gsm_state_t state, void* user_data);

//=============================================================================
// 核心API - 初始化和配置
//=============================================================================

/**
 * @brief 初始化GSM驱动
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_init(void);

/**
 * @brief 反初始化GSM驱动
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_deinit(void);

/**
 * @brief 检查GSM模块是否就绪
 * @return true就绪，false未就绪
 */
bool gsm_is_ready(void);

/**
 * @brief 获取GSM模块状态
 * @return 当前状态
 */
gsm_state_t gsm_get_state(void);

/**
 * @brief 获取最后一次错误
 * @return 错误码
 */
gsm_error_t gsm_get_last_error(void);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构体指针
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_get_stats(gsm_stats_t* stats);

/**
 * @brief 重置统计信息
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_reset_stats(void);

//=============================================================================
// 核心API - AT指令通信
//=============================================================================

/**
 * @brief 发送AT指令并等待响应
 * @param cmd AT指令（不含\r\n）
 * @param resp 响应缓冲区
 * @param resp_len 响应缓冲区大小
 * @param timeout_ms 超时时间（毫秒）
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_send_command(const char* cmd, char* resp, size_t resp_len, int timeout_ms);

/**
 * @brief 发送AT指令并检查是否返回OK
 * @param cmd AT指令（不含\r\n）
 * @param timeout_ms 超时时间（毫秒）
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_send_command_ok(const char* cmd, int timeout_ms);

/**
 * @brief 发送AT指令并解析响应
 * @param cmd AT指令（不含\r\n）
 * @param expected 期望的响应前缀
 * @param value 解析出的值
 * @param value_len 值缓冲区大小
 * @param timeout_ms 超时时间（毫秒）
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_send_command_parse(const char* cmd, const char* expected, 
                                  char* value, size_t value_len, int timeout_ms);

//=============================================================================
// 核心API - 模块信息查询
//=============================================================================

/**
 * @brief 获取模块信息
 * @param info 模块信息结构体指针
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_get_module_info(gsm_module_info_t* info);

/**
 * @brief 获取网络信息
 * @param info 网络信息结构体指针
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_get_network_info(gsm_network_info_t* info);

/**
 * @brief 检查SIM卡状态
 * @return true SIM卡就绪，false SIM卡未就绪
 */
bool gsm_check_sim(void);

/**
 * @brief 等待SIM卡就绪
 * @param timeout_ms 超时时间（毫秒）
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_wait_sim_ready(int timeout_ms);

/**
 * @brief 等待网络注册
 * @param timeout_ms 超时时间（毫秒）
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_wait_network_register(int timeout_ms);

//=============================================================================
// 核心API - 短信功能
//=============================================================================

/**
 * @brief 初始化短信功能
 * @param mode 短信模式
 * @param charset 字符集
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_sms_init(gsm_sms_mode_t mode, gsm_charset_t charset);

/**
 * @brief 发送短信（英文）
 * @param phone 手机号
 * @param content 短信内容
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_send_sms(const char* phone, const char* content);

/**
 * @brief 发送短信（中文，UCS2编码）
 * @param phone 手机号
 * @param content 短信内容（UTF-8）
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_send_sms_ucs2(const char* phone, const char* content);

/**
 * @brief 读取短信
 * @param index 短信索引
 * @param sms 短信信息结构体指针
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_read_sms(int index, gsm_sms_info_t* sms);

/**
 * @brief 删除短信
 * @param index 短信索引
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_delete_sms(int index);

/**
 * @brief 删除所有短信
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_delete_all_sms(void);

/**
 * @brief 设置短信接收回调
 * @param callback 回调函数
 * @param user_data 用户数据
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_set_sms_callback(gsm_sms_callback_t callback, void* user_data);

//=============================================================================
// 核心API - 电话功能
//=============================================================================

/**
 * @brief 拨打电话
 * @param phone 手机号
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_make_call(const char* phone);

/**
 * @brief 接听来电
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_answer_call(void);

/**
 * @brief 挂断电话
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_hangup_call(void);

/**
 * @brief 开启来电显示
 * @param enable true开启，false关闭
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_enable_caller_id(bool enable);

/**
 * @brief 设置来电回调
 * @param callback 回调函数
 * @param user_data 用户数据
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_set_call_callback(gsm_call_callback_t callback, void* user_data);

//=============================================================================
// 核心API - GPRS功能
//=============================================================================

/**
 * @brief 初始化GPRS
 * @param apn APN名称（如"CMNET"）
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_gprs_init(const char* apn);

/**
 * @brief 附着GPRS
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_gprs_attach(void);

/**
 * @brief 分离GPRS
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_gprs_detach(void);

/**
 * @brief 检查GPRS附着状态
 * @return true已附着，false未附着
 */
bool gsm_gprs_is_attached(void);

//=============================================================================
// 核心API - TCP/UDP网络功能
//=============================================================================

/**
 * @brief 启动网络连接
 * @param type 连接类型（TCP/UDP）
 * @param remote_ip 远程IP地址
 * @param remote_port 远程端口

 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_net_start(gsm_net_type_t type, const char* remote_ip, uint16_t remote_port);

/**
 * @brief 关闭网络连接
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_net_close(void);

/**
 * @brief 发送网络数据
 * @param data 数据指针
 * @param len 数据长度
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_net_send(const uint8_t* data, size_t len);

/**
 * @brief 发送网络数据（字符串）
 * @param str 字符串
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_net_send_string(const char* str);

/**
 * @brief 获取网络连接信息
 * @param conn 连接信息结构体指针
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_net_get_connection(gsm_net_connection_t* conn);

/**
 * @brief 设置数据接收回调
 * @param callback 回调函数
 * @param user_data 用户数据
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_set_data_callback(gsm_data_callback_t callback, void* user_data);

//=============================================================================
// 核心API - 回调和事件
//=============================================================================

/**
 * @brief 设置状态变化回调
 * @param callback 回调函数
 * @param user_data 用户数据
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_set_state_callback(gsm_state_callback_t callback, void* user_data);

/**
 * @brief 处理GSM事件（在主循环中调用）
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_process_events(void);

//=============================================================================
// 辅助API - 工具函数
//=============================================================================

/**
 * @brief UTF-8转UCS2编码
 * @param utf8 UTF-8字符串
 * @param ucs2 UCS2缓冲区
 * @param ucs2_len UCS2缓冲区大小
 * @return ESP_OK成功，其他失败
 */
esp_err_t gsm_utf8_to_ucs2(const char* utf8, uint8_t* ucs2, size_t ucs2_len);

/**
 * @brief 获取错误描述
 * @param error 错误码
 * @return 错误描述字符串
 */
const char* gsm_error_to_string(gsm_error_t error);

/**
 * @brief 获取状态描述
 * @param state 状态码
 * @return 状态描述字符串
 */
const char* gsm_state_to_string(gsm_state_t state);

#ifdef __cplusplus
}
#endif

#endif // GSM_DRIVER_H
