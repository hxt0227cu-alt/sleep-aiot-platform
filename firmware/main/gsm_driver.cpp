// SIM800C GSM driver implementation for ESP-IDF.

#include "gsm_driver.h"

#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

static const char* TAG = "gsm_driver";

static gsm_state_t g_state = GSM_STATE_UNINITIALIZED;
static gsm_error_t g_last_error = GSM_ERR_NONE;
static gsm_stats_t g_stats = {};
static bool g_uart_initialized = false;
static SemaphoreHandle_t g_uart_mutex = NULL;

static gsm_sms_callback_t g_sms_callback = NULL;
static void* g_sms_callback_user_data = NULL;
static gsm_call_callback_t g_call_callback = NULL;
static void* g_call_callback_user_data = NULL;
static gsm_data_callback_t g_data_callback = NULL;
static void* g_data_callback_user_data = NULL;
static gsm_state_callback_t g_state_callback = NULL;
static void* g_state_callback_user_data = NULL;

static gsm_net_connection_t g_net_connection = {};
static gsm_sms_mode_t g_sms_mode = GSM_SMS_MODE_TEXT;
static gsm_charset_t g_charset = GSM_CHARSET_GSM;
static char g_apn[32] = "CMNET";
static bool g_gprs_attached = false;

static void gsm_set_state(gsm_state_t state)
{
    if (g_state == state) {
        return;
    }

    ESP_LOGI(TAG, "state: %s -> %s", gsm_state_to_string(g_state), gsm_state_to_string(state));
    g_state = state;
    if (g_state_callback != NULL) {
        g_state_callback(state, g_state_callback_user_data);
    }
}

static void gsm_set_error(gsm_error_t error)
{
    g_last_error = error;
    if (error != GSM_ERR_NONE) {
        ESP_LOGE(TAG, "error: %s", gsm_error_to_string(error));
    }
}

static bool gsm_is_valid_phone(const char* phone)
{
    if (phone == NULL || phone[0] == '\0') {
        return false;
    }

    size_t len = strlen(phone);
    if (len >= GSM_MAX_PHONE_LEN) {
        return false;
    }

    for (size_t i = 0; i < len; ++i) {
        if (i == 0 && phone[i] == '+') {
            continue;
        }
        if (!isdigit((unsigned char)phone[i])) {
            return false;
        }
    }
    return true;
}

static void gsm_update_stats(bool success)
{
    g_stats.total_commands++;
    if (success) {
        g_stats.success_commands++;
    } else {
        g_stats.failed_commands++;
    }
}

static esp_err_t gsm_uart_init(void)
{
    if (g_uart_initialized) {
        return ESP_OK;
    }

    uart_config_t uart_config = {};
    uart_config.baud_rate = GSM_BAUD_RATE;
    uart_config.data_bits = UART_DATA_8_BITS;
    uart_config.parity = UART_PARITY_DISABLE;
    uart_config.stop_bits = UART_STOP_BITS_1;
    uart_config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    uart_config.source_clk = UART_SCLK_DEFAULT;

    esp_err_t ret = uart_param_config(GSM_UART_NUM, &uart_config);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = uart_set_pin(GSM_UART_NUM, GSM_TX_PIN, GSM_RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = uart_driver_install(GSM_UART_NUM, GSM_UART_BUF_SIZE, GSM_UART_BUF_SIZE, 0, NULL, 0);
    if (ret != ESP_OK) {
        return ret;
    }

    g_uart_mutex = xSemaphoreCreateMutex();
    if (g_uart_mutex == NULL) {
        uart_driver_delete(GSM_UART_NUM);
        return ESP_ERR_NO_MEM;
    }

    g_uart_initialized = true;
    return ESP_OK;
}

static esp_err_t gsm_uart_deinit(void)
{
    if (!g_uart_initialized) {
        return ESP_OK;
    }

    uart_driver_delete(GSM_UART_NUM);
    g_uart_initialized = false;
    if (g_uart_mutex != NULL) {
        vSemaphoreDelete(g_uart_mutex);
        g_uart_mutex = NULL;
    }
    return ESP_OK;
}

static esp_err_t gsm_uart_write(const uint8_t* data, size_t len)
{
    if (!g_uart_initialized || data == NULL || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    if (g_uart_mutex != NULL) {
        xSemaphoreTake(g_uart_mutex, portMAX_DELAY);
    }
    int written = uart_write_bytes(GSM_UART_NUM, data, len);
    uart_wait_tx_done(GSM_UART_NUM, pdMS_TO_TICKS(GSM_CMD_TIMEOUT_MS));
    if (g_uart_mutex != NULL) {
        xSemaphoreGive(g_uart_mutex);
    }

    return written == (int)len ? ESP_OK : ESP_FAIL;
}

static int gsm_uart_read(uint8_t* data, size_t len, size_t timeout_ms)
{
    if (!g_uart_initialized || data == NULL || len == 0) {
        return 0;
    }

    int read_len = uart_read_bytes(GSM_UART_NUM, data, len, pdMS_TO_TICKS(timeout_ms));
    if (read_len > 0) {
        g_stats.bytes_received += read_len;
    }
    return read_len;
}

static bool gsm_check_response_ok(const char* resp)
{
    return resp != NULL && strstr(resp, "OK") != NULL;
}

static bool gsm_check_response_error(const char* resp)
{
    return resp != NULL && (strstr(resp, "ERROR") != NULL || strstr(resp, "+CME ERROR") != NULL);
}

static void gsm_trim_string(char* str)
{
    if (str == NULL) {
        return;
    }

    char* start = str;
    while (*start != '\0' && isspace((unsigned char)*start)) {
        start++;
    }
    char* end = start + strlen(start);
    while (end > start && isspace((unsigned char)*(end - 1))) {
        end--;
    }
    *end = '\0';

    if (start != str) {
        memmove(str, start, strlen(start) + 1);
    }
}

static void gsm_process_urc(const char* urc)
{
    if (urc == NULL || urc[0] == '\0') {
        return;
    }

    if (strstr(urc, "+CMTI:") != NULL) {
        g_stats.sms_received++;
        if (g_sms_callback != NULL) {
            gsm_sms_info_t sms = {};
            sms.index = 0;
            strncpy(sms.content, urc, GSM_MAX_SMS_LEN);
            g_sms_callback(&sms, g_sms_callback_user_data);
        }
    } else if (strstr(urc, "RING") != NULL) {
        if (g_call_callback != NULL) {
            g_call_callback("", g_call_callback_user_data);
        }
    } else if (strstr(urc, "+IPD") != NULL && g_data_callback != NULL) {
        g_data_callback((const uint8_t*)urc, strlen(urc), g_data_callback_user_data);
    }
}

static esp_err_t gsm_wait_for_response(const char* expected, char* resp, size_t resp_len, int timeout_ms)
{
    char local_resp[GSM_MAX_RESP_LEN + 1] = {0};
    char* out = resp != NULL && resp_len > 0 ? resp : local_resp;
    size_t out_len = resp != NULL && resp_len > 0 ? resp_len : sizeof(local_resp);
    out[0] = '\0';

    int64_t start = esp_timer_get_time();
    while ((esp_timer_get_time() - start) < ((int64_t)timeout_ms * 1000)) {
        uint8_t chunk[96];
        int len = gsm_uart_read(chunk, sizeof(chunk) - 1, 100);
        if (len <= 0) {
            continue;
        }

        chunk[len] = '\0';
        strncat(out, (const char*)chunk, out_len - strlen(out) - 1);

        if ((expected != NULL && strstr(out, expected) != NULL) || gsm_check_response_ok(out)) {
            return ESP_OK;
        }
        if (gsm_check_response_error(out)) {
            gsm_set_error(GSM_ERR_CMD_FAILED);
            return ESP_FAIL;
        }
        gsm_process_urc((const char*)chunk);
    }

    g_stats.timeout_count++;
    gsm_set_error(GSM_ERR_TIMEOUT);
    return ESP_ERR_TIMEOUT;
}

static esp_err_t gsm_wait_for_ok(int timeout_ms)
{
    return gsm_wait_for_response("OK", NULL, 0, timeout_ms);
}

static esp_err_t gsm_send_ctrl_z(void)
{
    const uint8_t ctrl_z = 0x1A;
    return gsm_uart_write(&ctrl_z, 1);
}

static esp_err_t gsm_parse_response(const char* response, const char* prefix, char* value, size_t value_len)
{
    if (response == NULL || value == NULL || value_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    const char* start = response;
    if (prefix != NULL && prefix[0] != '\0') {
        start = strstr(response, prefix);
        if (start == NULL) {
            return ESP_FAIL;
        }
        start += strlen(prefix);
    }

    while (*start == ':' || *start == ' ' || *start == '\r' || *start == '\n') {
        start++;
    }

    const char* end = strpbrk(start, "\r\n");
    size_t len = end != NULL ? (size_t)(end - start) : strlen(start);
    if (len >= value_len) {
        len = value_len - 1;
    }
    memcpy(value, start, len);
    value[len] = '\0';
    gsm_trim_string(value);
    return ESP_OK;
}

static esp_err_t gsm_power_on(void)
{
#if GSM_PWR_PIN >= 0 && GSM_RST_PIN >= 0
    gpio_config_t io_conf = {};
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pin_bit_mask = (1ULL << GSM_PWR_PIN) | (1ULL << GSM_RST_PIN);
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    io_conf.intr_type = GPIO_INTR_DISABLE;
    gpio_config(&io_conf);

    gpio_set_level(GSM_RST_PIN, 1);
    gpio_set_level(GSM_PWR_PIN, 1);
    vTaskDelay(pdMS_TO_TICKS(1000));
    gpio_set_level(GSM_PWR_PIN, 0);
    vTaskDelay(pdMS_TO_TICKS(3000));
#else
    ESP_LOGW(TAG, "GSM power/reset pins are not configured; assuming external power");
#endif
    return ESP_OK;
}

static esp_err_t gsm_power_off(void)
{
#if GSM_PWR_PIN >= 0
    gpio_set_level(GSM_PWR_PIN, 1);
    vTaskDelay(pdMS_TO_TICKS(1000));
    gpio_set_level(GSM_PWR_PIN, 0);
#endif
    return ESP_OK;
}

esp_err_t gsm_init(void)
{
    if (g_state != GSM_STATE_UNINITIALIZED) {
        return ESP_OK;
    }

    esp_err_t ret = gsm_uart_init();
    if (ret != ESP_OK) {
        gsm_set_error(GSM_ERR_UART_FAIL);
        return ret;
    }

    gsm_power_on();
    ret = gsm_send_command_ok("AT", GSM_RESP_TIMEOUT_MS);
    if (ret != ESP_OK) {
        gsm_set_error(GSM_ERR_NO_RESPONSE);
        return ret;
    }

    gsm_send_command_ok("ATE0", GSM_CMD_TIMEOUT_MS);
    gsm_set_state(GSM_STATE_INITIALIZED);
    gsm_set_error(GSM_ERR_NONE);
    return ESP_OK;
}

esp_err_t gsm_deinit(void)
{
    if (g_net_connection.connected) {
        gsm_net_close();
    }
    if (g_gprs_attached) {
        gsm_gprs_detach();
    }
    gsm_power_off();
    gsm_uart_deinit();
    gsm_set_state(GSM_STATE_UNINITIALIZED);
    return ESP_OK;
}

bool gsm_is_ready(void)
{
    return g_state >= GSM_STATE_READY;
}

gsm_state_t gsm_get_state(void)
{
    return g_state;
}

gsm_error_t gsm_get_last_error(void)
{
    return g_last_error;
}

esp_err_t gsm_get_stats(gsm_stats_t* stats)
{
    if (stats == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memcpy(stats, &g_stats, sizeof(gsm_stats_t));
    return ESP_OK;
}

esp_err_t gsm_reset_stats(void)
{
    memset(&g_stats, 0, sizeof(g_stats));
    return ESP_OK;
}

esp_err_t gsm_send_command(const char* cmd, char* resp, size_t resp_len, int timeout_ms)
{
    if (!g_uart_initialized || cmd == NULL) {
        gsm_set_error(GSM_ERR_NOT_INIT);
        return ESP_ERR_INVALID_STATE;
    }

    char full_cmd[GSM_MAX_AT_LEN + 4];
    snprintf(full_cmd, sizeof(full_cmd), "%s\r\n", cmd);
    esp_err_t ret = gsm_uart_write((const uint8_t*)full_cmd, strlen(full_cmd));
    if (ret != ESP_OK) {
        gsm_update_stats(false);
        gsm_set_error(GSM_ERR_UART_FAIL);
        return ret;
    }
    g_stats.bytes_sent += strlen(full_cmd);

    ret = resp != NULL && resp_len > 0
        ? gsm_wait_for_response(NULL, resp, resp_len, timeout_ms)
        : gsm_wait_for_ok(timeout_ms);
    gsm_update_stats(ret == ESP_OK);
    return ret;
}

esp_err_t gsm_send_command_ok(const char* cmd, int timeout_ms)
{
    return gsm_send_command(cmd, NULL, 0, timeout_ms);
}

esp_err_t gsm_send_command_parse(const char* cmd, const char* expected, char* value, size_t value_len, int timeout_ms)
{
    char resp[GSM_MAX_RESP_LEN + 1] = {0};
    esp_err_t ret = gsm_send_command(cmd, resp, sizeof(resp), timeout_ms);
    if (ret != ESP_OK) {
        return ret;
    }
    return gsm_parse_response(resp, expected, value, value_len);
}

esp_err_t gsm_get_module_info(gsm_module_info_t* info)
{
    if (info == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(info, 0, sizeof(gsm_module_info_t));
    gsm_send_command_parse("AT+CGMI", "", info->manufacturer, sizeof(info->manufacturer), GSM_CMD_TIMEOUT_MS);
    gsm_send_command_parse("AT+CGMM", "", info->model, sizeof(info->model), GSM_CMD_TIMEOUT_MS);
    gsm_send_command_parse("AT+CGMR", "", info->revision, sizeof(info->revision), GSM_CMD_TIMEOUT_MS);
    gsm_send_command_parse("AT+CGSN", "", info->imei, sizeof(info->imei), GSM_CMD_TIMEOUT_MS);
    gsm_send_command_parse("AT+CIMI", "", info->imsi, sizeof(info->imsi), GSM_CMD_TIMEOUT_MS);
    gsm_send_command_parse("AT+CCID", "", info->ccid, sizeof(info->ccid), GSM_CMD_TIMEOUT_MS);
    return ESP_OK;
}

esp_err_t gsm_get_network_info(gsm_network_info_t* info)
{
    if (info == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(info, 0, sizeof(gsm_network_info_t));

    char resp[GSM_MAX_RESP_LEN + 1] = {0};
    if (gsm_send_command("AT+CSQ", resp, sizeof(resp), GSM_CMD_TIMEOUT_MS) == ESP_OK) {
        int rssi = 99;
        int ber = 99;
        if (sscanf(resp, "+CSQ: %d,%d", &rssi, &ber) == 2) {
            info->signal_strength = rssi;
            info->signal_ber = ber;
            if (rssi == 99) {
                info->quality = GSM_SIGNAL_UNKNOWN;
            } else if (rssi <= 7) {
                info->quality = GSM_SIGNAL_POOR;
            } else if (rssi <= 15) {
                info->quality = GSM_SIGNAL_FAIR;
            } else if (rssi <= 23) {
                info->quality = GSM_SIGNAL_GOOD;
            } else {
                info->quality = GSM_SIGNAL_EXCELLENT;
            }
        }
    }

    memset(resp, 0, sizeof(resp));
    if (gsm_send_command("AT+COPS?", resp, sizeof(resp), GSM_CMD_TIMEOUT_MS) == ESP_OK) {
        int mode = 0;
        int format = 0;
        char oper[32] = {0};
        if (sscanf(resp, "+COPS: %d,%d,\"%31[^\"]\"", &mode, &format, oper) == 3) {
            info->operator_mode = mode;
            strncpy(info->operator_name, oper, sizeof(info->operator_name) - 1);
            info->registered = mode != 0 || oper[0] != '\0';
        }
    }
    return ESP_OK;
}

bool gsm_check_sim(void)
{
    char resp[GSM_MAX_RESP_LEN + 1] = {0};
    if (gsm_send_command("AT+CPIN?", resp, sizeof(resp), GSM_CMD_TIMEOUT_MS) != ESP_OK) {
        return false;
    }
    return strstr(resp, "READY") != NULL;
}

esp_err_t gsm_wait_sim_ready(int timeout_ms)
{
    int64_t start = esp_timer_get_time();
    while ((esp_timer_get_time() - start) < ((int64_t)timeout_ms * 1000)) {
        if (gsm_check_sim()) {
            gsm_set_state(GSM_STATE_READY);
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    gsm_set_error(GSM_ERR_NO_SIM);
    return ESP_ERR_TIMEOUT;
}

esp_err_t gsm_wait_network_register(int timeout_ms)
{
    int64_t start = esp_timer_get_time();
    while ((esp_timer_get_time() - start) < ((int64_t)timeout_ms * 1000)) {
        gsm_network_info_t info = {};
        gsm_get_network_info(&info);
        if (info.registered) {
            gsm_set_state(GSM_STATE_NETWORK_REGISTERED);
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
    gsm_set_error(GSM_ERR_NO_NETWORK);
    return ESP_ERR_TIMEOUT;
}

esp_err_t gsm_sms_init(gsm_sms_mode_t mode, gsm_charset_t charset)
{
    char cmd[32];
    snprintf(cmd, sizeof(cmd), "AT+CMGF=%d", mode == GSM_SMS_MODE_PDU ? 0 : 1);
    esp_err_t ret = gsm_send_command_ok(cmd, GSM_CMD_TIMEOUT_MS);
    if (ret != ESP_OK) {
        return ret;
    }

    const char* charset_str = "GSM";
    if (charset == GSM_CHARSET_UCS2) {
        charset_str = "UCS2";
    } else if (charset == GSM_CHARSET_IRA) {
        charset_str = "IRA";
    } else if (charset == GSM_CHARSET_UTF8) {
        charset_str = "UTF8";
    }
    snprintf(cmd, sizeof(cmd), "AT+CSCS=\"%s\"", charset_str);
    ret = gsm_send_command_ok(cmd, GSM_CMD_TIMEOUT_MS);
    if (ret == ESP_OK) {
        g_sms_mode = mode;
        g_charset = charset;
        gsm_send_command_ok("AT+CNMI=2,1", GSM_CMD_TIMEOUT_MS);
    }
    return ret;
}

esp_err_t gsm_send_sms(const char* phone, const char* content)
{
    if (phone == NULL || content == NULL || !gsm_is_valid_phone(phone) || strlen(content) > GSM_MAX_SMS_LEN) {
        gsm_set_error(GSM_ERR_INVALID_PARAM);
        return ESP_ERR_INVALID_ARG;
    }

    char cmd[64];
    char resp[GSM_MAX_RESP_LEN + 1] = {0};
    snprintf(cmd, sizeof(cmd), "AT+CMGS=\"%s\"", phone);
    esp_err_t ret = gsm_send_command(cmd, resp, sizeof(resp), GSM_CMD_TIMEOUT_MS);
    if (ret != ESP_OK || strstr(resp, ">") == NULL) {
        return ret == ESP_OK ? ESP_FAIL : ret;
    }

    ret = gsm_uart_write((const uint8_t*)content, strlen(content));
    if (ret == ESP_OK) {
        ret = gsm_send_ctrl_z();
    }
    if (ret == ESP_OK) {
        ret = gsm_wait_for_ok(GSM_RESP_TIMEOUT_MS);
    }
    if (ret == ESP_OK) {
        g_stats.sms_sent++;
    }
    return ret;
}

esp_err_t gsm_send_sms_ucs2(const char* phone, const char* content)
{
    if (gsm_sms_init(GSM_SMS_MODE_TEXT, GSM_CHARSET_UCS2) != ESP_OK) {
        return ESP_FAIL;
    }
    return gsm_send_sms(phone, content);
}

esp_err_t gsm_read_sms(int index, gsm_sms_info_t* sms)
{
    if (index < 0 || sms == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    char cmd[32];
    char resp[GSM_MAX_RESP_LEN + 1] = {0};
    snprintf(cmd, sizeof(cmd), "AT+CMGR=%d", index);
    esp_err_t ret = gsm_send_command(cmd, resp, sizeof(resp), GSM_RESP_TIMEOUT_MS);
    if (ret != ESP_OK) {
        return ret;
    }
    memset(sms, 0, sizeof(gsm_sms_info_t));
    sms->index = index;
    sms->read = strstr(resp, "REC READ") != NULL;
    strncpy(sms->content, resp, GSM_MAX_SMS_LEN);
    sms->content[GSM_MAX_SMS_LEN] = '\0';
    return ESP_OK;
}

esp_err_t gsm_delete_sms(int index)
{
    if (index < 0) {
        return ESP_ERR_INVALID_ARG;
    }
    char cmd[32];
    snprintf(cmd, sizeof(cmd), "AT+CMGD=%d", index);
    return gsm_send_command_ok(cmd, GSM_CMD_TIMEOUT_MS);
}

esp_err_t gsm_delete_all_sms(void)
{
    return gsm_send_command_ok("AT+CMGD=1,4", GSM_CMD_TIMEOUT_MS);
}

esp_err_t gsm_set_sms_callback(gsm_sms_callback_t callback, void* user_data)
{
    g_sms_callback = callback;
    g_sms_callback_user_data = user_data;
    return ESP_OK;
}

esp_err_t gsm_make_call(const char* phone)
{
    if (phone == NULL || !gsm_is_valid_phone(phone)) {
        return ESP_ERR_INVALID_ARG;
    }
    char cmd[64];
    snprintf(cmd, sizeof(cmd), "ATD%s;", phone);
    esp_err_t ret = gsm_send_command_ok(cmd, GSM_CMD_TIMEOUT_MS);
    if (ret == ESP_OK) {
        g_stats.calls_made++;
    }
    return ret;
}

esp_err_t gsm_answer_call(void)
{
    return gsm_send_command_ok("ATA", GSM_CMD_TIMEOUT_MS);
}

esp_err_t gsm_hangup_call(void)
{
    return gsm_send_command_ok("ATH", GSM_CMD_TIMEOUT_MS);
}

esp_err_t gsm_enable_caller_id(bool enable)
{
    return gsm_send_command_ok(enable ? "AT+CLIP=1" : "AT+CLIP=0", GSM_CMD_TIMEOUT_MS);
}

esp_err_t gsm_set_call_callback(gsm_call_callback_t callback, void* user_data)
{
    g_call_callback = callback;
    g_call_callback_user_data = user_data;
    return ESP_OK;
}

esp_err_t gsm_gprs_init(const char* apn)
{
    if (apn != NULL && apn[0] != '\0') {
        strncpy(g_apn, apn, sizeof(g_apn) - 1);
        g_apn[sizeof(g_apn) - 1] = '\0';
    }
    esp_err_t ret = gsm_send_command_ok("AT+SAPBR=3,1,\"CONTYPE\",\"GPRS\"", GSM_CMD_TIMEOUT_MS);
    if (ret != ESP_OK) {
        return ret;
    }
    char cmd[96];
    snprintf(cmd, sizeof(cmd), "AT+SAPBR=3,1,\"APN\",\"%s\"", g_apn);
    return gsm_send_command_ok(cmd, GSM_CMD_TIMEOUT_MS);
}

esp_err_t gsm_gprs_attach(void)
{
    esp_err_t ret = gsm_send_command_ok("AT+CGATT=1", GSM_RESP_TIMEOUT_MS);
    if (ret == ESP_OK) {
        g_gprs_attached = true;
        gsm_set_state(GSM_STATE_GPRS_ATTACHED);
    }
    return ret;
}

esp_err_t gsm_gprs_detach(void)
{
    esp_err_t ret = gsm_send_command_ok("AT+CGATT=0", GSM_RESP_TIMEOUT_MS);
    g_gprs_attached = false;
    if (g_state >= GSM_STATE_GPRS_ATTACHED) {
        gsm_set_state(GSM_STATE_NETWORK_REGISTERED);
    }
    return ret;
}

bool gsm_gprs_is_attached(void)
{
    return g_gprs_attached;
}

esp_err_t gsm_net_start(gsm_net_type_t type, const char* remote_ip, uint16_t remote_port)
{
    if (remote_ip == NULL || remote_ip[0] == '\0' || remote_port == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    const char* type_str = type == GSM_NET_TYPE_UDP ? "UDP" : "TCP";
    char cmd[96];
    snprintf(cmd, sizeof(cmd), "AT+CIPSTART=\"%s\",\"%s\",\"%u\"", type_str, remote_ip, (unsigned)remote_port);
    esp_err_t ret = gsm_send_command_ok(cmd, GSM_RESP_TIMEOUT_MS);
    if (ret == ESP_OK) {
        g_net_connection.connected = true;
        g_net_connection.type = type;
        strncpy(g_net_connection.remote_ip, remote_ip, sizeof(g_net_connection.remote_ip) - 1);
        g_net_connection.remote_port = remote_port;
        gsm_set_state(GSM_STATE_CONNECTED);
    }
    return ret;
}

esp_err_t gsm_net_close(void)
{
    esp_err_t ret = gsm_send_command_ok("AT+CIPCLOSE", GSM_CMD_TIMEOUT_MS);
    g_net_connection.connected = false;
    if (g_state == GSM_STATE_CONNECTED) {
        gsm_set_state(g_gprs_attached ? GSM_STATE_GPRS_ATTACHED : GSM_STATE_NETWORK_REGISTERED);
    }
    return ret;
}

esp_err_t gsm_net_send(const uint8_t* data, size_t len)
{
    if (data == NULL || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!g_net_connection.connected) {
        return ESP_ERR_INVALID_STATE;
    }
    char cmd[32];
    char resp[GSM_MAX_RESP_LEN + 1] = {0};
    snprintf(cmd, sizeof(cmd), "AT+CIPSEND=%u", (unsigned)len);
    esp_err_t ret = gsm_send_command(cmd, resp, sizeof(resp), GSM_CMD_TIMEOUT_MS);
    if (ret != ESP_OK || strstr(resp, ">") == NULL) {
        return ret == ESP_OK ? ESP_FAIL : ret;
    }
    ret = gsm_uart_write(data, len);
    if (ret == ESP_OK) {
        ret = gsm_send_ctrl_z();
    }
    if (ret == ESP_OK) {
        g_stats.bytes_sent += len;
        ret = gsm_wait_for_ok(GSM_RESP_TIMEOUT_MS);
    }
    return ret;
}

esp_err_t gsm_net_send_string(const char* str)
{
    if (str == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    return gsm_net_send((const uint8_t*)str, strlen(str));
}

esp_err_t gsm_net_get_connection(gsm_net_connection_t* conn)
{
    if (conn == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memcpy(conn, &g_net_connection, sizeof(gsm_net_connection_t));
    return ESP_OK;
}

esp_err_t gsm_set_data_callback(gsm_data_callback_t callback, void* user_data)
{
    g_data_callback = callback;
    g_data_callback_user_data = user_data;
    return ESP_OK;
}

esp_err_t gsm_set_state_callback(gsm_state_callback_t callback, void* user_data)
{
    g_state_callback = callback;
    g_state_callback_user_data = user_data;
    return ESP_OK;
}

esp_err_t gsm_process_events(void)
{
    if (!g_uart_initialized) {
        return ESP_ERR_INVALID_STATE;
    }
    uint8_t buffer[128];
    int len = gsm_uart_read(buffer, sizeof(buffer) - 1, 10);
    if (len > 0) {
        buffer[len] = '\0';
        gsm_process_urc((const char*)buffer);
    }
    return ESP_OK;
}

esp_err_t gsm_utf8_to_ucs2(const char* utf8, uint8_t* ucs2, size_t ucs2_len)
{
    if (utf8 == NULL || ucs2 == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    size_t len = strlen(utf8);
    if (ucs2_len < len * 2) {
        return ESP_ERR_INVALID_SIZE;
    }
    for (size_t i = 0; i < len; ++i) {
        ucs2[i * 2] = 0;
        ucs2[i * 2 + 1] = (uint8_t)utf8[i];
    }
    return ESP_OK;
}

const char* gsm_error_to_string(gsm_error_t error)
{
    switch (error) {
        case GSM_ERR_NONE: return "none";
        case GSM_ERR_NOT_INIT: return "not_initialized";
        case GSM_ERR_UART_FAIL: return "uart_failed";
        case GSM_ERR_TIMEOUT: return "timeout";
        case GSM_ERR_NO_RESPONSE: return "no_response";
        case GSM_ERR_INVALID_RESPONSE: return "invalid_response";
        case GSM_ERR_CMD_FAILED: return "command_failed";
        case GSM_ERR_NO_SIM: return "no_sim";
        case GSM_ERR_NO_NETWORK: return "no_network";
        case GSM_ERR_INVALID_PARAM: return "invalid_param";
        case GSM_ERR_BUFFER_OVERFLOW: return "buffer_overflow";
        case GSM_ERR_NOT_SUPPORTED: return "not_supported";
        case GSM_ERR_BUSY: return "busy";
        case GSM_ERR_MEMORY: return "memory";
        default: return "unknown";
    }
}

const char* gsm_state_to_string(gsm_state_t state)
{
    switch (state) {
        case GSM_STATE_UNINITIALIZED: return "uninitialized";
        case GSM_STATE_INITIALIZED: return "initialized";
        case GSM_STATE_READY: return "ready";
        case GSM_STATE_NETWORK_REGISTERED: return "network_registered";
        case GSM_STATE_GPRS_ATTACHED: return "gprs_attached";
        case GSM_STATE_CONNECTED: return "connected";
        case GSM_STATE_ERROR: return "error";
        default: return "unknown";
    }
}
