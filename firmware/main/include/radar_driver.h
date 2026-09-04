/**
 * @file radar_driver.h
 * @brief R60ABD1 60GHz毫米波雷达驱动头文件
 * @details 提供心率、呼吸率、睡眠状态、人体存在等生物特征检测功能
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 2.0.0
 * 
 * 支持的雷达型号：R60ABD1 (云帆瑞达/MicRadar)
 * 协议版本：V3.3 (2025-01-22)
 */

#ifndef __RADAR_DRIVER_H__
#define __RADAR_DRIVER_H__

#include <stdint.h>
#include <stdbool.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>

#ifdef __cplusplus
extern "C" {
#endif

//=============================================================================
// 版本信息
//=============================================================================
#define RADAR_DRIVER_VERSION_MAJOR  2
#define RADAR_DRIVER_VERSION_MINOR  0
#define RADAR_DRIVER_VERSION_PATCH  0
#define RADAR_DRIVER_VERSION_STR    "2.0.0"

//=============================================================================
// R60ABD1 协议常量定义
//=============================================================================

// 帧格式定义
#define R60ABD1_FRAME_HEADER_1      0x53    ///< 帧头字节1 'S'
#define R60ABD1_FRAME_HEADER_2      0x59    ///< 帧头字节2 'Y'
#define R60ABD1_FRAME_TAIL_1        0x54    ///< 帧尾字节1 'T'
#define R60ABD1_FRAME_TAIL_2        0x43    ///< 帧尾字节2 'C'
#define R60ABD1_FRAME_MIN_LEN     9       ///< 最小帧长度
#define R60ABD1_FRAME_MAX_LEN     256     ///< 最大帧长度

// 控制字定义
#define R60ABD1_CTRL_SYSTEM         0x01    ///< 系统功能/心跳
#define R60ABD1_CTRL_PRODUCT       0x02    ///< 产品信息
#define R60ABD1_CTRL_OTA            0x03    ///< OTA升级
#define R60ABD1_CTRL_WORK_STATE     0x05    ///< 工作状态
#define R60ABD1_CTRL_RANGE          0x07    ///< 探测范围
#define R60ABD1_CTRL_PRESENCE       0x80    ///< 人体存在检测
#define R60ABD1_CTRL_BREATHING      0x81    ///< 呼吸检测
#define R60ABD1_CTRL_SLEEP          0x84    ///< 睡眠监测
#define R60ABD1_CTRL_HEARTRATE      0x85    ///< 心率监测

// 系统功能命令字
#define R60ABD1_CMD_HEARTBEAT       0x01    ///< 心跳包
#define R60ABD1_CMD_RESET           0x02    ///< 复位
#define R60ABD1_CMD_QUERY_HEARTBEAT 0x80    ///< 查询心跳

// 人体存在检测命令字
#define R60ABD1_CMD_PRESENCE_SWITCH 0x00    ///< 开关设置
#define R60ABD1_CMD_PRESENCE_STATUS 0x01    ///< 存在信息
#define R60ABD1_CMD_MOTION_STATUS   0x02    ///< 运动信息
#define R60ABD1_CMD_BODY_MOVEMENT   0x03    ///< 体动参数
#define R60ABD1_CMD_BODY_DISTANCE  0x04    ///< 人体距离
#define R60ABD1_CMD_BODY_POSITION   0x05    ///< 人体方位

// 人体存在检测查询命令字（基础命令字 + 0x80）
#define R60ABD1_CMD_QUERY_PRESENCE_SWITCH 0x80    ///< 开关查询
#define R60ABD1_CMD_QUERY_PRESENCE_STATUS 0x81    ///< 存在信息查询
#define R60ABD1_CMD_QUERY_MOTION_STATUS   0x82    ///< 运动信息查询
#define R60ABD1_CMD_QUERY_BODY_MOVEMENT   0x83    ///< 体动参数查询
#define R60ABD1_CMD_QUERY_BODY_DISTANCE   0x84    ///< 人体距离查询
#define R60ABD1_CMD_QUERY_BODY_POSITION   0x85    ///< 人体方位查询

// 呼吸检测命令字
#define R60ABD1_CMD_BREATH_SWITCH   0x00    ///< 开关设置
#define R60ABD1_CMD_BREATH_STATUS   0x01    ///< 呼吸信息
#define R60ABD1_CMD_BREATH_RATE     0x02    ///< 呼吸数值
#define R60ABD1_CMD_BREATH_WAVE     0x05    ///< 呼吸波形

// 呼吸检测查询命令字（基础命令字 + 0x80）
#define R60ABD1_CMD_QUERY_BREATH_SWITCH   0x80    ///< 开关查询
#define R60ABD1_CMD_QUERY_BREATH_STATUS   0x81    ///< 呼吸信息查询
#define R60ABD1_CMD_QUERY_BREATH_RATE     0x82    ///< 呼吸数值查询
#define R60ABD1_CMD_QUERY_BREATH_WAVE     0x85    ///< 呼吸波形查询

// 心率监测命令字
#define R60ABD1_CMD_HEARTRATE_SWITCH  0x00  ///< 开关设置
#define R60ABD1_CMD_HEARTRATE_VALUE   0x02  ///< 心率数值
#define R60ABD1_CMD_HEARTRATE_WAVE    0x05  ///< 心率波形

// 心率监测查询命令字（基础命令字 + 0x80）
#define R60ABD1_CMD_QUERY_HEARTRATE_SWITCH  0x80  ///< 开关查询
#define R60ABD1_CMD_QUERY_HEARTRATE_VALUE   0x82  ///< 心率数值查询
#define R60ABD1_CMD_QUERY_HEARTRATE_WAVE    0x85  ///< 心率波形查询

// 睡眠监测命令字
#define R60ABD1_CMD_SLEEP_SWITCH      0x00  ///< 开关设置
#define R60ABD1_CMD_BED_STATUS        0x01  ///< 入床/离床
#define R60ABD1_CMD_SLEEP_STATE       0x02  ///< 睡眠状态
#define R60ABD1_CMD_AWAKE_TIME        0x03  ///< 清醒时长
#define R60ABD1_CMD_LIGHT_SLEEP_TIME  0x04  ///< 浅睡时长
#define R60ABD1_CMD_DEEP_SLEEP_TIME   0x05  ///< 深睡时长
#define R60ABD1_CMD_SLEEP_SCORE       0x06  ///< 睡眠质量评分
#define R60ABD1_CMD_SLEEP_COMPOSITE   0x0C  ///< 睡眠综合状态
#define R60ABD1_CMD_SLEEP_ANALYSIS    0x0D  ///< 睡眠质量分析

// 睡眠监测查询命令字（基础命令字 + 0x80）
#define R60ABD1_CMD_QUERY_SLEEP_SWITCH      0x80  ///< 开关查询
#define R60ABD1_CMD_QUERY_BED_STATUS        0x81  ///< 入床/离床查询
#define R60ABD1_CMD_QUERY_SLEEP_STATE       0x82  ///< 睡眠状态查询
#define R60ABD1_CMD_QUERY_AWAKE_TIME        0x83  ///< 清醒时长查询
#define R60ABD1_CMD_QUERY_LIGHT_SLEEP_TIME  0x84  ///< 浅睡时长查询
#define R60ABD1_CMD_QUERY_DEEP_SLEEP_TIME   0x85  ///< 深睡时长查询
#define R60ABD1_CMD_QUERY_SLEEP_SCORE       0x86  ///< 睡眠质量评分查询
#define R60ABD1_CMD_QUERY_SLEEP_COMPOSITE   0x8C  ///< 睡眠综合状态查询
#define R60ABD1_CMD_QUERY_SLEEP_ANALYSIS    0x8D  ///< 睡眠质量分析查询

// UART配置
#define R60ABD1_UART_BAUD           115200
#define R60ABD1_UART_DATA_BITS      8
#define R60ABD1_UART_STOP_BITS      1
#define R60ABD1_UART_PARITY         UART_PARITY_DISABLE

//=============================================================================
// 状态码定义
//=============================================================================

// 通用状态码
#define R60ABD1_STATUS_OFF          0x00
#define R60ABD1_STATUS_ON           0x01
#define R60ABD1_STATUS_ACTIVE       0x02
#define R60ABD1_STATUS_LOW          0x03
#define R60ABD1_STATUS_NONE         0x04

// 存在状态
#define R60ABD1_PRESENCE_NONE       0x00
#define R60ABD1_PRESENCE_DETECTED   0x01

// 运动状态
#define R60ABD1_MOTION_NONE         0x00
#define R60ABD1_MOTION_STATIONARY   0x01
#define R60ABD1_MOTION_ACTIVE       0x02

// 呼吸状态
#define R60ABD1_BREATH_NORMAL       0x01
#define R60ABD1_BREATH_HIGH         0x02
#define R60ABD1_BREATH_LOW          0x03
#define R60ABD1_BREATH_NONE         0x04

// 睡眠状态
#define R60ABD1_SLEEP_DEEP          0x00
#define R60ABD1_SLEEP_LIGHT         0x01
#define R60ABD1_SLEEP_AWAKE         0x02
#define R60ABD1_SLEEP_NONE          0x03

// 入床/离床状态
#define R60ABD1_BED_AWAY            0x00
#define R60ABD1_BED_IN              0x01
#define R60ABD1_BED_NONE            0x02

// 睡眠异常状态
#define R60ABD1_SLEEP_ERR_SHORT       0x00
#define R60ABD1_SLEEP_ERR_LONG        0x01
#define R60ABD1_SLEEP_ERR_NOBODY      0x02
#define R60ABD1_SLEEP_ERR_NORMAL      0x03

// 睡眠质量评级
#define R60ABD1_SLEEP_RATING_NONE     0x00
#define R60ABD1_SLEEP_RATING_GOOD     0x01
#define R60ABD1_SLEEP_RATING_NORMAL   0x02
#define R60ABD1_SLEEP_RATING_POOR     0x03

// 挣扎状态
#define R60ABD1_STRUGGLE_OFF          0x00
#define R60ABD1_STRUGGLE_NORMAL       0x01
#define R60ABD1_STRUGGLE_ABNORMAL     0x02

//=============================================================================
// 数据结构定义
//=============================================================================

// 雷达状态枚举
typedef enum {
    RADAR_STATE_UNINITIALIZED = 0,
    RADAR_STATE_INITIALIZED,
    RADAR_STATE_RUNNING,
    RADAR_STATE_STOPPED,
    RADAR_STATE_ERROR
} radar_state_t;

// 数据类型枚举
typedef enum {
    RADAR_DATA_TYPE_NONE = 0,
    RADAR_DATA_TYPE_PRESENCE,       // 人体存在
    RADAR_DATA_TYPE_MOTION,         // 运动状态
    RADAR_DATA_TYPE_BODY_MOVEMENT,  // 体动参数
    RADAR_DATA_TYPE_BODY_DISTANCE,  // 人体距离
    RADAR_DATA_TYPE_BODY_POSITION,  // 人体方位
    RADAR_DATA_TYPE_BREATH_STATUS,  // 呼吸状态
    RADAR_DATA_TYPE_BREATH_RATE,    // 呼吸率
    RADAR_DATA_TYPE_BREATH_WAVE,    // 呼吸波形
    RADAR_DATA_TYPE_HEART_RATE,     // 心率
    RADAR_DATA_TYPE_HEART_WAVE,     // 心率波形
    RADAR_DATA_TYPE_BED_STATUS,     // 入床/离床
    RADAR_DATA_TYPE_SLEEP_STATE,    // 睡眠状态
    RADAR_DATA_TYPE_SLEEP_TIME,     // 睡眠时长
    RADAR_DATA_TYPE_SLEEP_SCORE,    // 睡眠质量评分
    RADAR_DATA_TYPE_SLEEP_COMPOSITE,// 睡眠综合状态
    RADAR_DATA_TYPE_SLEEP_ANALYSIS, // 睡眠质量分析
    RADAR_DATA_TYPE_RAW_FRAME       // 原始数据帧
} radar_data_type_t;

// 人体存在数据结构
typedef struct {
    uint8_t presence;           // 0=无人, 1=有人
    uint32_t timestamp;
} radar_presence_t;

// 运动状态数据结构
typedef struct {
    uint8_t motion_state;       // 0=无, 1=静止, 2=活跃
    uint32_t timestamp;
} radar_motion_t;

// 体动参数数据结构
typedef struct {
    uint8_t movement_level;     // 0-100
    uint32_t timestamp;
} radar_body_movement_t;

// 人体距离数据结构
typedef struct {
    uint16_t distance_cm;       // 0-65535 cm
    uint32_t timestamp;
} radar_body_distance_t;

// 人体方位数据结构
typedef struct {
    int16_t x;                  // X坐标 (cm)
    int16_t y;                  // Y坐标 (cm)
    int16_t z;                  // Z坐标 (cm)
    uint32_t timestamp;
} radar_body_position_t;

// 呼吸状态数据结构
typedef struct {
    uint8_t breath_state;       // 1=正常, 2=过高, 3=过低, 4=无
    uint32_t timestamp;
} radar_breath_status_t;

// 呼吸率数据结构
typedef struct {
    uint8_t breath_rate;        // 0-35 次/min
    uint32_t timestamp;
} radar_breath_rate_t;

// 呼吸波形数据结构
typedef struct {
    uint8_t wave_data[5];       // 5个波形点
    int8_t wave_value[5];       // 实际波形值（-128~127）
    uint32_t timestamp;
} radar_breath_wave_t;

// 心率数据结构
typedef struct {
    uint8_t heart_rate;         // 60-120 bpm
    uint32_t timestamp;
} radar_heart_rate_t;

// 心率波形数据结构
typedef struct {
    uint8_t wave_data[5];       // 5个波形点
    int8_t wave_value[5];       // 实际波形值（-128~127）
    uint32_t timestamp;
} radar_heart_wave_t;

// 入床/离床数据结构
typedef struct {
    uint8_t bed_state;          // 0=离床, 1=入床, 2=无
    uint32_t timestamp;
} radar_bed_status_t;

// 睡眠状态数据结构
typedef struct {
    uint8_t sleep_state;        // 0=深睡, 1=浅睡, 2=清醒, 3=无
    uint32_t timestamp;
} radar_sleep_state_t;

// 睡眠时长数据结构
typedef struct {
    uint16_t awake_time;        // 清醒时长（分钟）
    uint16_t light_sleep_time;  // 浅睡时长（分钟）
    uint16_t deep_sleep_time;   // 深睡时长（分钟）
    uint32_t timestamp;
} radar_sleep_time_t;

// 睡眠质量评分数据结构
typedef struct {
    uint8_t sleep_score;        // 0-100分
    uint32_t timestamp;
} radar_sleep_score_t;

// 睡眠综合状态数据结构（8字节）
typedef struct {
    uint8_t presence;           // 存在状态: 1=有人, 0=无人
    uint8_t sleep_state;        // 睡眠状态: 0=深睡, 1=浅睡, 2=清醒, 3=离床
    uint8_t avg_breath;         // 平均呼吸（10分钟内）
    uint8_t avg_heart;          // 平均心跳（10分钟内）
    uint8_t turn_over_count;    // 翻身次数
    uint8_t large_move_pct;     // 大幅度体动占比(0-100)
    uint8_t small_move_pct;     // 小幅度体动占比(0-100)
    uint8_t apnea_count;        // 呼吸暂停次数（预留）
    uint32_t timestamp;
} radar_sleep_composite_t;

// 睡眠质量分析数据结构（12字节）
typedef struct {
    uint8_t sleep_score;        // 睡眠质量评分(0-100)
    uint16_t total_sleep_time;  // 睡眠总时长(分钟)
    uint8_t awake_pct;          // 清醒时长占比(0-100)
    uint8_t light_sleep_pct;    // 浅睡时长占比(0-100)
    uint8_t deep_sleep_pct;     // 深睡时长占比(0-100)
    uint8_t away_time;          // 离床时长
    uint8_t away_count;         // 离床次数
    uint8_t turn_over_count;    // 翻身次数
    uint8_t avg_breath;         // 平均呼吸
    uint8_t avg_heart;          // 平均心跳
    uint8_t apnea_count;        // 呼吸暂停次数（预留）
    uint32_t timestamp;
} radar_sleep_analysis_t;

// 原始数据帧结构
typedef struct {
    uint8_t header[2];          // 帧头 0x53 0x59
    uint8_t ctrl;               // 控制字
    uint8_t cmd;                // 命令字
    uint16_t data_len;          // 数据长度（高字节在前）
    uint8_t data[R60ABD1_FRAME_MAX_LEN]; // 数据
    uint8_t checksum;           // 校验和
    uint8_t tail[2];            // 帧尾 0x54 0x43
    uint32_t timestamp;
} radar_raw_frame_t;

// 统一数据联合体
typedef union {
    radar_presence_t presence;
    radar_motion_t motion;
    radar_body_movement_t body_movement;
    radar_body_distance_t body_distance;
    radar_body_position_t body_position;
    radar_breath_status_t breath_status;
    radar_breath_rate_t breath_rate;
    radar_breath_wave_t breath_wave;
    radar_heart_rate_t heart_rate;
    radar_heart_wave_t heart_wave;
    radar_bed_status_t bed_status;
    radar_sleep_state_t sleep_state;
    radar_sleep_time_t sleep_time;
    radar_sleep_score_t sleep_score;
    radar_sleep_composite_t sleep_composite;
    radar_sleep_analysis_t sleep_analysis;
    radar_raw_frame_t raw_frame;
} radar_data_union_t;

// 雷达配置结构
typedef struct {
    // 功能开关
    bool presence_enable;       // 人体存在检测
    bool breath_enable;         // 呼吸检测
    bool heart_rate_enable;     // 心率监测
    bool sleep_enable;          // 睡眠监测
    
    // 上报控制
    bool enable_raw_data;       // 是否输出原始数据
    bool enable_waveform;       // 是否输出波形数据
    
    // 阈值设置
    uint8_t low_breath_threshold;   // 低缓呼吸判读阈值(10-20)
    uint8_t struggle_sensitivity;   // 挣扎判读灵敏度(0-2)
    uint8_t nobody_timeout;         // 无人计时时长(30-180分钟)
    uint8_t sleep_cutoff_time;      // 睡眠截止时长(5-120分钟)
    
    // 数据超时
    uint16_t data_timeout_ms;       // 数据超时时间
} radar_config_t;

// 雷达统计信息
typedef struct {
    uint32_t total_frames;      // 总帧数
    uint32_t valid_frames;      // 有效帧数
    uint32_t error_frames;      // 错误帧数
    uint32_t timeout_count;     // 超时次数
    uint32_t last_frame_time;   // 最后帧时间
} radar_stats_t;

// 雷达错误码
typedef enum {
    RADAR_ERR_NONE = 0,
    RADAR_ERR_NOT_INITIALIZED,
    RADAR_ERR_ALREADY_RUNNING,
    RADAR_ERR_UART_FAILED,
    RADAR_ERR_MEMORY_FAILED,
    RADAR_ERR_TIMEOUT,
    RADAR_ERR_INVALID_PARAM,
    RADAR_ERR_CHECKSUM_FAILED,
    RADAR_ERR_FRAME_INVALID,
    RADAR_ERR_COMMAND_FAILED
} radar_error_t;

//=============================================================================
// 回调函数类型定义
//=============================================================================

// 数据回调函数类型
typedef void (*radar_data_callback_t)(
    radar_data_type_t type,
    const radar_data_union_t* data,
    void* user_data
);

// 事件回调函数类型
typedef void (*radar_event_callback_t)(
    radar_state_t state,
    radar_error_t error,
    void* user_data
);

// 原始帧回调函数类型
typedef void (*radar_raw_callback_t)(
    const radar_raw_frame_t* frame,
    void* user_data
);

//=============================================================================
// API 函数声明
//=============================================================================

/**
 * @brief 初始化雷达驱动
 * @param config 雷达配置，为NULL时使用默认配置
 * @return 成功返回RADAR_ERR_NONE，失败返回错误码
 */
radar_error_t radar_init(const radar_config_t* config);

/**
 * @brief 反初始化雷达驱动
 */
void radar_deinit(void);

/**
 * @brief 启动雷达数据采集
 * @return 成功返回RADAR_ERR_NONE，失败返回错误码
 */
radar_error_t radar_start(void);

/**
 * @brief 停止雷达数据采集
 */
void radar_stop(void);

/**
 * @brief 获取当前雷达状态
 * @return 雷达状态
 */
radar_state_t radar_get_state(void);

/**
 * @brief 获取最后错误码
 * @return 错误码
 */
radar_error_t radar_get_last_error(void);

/**
 * @brief 设置雷达配置
 * @param config 新的配置
 * @return 成功返回RADAR_ERR_NONE，失败返回错误码
 */
radar_error_t radar_set_config(const radar_config_t* config);

/**
 * @brief 获取当前配置
 * @param config 配置结构指针，用于存储结果
 */
void radar_get_config(radar_config_t* config);

/**
 * @brief 注册数据回调函数
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void radar_register_data_callback(radar_data_callback_t callback, void* user_data);

/**
 * @brief 注册事件回调函数
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void radar_register_event_callback(radar_event_callback_t callback, void* user_data);

/**
 * @brief 注册原始帧回调函数
 * @param callback 回调函数指针
 * @param user_data 用户数据
 */
void radar_register_raw_callback(radar_raw_callback_t callback, void* user_data);

/**
 * @brief 发送原始命令到雷达
 * @param ctrl 控制字
 * @param cmd 命令字
 * @param data 数据指针
 * @param len 数据长度
 * @return 成功返回RADAR_ERR_NONE，失败返回错误码
 */
radar_error_t radar_send_command(uint8_t ctrl, uint8_t cmd, 
                                   const uint8_t* data, uint16_t len);

/**
 * @brief 发送查询命令
 * @param ctrl 控制字
 * @param cmd 命令字
 * @return 成功返回RADAR_ERR_NONE，失败返回错误码
 */
radar_error_t radar_query(uint8_t ctrl, uint8_t cmd);

/**
 * @brief 设置功能开关
 * @param ctrl 控制字（功能类别）
 * @param enable true=开, false=关
 * @return 成功返回RADAR_ERR_NONE，失败返回错误码
 */
radar_error_t radar_set_function_switch(uint8_t ctrl, bool enable);

/**
 * @brief 复位雷达模块
 * @return 成功返回RADAR_ERR_NONE，失败返回错误码
 */
radar_error_t radar_reset(void);

/**
 * @brief 查询心跳
 * @return 成功返回RADAR_ERR_NONE，失败返回错误码
 */
radar_error_t radar_heartbeat(void);

/**
 * @brief 获取统计信息
 * @param stats 统计信息结构指针
 */
void radar_get_stats(radar_stats_t* stats);

/**
 * @brief 清除统计信息
 */
void radar_clear_stats(void);

//=============================================================================
// 便捷查询函数
//=============================================================================

// 人体存在检测查询
radar_error_t radar_query_presence(radar_presence_t* data);
radar_error_t radar_query_motion(radar_motion_t* data);
radar_error_t radar_query_body_movement(radar_body_movement_t* data);
radar_error_t radar_query_body_distance(radar_body_distance_t* data);
radar_error_t radar_query_body_position(radar_body_position_t* data);

// 呼吸检测查询
radar_error_t radar_query_breath_status(radar_breath_status_t* data);
radar_error_t radar_query_breath_rate(radar_breath_rate_t* data);

// 心率监测查询
radar_error_t radar_query_heart_rate(radar_heart_rate_t* data);

// 睡眠监测查询
radar_error_t radar_query_bed_status(radar_bed_status_t* data);
radar_error_t radar_query_sleep_state(radar_sleep_state_t* data);
radar_error_t radar_query_sleep_score(radar_sleep_score_t* data);

#ifdef __cplusplus
}
#endif

#endif /* __RADAR_DRIVER_H__ */
