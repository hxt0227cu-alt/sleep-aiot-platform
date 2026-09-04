//=============================================================================
// 数据解析器实现
//=============================================================================

#include <stdint.h>
#include <string.h>
#include "radar_driver.h"
#include "config.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "driver/uart.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

#define millis() (esp_timer_get_time() / 1000)
#define delay(ms) vTaskDelay(pdMS_TO_TICKS(ms))

static void parse_presence_data(const radar_raw_frame_t* frame);
static void parse_breathing_data(const radar_raw_frame_t* frame);
static void parse_heartrate_data(const radar_raw_frame_t* frame);
static void parse_sleep_data(const radar_raw_frame_t* frame);

static void parse_byte(uint8_t byte);
static int uart_read(uint8_t* buf, int len, int timeout_ms);
static radar_error_t send_command_sync(uint8_t ctrl, uint8_t cmd, const uint8_t* data, uint16_t len, radar_raw_frame_t* resp, int timeout_ms);

static radar_config_t s_config = {};
static radar_state_t s_state = RADAR_STATE_UNINITIALIZED;
static radar_stats_t s_stats = {};
static SemaphoreHandle_t s_mutex = NULL;

static radar_data_callback_t s_data_callback = NULL;
static void* s_data_callback_user_data = NULL;
static radar_event_callback_t s_event_callback = NULL;
static void* s_event_callback_user_data = NULL;
static radar_raw_callback_t s_raw_callback = NULL;
static void* s_raw_callback_user_data = NULL;
static radar_error_t s_last_error = RADAR_ERR_NONE;
static TaskHandle_t s_radar_task_handle = NULL;

static uart_port_t s_uart_port = RADAR_UART_NUM;
static QueueHandle_t s_uart_queue = NULL;
static bool s_uart_initialized = false;
static radar_raw_frame_t s_lastResponse = {};

typedef enum {
    PARSE_STATE_IDLE = 0,
    PARSE_STATE_HEAD,
    PARSE_STATE_CTRL,
    PARSE_STATE_CMD,
    PARSE_STATE_LEN_H,
    PARSE_STATE_LEN_L,
    PARSE_STATE_DATA,
    PARSE_STATE_CHECKSUM
} parse_state_t;

static parse_state_t s_parseState = PARSE_STATE_IDLE;

static void notify_data(radar_data_type_t type, radar_data_union_t* data) {
    if (s_data_callback != NULL) {
        s_data_callback(type, data, s_data_callback_user_data);
    }
}

#define RADAR_CMD_TIMEOUT_MS 1000

static void __attribute__((unused)) parse_and_notify(const radar_raw_frame_t* frame) {
    if (frame == NULL) return;
    
    // 根据控制字分发到对应的解析器
    switch (frame->ctrl) {
        case R60ABD1_CTRL_PRESENCE:
            parse_presence_data(frame);
            break;
            
        case R60ABD1_CTRL_BREATHING:
            parse_breathing_data(frame);
            break;
            
        case R60ABD1_CTRL_HEARTRATE:
            parse_heartrate_data(frame);
            break;
            
        case R60ABD1_CTRL_SLEEP:
            parse_sleep_data(frame);
            break;
            
        default:
            // 其他控制字，直接通知原始帧
            if (s_config.enable_raw_data) {
                radar_data_union_t data;
                memcpy(&data.raw_frame, frame, sizeof(radar_raw_frame_t));
                notify_data(RADAR_DATA_TYPE_RAW_FRAME, &data);
            }
            break;
    }
}

static void parse_presence_data(const radar_raw_frame_t* frame) {
    radar_data_union_t data;
    memset(&data, 0, sizeof(data));
    
    switch (frame->cmd) {
        case R60ABD1_CMD_PRESENCE_STATUS:  // 0x01 存在信息
            if (frame->data_len >= 1) {
                data.presence.presence = frame->data[0];
                data.presence.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_PRESENCE, &data);
            }
            break;
            
        case R60ABD1_CMD_MOTION_STATUS:  // 0x02 运动信息
            if (frame->data_len >= 1) {
                data.motion.motion_state = frame->data[0];
                data.motion.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_MOTION, &data);
            }
            break;
            
        case R60ABD1_CMD_BODY_MOVEMENT:  // 0x03 体动参数
            if (frame->data_len >= 1) {
                data.body_movement.movement_level = frame->data[0];
                data.body_movement.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_BODY_MOVEMENT, &data);
            }
            break;
            
        case R60ABD1_CMD_BODY_DISTANCE:  // 0x04 人体距离
            if (frame->data_len >= 2) {
                data.body_distance.distance_cm = ((uint16_t)(frame->data[0] << 8)) | frame->data[1];
                data.body_distance.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_BODY_DISTANCE, &data);
            }
            break;
            
        case R60ABD1_CMD_BODY_POSITION:  // 0x05 人体方位
            if (frame->data_len >= 6) {
                // X, Y, Z坐标，每个2字节，高字节在前
                int16_t x = (int16_t)(((uint16_t)(frame->data[0] << 8)) | frame->data[1]);
                int16_t y = (int16_t)(((uint16_t)(frame->data[2] << 8)) | frame->data[3]);
                int16_t z = (int16_t)(((uint16_t)(frame->data[4] << 8)) | frame->data[5]);
                
                // 直接使用int16_t类型转换，自动处理符号位扩展
                data.body_position.x = (int16_t)x;
                data.body_position.y = (int16_t)y;
                data.body_position.z = (int16_t)z;
                
                data.body_position.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_BODY_POSITION, &data);
            }
            break;
            
        default:
            break;
    }
}

static void parse_breathing_data(const radar_raw_frame_t* frame) {
    radar_data_union_t data;
    memset(&data, 0, sizeof(data));
    
    switch (frame->cmd) {
        case R60ABD1_CMD_BREATH_STATUS:  // 0x01 呼吸信息
            if (frame->data_len >= 1) {
                data.breath_status.breath_state = frame->data[0];
                data.breath_status.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_BREATH_STATUS, &data);
            }
            break;
            
        case R60ABD1_CMD_BREATH_RATE:  // 0x02 呼吸数值
            if (frame->data_len >= 1) {
                data.breath_rate.breath_rate = frame->data[0];
                data.breath_rate.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_BREATH_RATE, &data);
            }
            break;
            
        case R60ABD1_CMD_BREATH_WAVE:  // 0x05 呼吸波形
            if (frame->data_len >= 5) {
                memcpy(data.breath_wave.wave_data, frame->data, 5);
                // 转换波形值（中轴线为128）
                for (int i = 0; i < 5; i++) {
                    data.breath_wave.wave_value[i] = (int8_t)(data.breath_wave.wave_data[i] - 128);
                }
                data.breath_wave.timestamp = frame->timestamp;
                
                if (s_config.enable_waveform) {
                    notify_data(RADAR_DATA_TYPE_BREATH_WAVE, &data);
                }
            }
            break;
            
        default:
            break;
    }
}

static void parse_heartrate_data(const radar_raw_frame_t* frame) {
    radar_data_union_t data;
    memset(&data, 0, sizeof(data));
    
    switch (frame->cmd) {
        case R60ABD1_CMD_HEARTRATE_VALUE:  // 0x02 心率数值
            if (frame->data_len >= 1) {
                data.heart_rate.heart_rate = frame->data[0];
                data.heart_rate.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_HEART_RATE, &data);
            }
            break;
            
        case R60ABD1_CMD_HEARTRATE_WAVE:  // 0x05 心率波形
            if (frame->data_len >= 5) {
                memcpy(data.heart_wave.wave_data, frame->data, 5);
                // 转换波形值（中轴线为128）
                for (int i = 0; i < 5; i++) {
                    data.heart_wave.wave_value[i] = (int8_t)(data.heart_wave.wave_data[i] - 128);
                }
                data.heart_wave.timestamp = frame->timestamp;
                
                if (s_config.enable_waveform) {
                    notify_data(RADAR_DATA_TYPE_HEART_WAVE, &data);
                }
            }
            break;
            
        default:
            break;
    }
}

static void parse_sleep_data(const radar_raw_frame_t* frame) {
    radar_data_union_t data;
    memset(&data, 0, sizeof(data));
    
    switch (frame->cmd) {
        case R60ABD1_CMD_BED_STATUS:  // 0x01 入床/离床
            if (frame->data_len >= 1) {
                data.bed_status.bed_state = frame->data[0];
                data.bed_status.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_BED_STATUS, &data);
            }
            break;
            
        case R60ABD1_CMD_SLEEP_STATE:  // 0x02 睡眠状态
            if (frame->data_len >= 1) {
                data.sleep_state.sleep_state = frame->data[0];
                data.sleep_state.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_SLEEP_STATE, &data);
            }
            break;
            
        case R60ABD1_CMD_SLEEP_SCORE:  // 0x06 睡眠质量评分
            if (frame->data_len >= 1) {
                data.sleep_score.sleep_score = frame->data[0];
                data.sleep_score.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_SLEEP_SCORE, &data);
            }
            break;
            
        case R60ABD1_CMD_SLEEP_COMPOSITE:  // 0x0C 睡眠综合状态
            if (frame->data_len >= 8) {
                data.sleep_composite.presence = frame->data[0];
                data.sleep_composite.sleep_state = frame->data[1];
                data.sleep_composite.avg_breath = frame->data[2];
                data.sleep_composite.avg_heart = frame->data[3];
                data.sleep_composite.turn_over_count = frame->data[4];
                data.sleep_composite.large_move_pct = frame->data[5];
                data.sleep_composite.small_move_pct = frame->data[6];
                data.sleep_composite.apnea_count = frame->data[7];
                data.sleep_composite.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_SLEEP_COMPOSITE, &data);
            }
            break;
            
        case R60ABD1_CMD_SLEEP_ANALYSIS:  // 0x0D 睡眠质量分析
            if (frame->data_len >= 12) {
                data.sleep_analysis.sleep_score = frame->data[0];
                data.sleep_analysis.total_sleep_time = ((uint16_t)frame->data[1] << 8) | frame->data[2];
                data.sleep_analysis.awake_pct = frame->data[3];
                data.sleep_analysis.light_sleep_pct = frame->data[4];
                data.sleep_analysis.deep_sleep_pct = frame->data[5];
                data.sleep_analysis.away_time = frame->data[6];
                data.sleep_analysis.away_count = frame->data[7];
                data.sleep_analysis.turn_over_count = frame->data[8];
                data.sleep_analysis.avg_breath = frame->data[9];
                data.sleep_analysis.avg_heart = frame->data[10];
                data.sleep_analysis.apnea_count = frame->data[11];
                data.sleep_analysis.timestamp = frame->timestamp;
                notify_data(RADAR_DATA_TYPE_SLEEP_ANALYSIS, &data);
            }
            break;
            
        default:
            break;
    }
}

//=============================================================================
// 任务实现
//=============================================================================

static void radar_task(void* pvParameters) {
    (void)pvParameters;
    ESP_LOGI("radar", "Radar task pins: uart=%d tx=%d rx=%d baud=%d",
             (int)s_uart_port,
             (int)RADAR_UART_TX_PIN,
             (int)RADAR_UART_RX_PIN,
             R60ABD1_UART_BAUD);
    ESP_LOGI("radar", "雷达任务启动");
    
    uint8_t* rx_buf = (uint8_t*)heap_caps_malloc(64, MALLOC_CAP_SPIRAM);
    if (rx_buf == NULL) {
        ESP_LOGE("radar", "分配PSRAM缓冲区失败，尝试分配内部内存");
        rx_buf = (uint8_t*)malloc(64);
        if (rx_buf == NULL) {
            ESP_LOGE("radar", "分配内存失败");
            vTaskDelete(NULL);
            return;
        }
    }
    
    while (s_state == RADAR_STATE_RUNNING) {
        // 读取UART数据
        int n = uart_read(rx_buf, 64, 10);
        
        if (n > 0) {
            // 统计
            // 逐字节解析
            for (int i = 0; i < n; i++) {
                parse_byte(rx_buf[i]);
            }
        }
        
        // 短暂延迟，避免占用过多CPU
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    
    free(rx_buf);
    ESP_LOGI("radar", "雷达任务结束");
    vTaskDelete(NULL);
}

//=============================================================================
// 便捷查询API实现
//=============================================================================

radar_error_t radar_query_presence(radar_presence_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_PRESENCE, R60ABD1_CMD_QUERY_PRESENCE_STATUS, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 1) {
        data->presence = resp.data[0];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

static void parse_byte(uint8_t byte) {
    static uint8_t buffer[R60ABD1_FRAME_MAX_LEN + 8];
    static int buffer_pos = 0;
    static uint16_t expected_len = 0;
    static uint8_t len_high = 0;
    static uint8_t checksum = 0;
    
    switch (s_parseState) {
        case PARSE_STATE_IDLE:
            if (byte == R60ABD1_FRAME_HEADER_1) {
                buffer[0] = byte;
                buffer_pos = 1;
                checksum = byte;
                expected_len = 0;
                len_high = 0;
                s_parseState = PARSE_STATE_HEAD;
            }
            break;
            
        case PARSE_STATE_HEAD:
            if (byte == R60ABD1_FRAME_HEADER_2) {
                buffer[buffer_pos++] = byte;
                checksum += byte;
                s_parseState = PARSE_STATE_CTRL;
            } else {
                s_parseState = PARSE_STATE_IDLE;
                buffer_pos = 0;
            }
            break;
            
        case PARSE_STATE_CTRL:
            buffer[buffer_pos++] = byte;
            checksum += byte;
            s_parseState = PARSE_STATE_CMD;
            break;
            
        case PARSE_STATE_CMD:
            buffer[buffer_pos++] = byte;
            checksum += byte;
            s_parseState = PARSE_STATE_LEN_H;
            break;
            
        case PARSE_STATE_LEN_H:
            buffer[buffer_pos++] = byte;
            len_high = byte;
            checksum += byte;
            s_parseState = PARSE_STATE_LEN_L;
            break;
            
        case PARSE_STATE_LEN_L:
            buffer[buffer_pos++] = byte;
            checksum += byte;
            expected_len = ((uint16_t)len_high << 8) | byte;
            if (expected_len > R60ABD1_FRAME_MAX_LEN ||
                expected_len + 7 > sizeof(buffer)) {
                xSemaphoreTake(s_mutex, portMAX_DELAY);
                s_stats.error_frames++;
                xSemaphoreGive(s_mutex);
                ESP_LOGW("radar", "Invalid frame length: %u", expected_len);
                s_parseState = PARSE_STATE_IDLE;
                buffer_pos = 0;
                break;
            }
            if (expected_len == 0) {
                s_parseState = PARSE_STATE_CHECKSUM;
            } else {
                s_parseState = PARSE_STATE_DATA;
            }
            break;
            
        case PARSE_STATE_DATA:
            buffer[buffer_pos] = byte;
            checksum += byte;
            buffer_pos++;
            
            if (buffer_pos >= 6 + expected_len) {
                s_parseState = PARSE_STATE_CHECKSUM;
            }
            break;
            
        case PARSE_STATE_CHECKSUM:
            buffer[buffer_pos] = byte;
            
            if (byte == checksum) {
                radar_raw_frame_t frame;
                memset(&frame, 0, sizeof(frame));
                frame.header[0] = buffer[0];
                frame.header[1] = buffer[1];
                frame.ctrl = buffer[2];
                frame.cmd = buffer[3];
                frame.data_len = expected_len;
                frame.timestamp = millis();
                
                if (expected_len > 0) {
                    memcpy(frame.data, &buffer[6], expected_len);
                }
                
                memcpy(&s_lastResponse, &frame, sizeof(radar_raw_frame_t));
                xSemaphoreTake(s_mutex, portMAX_DELAY);
                s_stats.total_frames++;
                s_stats.valid_frames++;
                s_stats.last_frame_time = frame.timestamp;
                xSemaphoreGive(s_mutex);

                if (s_raw_callback != NULL) {
                    s_raw_callback(&frame, s_raw_callback_user_data);
                }

                if (s_stats.valid_frames <= 5 || (s_stats.valid_frames % 100) == 0) {
                    ESP_LOGI("radar", "Frame #%lu ctrl=0x%02X cmd=0x%02X len=%u",
                             (unsigned long)s_stats.valid_frames,
                             frame.ctrl,
                             frame.cmd,
                             frame.data_len);
                }
                parse_and_notify(&frame);
            } else {
                xSemaphoreTake(s_mutex, portMAX_DELAY);
                s_stats.total_frames++;
                s_stats.error_frames++;
                xSemaphoreGive(s_mutex);
                ESP_LOGW("radar", "Checksum failed: got=0x%02X expected=0x%02X",
                         byte,
                         checksum);
            }
            
            s_parseState = PARSE_STATE_IDLE;
            buffer_pos = 0;
            break;
            
        default:
            s_parseState = PARSE_STATE_IDLE;
            break;
    }
}

static int uart_read(uint8_t* buf, int len, int timeout_ms) {
    if (!s_uart_initialized) {
        return 0;
    }
    
    int bytes_read = 0;
    unsigned long start_time = millis();
    
    while (bytes_read < len && (millis() - start_time) < timeout_ms) {
        size_t available = 0;
        uart_get_buffered_data_len(s_uart_port, &available);
        
        if (available > 0) {
            int to_read = (available < (len - bytes_read) ? available : (len - bytes_read));
            int read_len = uart_read_bytes(s_uart_port, &buf[bytes_read], to_read, 10);
            if (read_len > 0) {
                bytes_read += read_len;
            }
        } else {
            delay(1);
        }
    }
    
    return bytes_read;
}

static radar_error_t send_command_sync(uint8_t ctrl, uint8_t cmd, const uint8_t* data, uint16_t len, radar_raw_frame_t* resp, int timeout_ms) {
    if (!s_uart_initialized) {
        return RADAR_ERR_UART_FAILED;
    }
    
    size_t available = 0;
    uart_get_buffered_data_len(s_uart_port, &available);
    if (available > 0) {
        uart_flush_input(s_uart_port);
    }
    
    uint8_t frame[256];
    int frame_len = 0;
    
    frame[frame_len++] = R60ABD1_FRAME_HEADER_1;
    frame[frame_len++] = R60ABD1_FRAME_HEADER_2;
    frame[frame_len++] = ctrl;
    frame[frame_len++] = cmd;
    frame[frame_len++] = (len >> 8) & 0xFF;
    frame[frame_len++] = len & 0xFF;
    
    if (data != NULL && len > 0) {
        memcpy(&frame[frame_len], data, len);
        frame_len += len;
    }
    
    uint8_t checksum = 0;
    for (int i = 0; i < frame_len; i++) {
        checksum += frame[i];
    }
    frame[frame_len++] = checksum;
    frame[frame_len++] = R60ABD1_FRAME_TAIL_1;
    frame[frame_len++] = R60ABD1_FRAME_TAIL_2;
    
    uart_write_bytes(s_uart_port, (const char*)frame, frame_len);
    
    if (resp == NULL) {
        return RADAR_ERR_NONE;
    }
    
    unsigned long start_time = millis();
    while ((millis() - start_time) < timeout_ms) {
        size_t avail = 0;
        uart_get_buffered_data_len(s_uart_port, &avail);
        
        if (avail > 0) {
            uint8_t byte;
            int read_len = uart_read_bytes(s_uart_port, &byte, 1, 10);
            if (read_len > 0) {
                parse_byte(byte);
                
                if (s_lastResponse.cmd == cmd && s_lastResponse.ctrl == ctrl) {
                    memcpy(resp, &s_lastResponse, sizeof(radar_raw_frame_t));
                    return RADAR_ERR_NONE;
                }
            }
        } else {
            delay(1);
        }
    }
    
    return RADAR_ERR_TIMEOUT;
}

radar_error_t radar_query_motion(radar_motion_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_PRESENCE, R60ABD1_CMD_QUERY_MOTION_STATUS, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 1) {
        data->motion_state = resp.data[0];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

radar_error_t radar_query_body_movement(radar_body_movement_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_PRESENCE, R60ABD1_CMD_QUERY_BODY_MOVEMENT, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 1) {
        data->movement_level = resp.data[0];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

radar_error_t radar_query_body_distance(radar_body_distance_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_PRESENCE, R60ABD1_CMD_QUERY_BODY_DISTANCE, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 2) {
        data->distance_cm = ((uint16_t)resp.data[0] << 8) | resp.data[1];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

radar_error_t radar_query_body_position(radar_body_position_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_PRESENCE, R60ABD1_CMD_QUERY_BODY_POSITION, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 6) {
        int16_t x = (int16_t)(((uint16_t)resp.data[0] << 8) | resp.data[1]);
        int16_t y = (int16_t)(((uint16_t)resp.data[2] << 8) | resp.data[3]);
        int16_t z = (int16_t)(((uint16_t)resp.data[4] << 8) | resp.data[5]);
        
        // 直接使用int16_t类型转换，自动处理符号位扩展
        data->x = (int16_t)x;
        data->y = (int16_t)y;
        data->z = (int16_t)z;
        
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

radar_error_t radar_query_breath_status(radar_breath_status_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_BREATHING, R60ABD1_CMD_QUERY_BREATH_STATUS, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 1) {
        data->breath_state = resp.data[0];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

radar_error_t radar_query_breath_rate(radar_breath_rate_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_BREATHING, R60ABD1_CMD_QUERY_BREATH_RATE, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 1) {
        data->breath_rate = resp.data[0];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

radar_error_t radar_query_heart_rate(radar_heart_rate_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_HEARTRATE, R60ABD1_CMD_QUERY_HEARTRATE_VALUE, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 1) {
        data->heart_rate = resp.data[0];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

radar_error_t radar_query_bed_status(radar_bed_status_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_SLEEP, R60ABD1_CMD_QUERY_BED_STATUS, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 1) {
        data->bed_state = resp.data[0];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

radar_error_t radar_query_sleep_state(radar_sleep_state_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_SLEEP, R60ABD1_CMD_QUERY_SLEEP_STATE, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 1) {
        data->sleep_state = resp.data[0];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

radar_error_t radar_query_sleep_score(radar_sleep_score_t* data) {
    if (data == NULL) return RADAR_ERR_INVALID_PARAM;
    
    radar_raw_frame_t resp;
    memset(&resp, 0, sizeof(resp));
    uint8_t query_data = 0x0F;
    radar_error_t err = send_command_sync(R60ABD1_CTRL_SLEEP, R60ABD1_CMD_QUERY_SLEEP_SCORE, 
                                           &query_data, 1, &resp, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE && resp.data_len >= 1) {
        data->sleep_score = resp.data[0];
        data->timestamp = resp.timestamp;
        return RADAR_ERR_NONE;
    }
    
    return err;
}

//=============================================================================
// 主要API实现
//=============================================================================

radar_error_t radar_init(const radar_config_t* config) {
    if (s_state != RADAR_STATE_UNINITIALIZED) {
        return RADAR_ERR_ALREADY_RUNNING;
    }
    
    if (config != NULL) {
        memcpy(&s_config, config, sizeof(radar_config_t));
    } else {
        memset(&s_config, 0, sizeof(radar_config_t));
        s_config.presence_enable = true;
        s_config.breath_enable = true;
        s_config.heart_rate_enable = true;
        s_config.sleep_enable = true;
        s_config.data_timeout_ms = 5000;
    }
    
    memset(&s_stats, 0, sizeof(radar_stats_t));
    
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        return RADAR_ERR_MEMORY_FAILED;
    }
    
    uart_config_t uart_config = {
        .baud_rate = R60ABD1_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_APB,
    };
    
    esp_err_t err = uart_driver_install(s_uart_port, RADAR_UART_BUF_SIZE, RADAR_UART_BUF_SIZE, 10, &s_uart_queue, 0);
    if (err != ESP_OK) {
        ESP_LOGE("radar", "UART驱动安装失败: %d", err);
        return RADAR_ERR_UART_FAILED;
    }
    
    err = uart_param_config(s_uart_port, &uart_config);
    if (err != ESP_OK) {
        ESP_LOGE("radar", "UART参数配置失败: %d", err);
        uart_driver_delete(s_uart_port);
        return RADAR_ERR_UART_FAILED;
    }
    
    err = uart_set_pin(s_uart_port, RADAR_UART_TX_PIN, RADAR_UART_RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (err != ESP_OK) {
        ESP_LOGE("radar", "UART引脚配置失败: %d", err);
        uart_driver_delete(s_uart_port);
        return RADAR_ERR_UART_FAILED;
    }
    
    s_uart_initialized = true;
    s_state = RADAR_STATE_INITIALIZED;
    s_last_error = RADAR_ERR_NONE;
    
    ESP_LOGI("radar", "雷达驱动初始化成功");
    return RADAR_ERR_NONE;
}

void radar_deinit(void) {
    if (s_state == RADAR_STATE_RUNNING) {
        radar_stop();
    }
    
    if (s_uart_initialized) {
        uart_driver_delete(s_uart_port);
        s_uart_initialized = false;
    }
    
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    s_state = RADAR_STATE_UNINITIALIZED;
    s_data_callback = NULL;
    s_event_callback = NULL;
    s_raw_callback = NULL;
    
    ESP_LOGI("radar", "雷达驱动已反初始化");
}

radar_error_t radar_start(void) {
    if (s_state != RADAR_STATE_INITIALIZED) {
        s_last_error = RADAR_ERR_NOT_INITIALIZED;
        return RADAR_ERR_NOT_INITIALIZED;
    }

    s_state = RADAR_STATE_RUNNING;
    
    BaseType_t ret = xTaskCreatePinnedToCore(
        radar_task,
        "radar_task",
        4096,
        NULL,
        5,
        &s_radar_task_handle,
        0
    );
    
    if (ret != pdPASS) {
        s_state = RADAR_STATE_INITIALIZED;
        s_last_error = RADAR_ERR_MEMORY_FAILED;
        return RADAR_ERR_MEMORY_FAILED;
    }
    
    s_last_error = RADAR_ERR_NONE;
    
    ESP_LOGI("radar", "雷达驱动已启动");
    return RADAR_ERR_NONE;
}

void radar_stop(void) {
    if (s_state == RADAR_STATE_RUNNING) {
        s_state = RADAR_STATE_STOPPED;
        
        if (s_radar_task_handle != NULL) {
            vTaskDelay(pdMS_TO_TICKS(100));
            s_radar_task_handle = NULL;
        }
        
        ESP_LOGI("radar", "雷达驱动已停止");
    }
}

radar_state_t radar_get_state(void) {
    return s_state;
}

radar_error_t radar_get_last_error(void) {
    return s_last_error;
}

radar_error_t radar_set_config(const radar_config_t* config) {
    if (config == NULL) {
        return RADAR_ERR_INVALID_PARAM;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memcpy(&s_config, config, sizeof(radar_config_t));
    xSemaphoreGive(s_mutex);
    
    return RADAR_ERR_NONE;
}

void radar_get_config(radar_config_t* config) {
    if (config != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(config, &s_config, sizeof(radar_config_t));
        xSemaphoreGive(s_mutex);
    }
}

void radar_register_data_callback(radar_data_callback_t callback, void* user_data) {
    s_data_callback = callback;
    s_data_callback_user_data = user_data;
}

void radar_register_event_callback(radar_event_callback_t callback, void* user_data) {
    s_event_callback = callback;
    s_event_callback_user_data = user_data;
}

void radar_register_raw_callback(radar_raw_callback_t callback, void* user_data) {
    s_raw_callback = callback;
    s_raw_callback_user_data = user_data;
}

radar_error_t radar_send_command(uint8_t ctrl, uint8_t cmd, 
                                   const uint8_t* data, uint16_t len) {
    (void)ctrl;
    (void)cmd;
    (void)data;
    (void)len;
    return RADAR_ERR_NONE;
}

radar_error_t radar_query(uint8_t ctrl, uint8_t cmd) {
    (void)ctrl;
    (void)cmd;
    return RADAR_ERR_NONE;
}

radar_error_t radar_set_function_switch(uint8_t ctrl, bool enable) {
    if (!s_uart_initialized) {
        return RADAR_ERR_UART_FAILED;
    }
    
    uint8_t data = enable ? 0x01 : 0x00;
    radar_error_t err = send_command_sync(ctrl, R60ABD1_CMD_PRESENCE_SWITCH, &data, 1, NULL, RADAR_CMD_TIMEOUT_MS);
    
    if (err == RADAR_ERR_NONE) {
        ESP_LOGI("radar", "功能开关设置成功: 控制字=0x%02X, 状态=%s", ctrl, enable ? "开启" : "关闭");
    } else {
        ESP_LOGE("radar", "功能开关设置失败: 控制字=0x%02X, 错误=%d", ctrl, err);
    }
    
    return err;
}

radar_error_t radar_reset(void) {
    return RADAR_ERR_NONE;
}

radar_error_t radar_heartbeat(void) {
    return RADAR_ERR_NONE;
}

void radar_get_stats(radar_stats_t* stats) {
    if (stats != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        memcpy(stats, &s_stats, sizeof(radar_stats_t));
        xSemaphoreGive(s_mutex);
    }
}

void radar_clear_stats(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memset(&s_stats, 0, sizeof(radar_stats_t));
    xSemaphoreGive(s_mutex);
}
