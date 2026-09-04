/**
 * @file wifi_manager.cpp
 * @brief WiFi 管理模块实现
 * @details 实现 WiFi 连接、SmartConfig 配网、断线重连等功能
 * @author 智能睡眠监测台灯团队
 * @date 2024
 * @version 1.0.0
 * @copyright Copyright (c) 2024
 */

#include "wifi_manager.h"
#include "config.h"
#include <nvs.h>
#include <nvs_flash.h>
#include <stdlib.h>
#include <string.h>
#include <esp_log.h>
#include <esp_wifi.h>
#include <esp_event.h>
#include <esp_smartconfig.h>
#include <esp_netif.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/event_groups.h>

#ifndef WIFI_EVENT_STA_GOT_IP
#define WIFI_EVENT_STA_GOT_IP IP_EVENT_STA_GOT_IP
#endif
#ifndef WIFI_EVENT_STA_LOST_IP
#define WIFI_EVENT_STA_LOST_IP IP_EVENT_STA_LOST_IP
#endif

static const char* TAG = "WIFI_MGR";
static volatile bool s_initialized = false;

//=============================================================================
// 宏定义
//=============================================================================

#define NVS_NAMESPACE_WIFI      "wifi_config"   ///< NVS命名空间
#define NVS_KEY_SSID            "ssid"          ///< SSID键
#define NVS_KEY_PASSWORD        "password"      ///< 密码键
#define NVS_KEY_STATIC_IP       "static_ip"     ///< 静态IP标志键
#define NVS_KEY_IP              "ip"            ///< IP地址键
#define NVS_KEY_GATEWAY         "gateway"       ///< 网关键
#define NVS_KEY_SUBNET          "subnet"        ///< 子网掩码键

//=============================================================================
// 静态变量
//=============================================================================

static wifi_info_t s_wifiInfo;                          ///< WiFi信息
static wifi_manager_config_t s_wifiConfig;              ///< WiFi配置
static wifi_event_callback_t s_eventCallback = NULL;    ///< 事件回调
static SemaphoreHandle_t s_mutex = NULL;                ///< 互斥锁
static TaskHandle_t s_smartconfigTask = NULL;           ///< SmartConfig任务
static volatile bool s_smartconfigRunning = false;      ///< SmartConfig运行标志
static volatile bool s_shouldStopSmartconfig = false;   ///< 停止SmartConfig标志

// WiFi事件组
static EventGroupHandle_t s_wifiEventGroup = NULL;

// ESP-IDF WiFi 事件处理

//=============================================================================
// 静态函数声明
//=============================================================================

static void wifiEventHandler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data);
static void smartconfigTask(void *pvParameters);
static void notifyEvent(wifi_manager_event_t event, void* data);
static void updateWifiInfo(void);
static esp_netif_t* getStaNetif(void);

//=============================================================================
// API 实现
//=============================================================================

/**
 * @brief 初始化 WiFi 管理器
 */
bool wifi_manager_init(void) {
    if (s_initialized) {
        ESP_LOGI(TAG, "WiFi manager already initialized");
        return true;
    }

    ESP_LOGI(TAG, "初始化WiFi管理器...");
    
    // 创建互斥锁
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        ESP_LOGE(TAG, "创建互斥锁失败");
        return false;
    }
    
    // 创建事件组
    s_wifiEventGroup = xEventGroupCreate();
    if (s_wifiEventGroup == NULL) {
        ESP_LOGE(TAG, "创建事件组失败");
        return false;
    }
    
    // 初始化WiFi信息
    memset(&s_wifiInfo, 0, sizeof(s_wifiInfo));
    memset(&s_wifiConfig, 0, sizeof(s_wifiConfig));
    s_wifiInfo.state = WIFI_STATE_DISCONNECTED;

    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "esp_netif鍒濆鍖栧け璐? %d", err);
        return false;
    }

    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "鍒涘缓榛樿浜嬩欢寰幆澶辫触: %d", err);
        return false;
    }

    if (getStaNetif() == NULL) {
        ESP_LOGE(TAG, "鍒涘缓WiFi STA netif澶辫触");
        return false;
    }
    
    // 初始化WiFi
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "WiFi初始化失败: %d", err);
        return false;
    }
    
    // 注册WiFi事件处理
    err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifiEventHandler, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "注册WiFi事件处理失败: %d", err);
        return false;
    }
    
    err = esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, wifiEventHandler, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "注册IP事件处理失败: %d", err);
        return false;
    }
    
    // 设置WiFi模式为STA
    err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "设置WiFi模式失败: %d", err);
        return false;
    }
    
    // 启动WiFi
    err = esp_wifi_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "启动WiFi失败: %d", err);
        return false;
    }
    
    // 加载保存的配置
    if (wifi_manager_load_config()) {
        ESP_LOGI(TAG, "从NVS加载WiFi配置成功");
    } else {
        ESP_LOGW(TAG, "从NVS加载WiFi配置失败或没有保存的配置");
    }
    
    // 获取MAC地址
    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    snprintf(s_wifiInfo.mac_addr, sizeof(s_wifiInfo.mac_addr), 
             "%02X:%02X:%02X:%02X:%02X:%02X",
 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    
    ESP_LOGI(TAG, "WiFi管理器初始化完成, MAC: %s", s_wifiInfo.mac_addr);
    s_initialized = true;
    return true;
}

/**
 * @brief 反初始化 WiFi 管理器
 */
void wifi_manager_deinit(void) {
    ESP_LOGI(TAG, "反初始化WiFi管理器...");
    
    // 断开连接
    wifi_manager_disconnect();
    
    // 停止SmartConfig
    if (s_smartconfigRunning) {
        wifi_manager_stop_smartconfig();
    }
    
    // 释放资源
    if (s_wifiEventGroup != NULL) {
        vEventGroupDelete(s_wifiEventGroup);
        s_wifiEventGroup = NULL;
    }
    
    if (s_mutex != NULL) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    
    // 停止WiFi
    esp_wifi_stop();
    esp_wifi_deinit();
    s_initialized = false;
    
    ESP_LOGI(TAG, "WiFi管理器反初始化完成");
}

/**
 * @brief 连接到指定 WiFi
 */
bool wifi_manager_connect(const char* ssid, const char* password, uint32_t timeout_ms) {
    if (ssid == NULL) {
        ssid = s_wifiConfig.ssid;
        password = s_wifiConfig.password;
    }

    if (ssid == NULL || strlen(ssid) == 0) {
        ESP_LOGE(TAG, "SSID为空");
        return false;
    }
    
    if (strlen(ssid) > WIFI_MAX_SSID_LEN) {
        ESP_LOGE(TAG, "SSID过长");
        return false;
    }
    
    if (password != NULL && strlen(password) > WIFI_MAX_PASS_LEN) {
        ESP_LOGE(TAG, "密码过长");
        return false;
    }
    
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    // 如果已经连接，先断开
    if (s_wifiInfo.state == WIFI_STATE_CONNECTED || 
        s_wifiInfo.state == WIFI_STATE_GOT_IP) {
        esp_wifi_disconnect();
        s_wifiInfo.state = WIFI_STATE_DISCONNECTED;
    }
    
    // 保存配置
    strncpy(s_wifiConfig.ssid, ssid, sizeof(s_wifiConfig.ssid) - 1);
    if (password != NULL) {
        strncpy(s_wifiConfig.password, password, sizeof(s_wifiConfig.password) - 1);
    } else {
        s_wifiConfig.password[0] = '\0';
    }
    
    ESP_LOGI(TAG, "连接到WiFi: %s", ssid);
    
    // 更新状态
    s_wifiInfo.state = WIFI_STATE_CONNECTING;
    
    // 清除事件位
    xEventGroupClearBits(s_wifiEventGroup, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT | WIFI_GOT_IP_BIT);
    
    // 配置WiFi
    wifi_config_t wifi_config = {};
    strncpy((char*)wifi_config.sta.ssid, s_wifiConfig.ssid, sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char*)wifi_config.sta.password, s_wifiConfig.password, sizeof(wifi_config.sta.password) - 1);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    
    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &wifi_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "设置WiFi配置失败: %d", err);
        xSemaphoreGive(s_mutex);
        return false;
    }
    
    // 开始连接
    err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "启动WiFi连接失败: %d", err);
        xSemaphoreGive(s_mutex);
        return false;
    }
    
    xSemaphoreGive(s_mutex);
    
    // 等待连接完成或超时
    EventBits_t bits = xEventGroupWaitBits(
        s_wifiEventGroup,
        WIFI_FAIL_BIT | WIFI_GOT_IP_BIT,
        pdFALSE,
        pdFALSE,
        pdMS_TO_TICKS(timeout_ms)
    );
    
    if (bits & WIFI_GOT_IP_BIT) {
        ESP_LOGI(TAG, "WiFi连接成功，获取到IP: %s", s_wifiInfo.local_ip);
        updateWifiInfo();
        
        // 保存配置到NVS
        wifi_manager_save_config();
        
        return true;
    } else if (bits & WIFI_FAIL_BIT) {
        ESP_LOGE(TAG, "WiFi连接失败");
        s_wifiInfo.state = WIFI_STATE_ERROR;
        return false;
    } else {
        ESP_LOGW(TAG, "WiFi连接超时");
        esp_wifi_disconnect();
        s_wifiInfo.state = WIFI_STATE_DISCONNECTED;
        return false;
    }
}

/**
 * @brief 断开 WiFi 连接
 */
void wifi_manager_disconnect(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    
    if (s_wifiInfo.state != WIFI_STATE_DISCONNECTED) {
        ESP_LOGI(TAG, "断开WiFi连接");
        esp_wifi_disconnect();
        s_wifiInfo.state = WIFI_STATE_DISCONNECTED;
        s_wifiInfo.connect_time = 0;
        s_wifiInfo.disconnect_count++;
    }
    
    xSemaphoreGive(s_mutex);
}

/**
 * @brief 开始 SmartConfig 配网
 */
bool wifi_manager_start_smartconfig(uint32_t timeout_ms) {
    if (s_smartconfigRunning) {
        ESP_LOGW(TAG, "SmartConfig已经在运行中");
        return true;
    }
    
    ESP_LOGI(TAG, "启动SmartConfig配网...");
    
    // 设置停止标志
    s_shouldStopSmartconfig = false;
    
    // 创建SmartConfig任务
    BaseType_t result = xTaskCreatePinnedToCore(
        smartconfigTask,
        "SmartConfigTask",
        2048,
        (void*)(uintptr_t)timeout_ms,
        TASK_PRIORITY_NORMAL,
        &s_smartconfigTask,
        0
    );
    
    if (result != pdPASS) {
        ESP_LOGE(TAG, "创建SmartConfig任务失败");
        return false;
    }
    
    s_smartconfigRunning = true;
    s_wifiInfo.state = WIFI_STATE_SMARTCONFIG;
    
    return true;
}

/**
 * @brief 停止 SmartConfig 配网
 */
void wifi_manager_stop_smartconfig(void) {
    if (!s_smartconfigRunning) {
        return;
    }
    
    ESP_LOGI(TAG, "停止SmartConfig配网");
    
    // 设置停止标志
    s_shouldStopSmartconfig = true;
    
    // 停止SmartConfig
    esp_smartconfig_stop();
    
    // 等待任务结束
    vTaskDelay(pdMS_TO_TICKS(100));
    
    s_smartconfigRunning = false;
    
    if (s_wifiInfo.state == WIFI_STATE_SMARTCONFIG) {
        s_wifiInfo.state = WIFI_STATE_DISCONNECTED;
    }
}

/**
 * @brief 扫描 WiFi 热点
 */
int wifi_manager_scan(wifi_ap_info_t* results, int max_count, uint32_t timeout_ms) {
    if (results == NULL || max_count <= 0) {
        return -1;
    }
    
    ESP_LOGI(TAG, "开始扫描WiFi...");
    
    // 开始扫描
    wifi_scan_config_t scan_config = {};
    scan_config.scan_type = WIFI_SCAN_TYPE_ACTIVE;
    scan_config.scan_time.active.min = 0;
    scan_config.scan_time.active.max = timeout_ms;
    
    esp_err_t err = esp_wifi_scan_start(&scan_config, true);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "WiFi扫描失败: %d", err);
        return -1;
    }
    
    // 等待扫描完成
    uint16_t ap_count = 0;
    err = esp_wifi_scan_get_ap_num(&ap_count);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "获取扫描结果数量失败: %d", err);
        return -1;
    }
    
    ESP_LOGI(TAG, "扫描完成，发现 %d 个网络", ap_count);
    
    // 获取扫描结果
    wifi_ap_record_t* ap_list = (wifi_ap_record_t*)malloc(sizeof(wifi_ap_record_t) * ap_count);
    if (ap_list == NULL) {
        ESP_LOGE(TAG, "分配内存失败");
        return -1;
    }
    
    err = esp_wifi_scan_get_ap_records(&ap_count, ap_list);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "获取扫描结果失败: %d", err);
        free(ap_list);
        return -1;
    }
    
    // 复制结果
    int count = (ap_count < max_count) ? ap_count : max_count;
    for (int i = 0; i < count; i++) {
        strncpy(results[i].ssid, (char*)ap_list[i].ssid, WIFI_MAX_SSID_LEN);
        results[i].ssid[WIFI_MAX_SSID_LEN] = '\0';
        
        results[i].rssi = ap_list[i].rssi;
        results[i].channel = ap_list[i].primary;
        results[i].secure = (ap_list[i].authmode != WIFI_AUTH_OPEN);
        
        // 获取BSSID
        memcpy(results[i].bssid, ap_list[i].bssid, 6);
    }
    
    free(ap_list);
    return count;
}

/**
 * @brief 获取 WiFi 信息
 */
const wifi_info_t* wifi_manager_get_info(void) {
    return &s_wifiInfo;
}

/**
 * @brief 获取当前 WiFi 状态
 */
wifi_state_t wifi_manager_get_state(void) {
    return s_wifiInfo.state;
}

/**
 * @brief 检查是否已连接
 */
bool wifi_manager_is_connected(void) {
    wifi_ap_record_t ap_info;
    esp_err_t err = esp_wifi_sta_get_ap_info(&ap_info);
    return (err == ESP_OK && s_wifiInfo.state == WIFI_STATE_GOT_IP);
}

/**
 * @brief 获取 RSSI (信号强度)
 */
int8_t wifi_manager_get_rssi(void) {
    if (!wifi_manager_is_connected()) {
        return 0;
    }
    
    wifi_ap_record_t ap_info;
    esp_err_t err = esp_wifi_sta_get_ap_info(&ap_info);
    if (err == ESP_OK) {
        return ap_info.rssi;
    }
    return 0;
}

/**
 * @brief 设置 WiFi 事件回调
 */
void wifi_manager_set_event_callback(wifi_event_callback_t callback) {
    s_eventCallback = callback;
}

/**
 * @brief 保存 WiFi 配置到 NVS
 */
bool wifi_manager_save_config(void) {
    ESP_LOGI(TAG, "保存WiFi配置到NVS...");
    
    nvs_handle_t nvsHandle;
    esp_err_t err = nvs_open(NVS_NAMESPACE_WIFI, NVS_READWRITE, &nvsHandle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "打开NVS失败: %d", err);
        return false;
    }
    
    // 保存SSID
    err = nvs_set_str(nvsHandle, NVS_KEY_SSID, s_wifiConfig.ssid);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "保存SSID失败: %d", err);
        nvs_close(nvsHandle);
        return false;
    }
    
    // 保存密码
    err = nvs_set_str(nvsHandle, NVS_KEY_PASSWORD, s_wifiConfig.password);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "保存密码失败: %d", err);
        nvs_close(nvsHandle);
        return false;
    }
    
    // 提交更改
    err = nvs_commit(nvsHandle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "提交NVS失败: %d", err);
        nvs_close(nvsHandle);
        return false;
    }
    
    nvs_close(nvsHandle);
    ESP_LOGI(TAG, "WiFi配置保存成功");
    return true;
}

/**
 * @brief 从 NVS 加载 WiFi 配置
 */
bool wifi_manager_load_config(void) {
    ESP_LOGI(TAG, "从NVS加载WiFi配置...");
    
    nvs_handle_t nvsHandle;
    esp_err_t err = nvs_open(NVS_NAMESPACE_WIFI, NVS_READONLY, &nvsHandle);
    if (err != ESP_OK) {
        if (err == ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGI(TAG, "NVS命名空间不存在，可能是第一次运行");
        } else {
            ESP_LOGE(TAG, "打开NVS失败: %d", err);
        }
        return false;
    }
    
    // 加载SSID
    size_t len = sizeof(s_wifiConfig.ssid);
    err = nvs_get_str(nvsHandle, NVS_KEY_SSID, s_wifiConfig.ssid, &len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "读取SSID失败: %d", err);
        nvs_close(nvsHandle);
        return false;
    }
    
    // 加载密码
    len = sizeof(s_wifiConfig.password);
    err = nvs_get_str(nvsHandle, NVS_KEY_PASSWORD, s_wifiConfig.password, &len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "读取密码失败: %d", err);
        nvs_close(nvsHandle);
        return false;
    }
    
    nvs_close(nvsHandle);
    ESP_LOGI(TAG, "WiFi配置加载成功: SSID=%s", s_wifiConfig.ssid);
    return true;
}

/**
 * @brief 清除保存的 WiFi 配置
 */
bool wifi_manager_clear_config(void) {
    ESP_LOGI(TAG, "清除WiFi配置...");
    
    nvs_handle_t nvsHandle;
    esp_err_t err = nvs_open(NVS_NAMESPACE_WIFI, NVS_READWRITE, &nvsHandle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "打开NVS失败: %d", err);
        return false;
    }
    
    // 删除所有键
    nvs_erase_key(nvsHandle, NVS_KEY_SSID);
    nvs_erase_key(nvsHandle, NVS_KEY_PASSWORD);
    nvs_erase_key(nvsHandle, NVS_KEY_STATIC_IP);
    nvs_erase_key(nvsHandle, NVS_KEY_IP);
    nvs_erase_key(nvsHandle, NVS_KEY_GATEWAY);
    nvs_erase_key(nvsHandle, NVS_KEY_SUBNET);
    
    // 提交更改
    err = nvs_commit(nvsHandle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "提交NVS失败: %d", err);
        nvs_close(nvsHandle);
        return false;
    }
    
    nvs_close(nvsHandle);
    
    // 清除除内存中的配置
    memset(&s_wifiConfig, 0, sizeof(s_wifiConfig));
    
    ESP_LOGI(TAG, "WiFi配置已清除");
    return true;
}

/**
 * @brief 设置静态 IP
 */
bool wifi_manager_set_static_ip(uint32_t ip, uint32_t gateway, uint32_t subnet) {
    ESP_LOGI(TAG, "设置静态IP...");
    
    // 停止DHCP
    esp_netif_t* sta_netif = getStaNetif();
    if (sta_netif == NULL) {
        ESP_LOGE(TAG, "WiFi STA netif不可用");
        return false;
    }

    esp_netif_dhcpc_stop(sta_netif);
    
    // 配置IP
    esp_netif_ip_info_t ip_info;
    ip_info.ip.addr = ip;
    ip_info.gw.addr = gateway;
    ip_info.netmask.addr = subnet;
    
    esp_err_t err = esp_netif_set_ip_info(sta_netif, &ip_info);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "设置静态IP失败: %d", err);
        return false;
    }
    
    // 保存配置
    s_wifiConfig.static_ip = true;
    s_wifiConfig.ip = ip;
    s_wifiConfig.gateway = gateway;
    s_wifiConfig.subnet = subnet;
    
    ESP_LOGI(TAG, "静态IP设置成功");
    return true;
}

/**
 * @brief 启用 DHCP
 */
bool wifi_manager_enable_dhcp(void) {
    ESP_LOGI(TAG, "启用DHCP...");
    
    // 启动DHCP
    esp_netif_t* sta_netif = getStaNetif();
    if (sta_netif == NULL) {
        ESP_LOGE(TAG, "WiFi STA netif不可用");
        return false;
    }

    esp_err_t err = esp_netif_dhcpc_start(sta_netif);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "启用DHCP失败: %d", err);
        return false;
    }
    
    s_wifiConfig.static_ip = false;
    s_wifiConfig.ip = 0;
    s_wifiConfig.gateway = 0;
    s_wifiConfig.subnet = 0;
    
    ESP_LOGI(TAG, "DHCP已启用");
    return true;
}

/**
 * @brief 获取 MAC 地址
 */
void wifi_manager_get_mac(uint8_t* mac) {
    if (mac != NULL) {
        esp_wifi_get_mac(WIFI_IF_STA, mac);
    }
}

/**
 * @brief 获取 MAC 地址字符串
 */
const char* wifi_manager_get_mac_str(void) {
    return s_wifiInfo.mac_addr;
}

//=============================================================================
// 静态函数实现
//=============================================================================

/**
 * @brief WiFi 事件处理
 */
static void wifiEventHandler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data) {
    if (event_base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_STA_START:
                ESP_LOGI(TAG, "WiFi STA启动");
                break;
                
            case WIFI_EVENT_STA_STOP:
                ESP_LOGI(TAG, "WiFi STA停止");
                break;
                
            case WIFI_EVENT_STA_CONNECTED:
                ESP_LOGI(TAG, "WiFi已连接");
                
                xSemaphoreTake(s_mutex, portMAX_DELAY);
                s_wifiInfo.state = WIFI_STATE_CONNECTED;
                xSemaphoreGive(s_mutex);
                
                xEventGroupSetBits(s_wifiEventGroup, WIFI_CONNECTED_BIT);
                notifyEvent(WIFI_MANAGER_EVENT_CONNECTED, NULL);
                break;
                
            case WIFI_EVENT_STA_DISCONNECTED:
                ESP_LOGW(TAG, "WiFi断开连接");
                
                xSemaphoreTake(s_mutex, portMAX_DELAY);
                s_wifiInfo.state = WIFI_STATE_DISCONNECTED;
                s_wifiInfo.disconnect_count++;
                xSemaphoreGive(s_mutex);
                
                xEventGroupSetBits(s_wifiEventGroup, WIFI_FAIL_BIT);
                xEventGroupClearBits(s_wifiEventGroup, WIFI_CONNECTED_BIT | WIFI_GOT_IP_BIT);
                notifyEvent(WIFI_MANAGER_EVENT_DISCONNECTED, NULL);
                break;
                
            case WIFI_EVENT_STA_GOT_IP:
                ESP_LOGI(TAG, "WiFi获取到IP");
                
                updateWifiInfo();
                
                xSemaphoreTake(s_mutex, portMAX_DELAY);
                s_wifiInfo.state = WIFI_STATE_GOT_IP;
                xSemaphoreGive(s_mutex);
                
                xEventGroupSetBits(s_wifiEventGroup, WIFI_GOT_IP_BIT);
                notifyEvent(WIFI_MANAGER_EVENT_GOT_IP, NULL);
                break;
                
            case WIFI_EVENT_STA_LOST_IP:
                ESP_LOGW(TAG, "WiFi丢失IP");
                
                xSemaphoreTake(s_mutex, portMAX_DELAY);
                s_wifiInfo.state = WIFI_STATE_CONNECTED;
                xSemaphoreGive(s_mutex);
                
                xEventGroupClearBits(s_wifiEventGroup, WIFI_GOT_IP_BIT);
                notifyEvent(WIFI_MANAGER_EVENT_LOST_IP, NULL);
                break;
                
            default:
                break;
        }
    } else if (event_base == IP_EVENT) {
        if (event_id == IP_EVENT_STA_GOT_IP) {
            updateWifiInfo();

            xSemaphoreTake(s_mutex, portMAX_DELAY);
            s_wifiInfo.state = WIFI_STATE_GOT_IP;
            xSemaphoreGive(s_mutex);

            xEventGroupSetBits(s_wifiEventGroup, WIFI_GOT_IP_BIT);
            notifyEvent(WIFI_MANAGER_EVENT_GOT_IP, NULL);
        } else if (event_id == IP_EVENT_STA_LOST_IP) {
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            s_wifiInfo.state = WIFI_STATE_CONNECTED;
            xSemaphoreGive(s_mutex);

            xEventGroupClearBits(s_wifiEventGroup, WIFI_GOT_IP_BIT);
            notifyEvent(WIFI_MANAGER_EVENT_LOST_IP, NULL);
        }
    } else if (event_base == SC_EVENT && event_id == SC_EVENT_GOT_SSID_PSWD) {
        smartconfig_event_got_ssid_pswd_t* evt = (smartconfig_event_got_ssid_pswd_t*)event_data;
        ESP_LOGI(TAG, "SmartConfig获取到SSID: %s", evt->ssid);
        
        // 保存配置
        strncpy(s_wifiConfig.ssid, (char*)evt->ssid, sizeof(s_wifiConfig.ssid) - 1);
        strncpy(s_wifiConfig.password, (char*)evt->password, sizeof(s_wifiConfig.password) - 1);
        
        // 连接WiFi
        wifi_manager_connect(s_wifiConfig.ssid, s_wifiConfig.password, WIFI_CONNECT_TIMEOUT_MS);
        
        notifyEvent(WIFI_MANAGER_EVENT_SMARTCONFIG_DONE, NULL);
    }
}

/**
 * @brief SmartConfig 任务
 */
static void smartconfigTask(void *pvParameters) {
    uint32_t timeout_ms = (uint32_t)(uintptr_t)pvParameters;
    
    ESP_LOGI(TAG, "SmartConfig任务启动，超时: %lu ms", (unsigned long)timeout_ms);
    
    // 初始化SmartConfig
    smartconfig_start_config_t cfg = SMARTCONFIG_START_CONFIG_DEFAULT();
    esp_err_t err = esp_smartconfig_start(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "启动SmartConfig失败: %d", err);
        s_smartconfigRunning = false;
        vTaskDelete(NULL);
        return;
    }
    
    // 等待SmartConfig完成或超时
    TickType_t start_time = xTaskGetTickCount();
    while (!s_shouldStopSmartconfig) {
        vTaskDelay(pdMS_TO_TICKS(100));
        
        // 检查超时
        if (timeout_ms > 0) {
            TickType_t elapsed = xTaskGetTickCount() - start_time;
            if (elapsed > pdMS_TO_TICKS(timeout_ms)) {
                ESP_LOGW(TAG, "SmartConfig超时");
                notifyEvent(WIFI_MANAGER_EVENT_SMARTCONFIG_TIMEOUT, NULL);
                break;
            }
        }
    }
    
    // 停止SmartConfig
    esp_smartconfig_stop();
    
    s_smartconfigRunning = false;
    ESP_LOGI(TAG, "SmartConfig任务结束");
    vTaskDelete(NULL);
}

/**
 * @brief 通知事件
 */
static void notifyEvent(wifi_manager_event_t event, void* data) {
    if (s_eventCallback != NULL) {
        s_eventCallback(event, data);
    }
}

/**
 * @brief 更新WiFi信息
 */
static void updateWifiInfo(void) {
    // 获取IP信息
    esp_netif_t* sta_netif = getStaNetif();
    if (sta_netif == NULL) {
        ESP_LOGW(TAG, "WiFi STA netif不可用，跳过IP信息更新");
        return;
    }

    esp_netif_ip_info_t ip_info;
    esp_err_t err = esp_netif_get_ip_info(sta_netif, &ip_info);
    if (err == ESP_OK) {
        snprintf(s_wifiInfo.local_ip, sizeof(s_wifiInfo.local_ip), 
                 "%u.%u.%u.%u", IP2STR(&ip_info.ip));
        snprintf(s_wifiInfo.gateway_ip, sizeof(s_wifiInfo.gateway_ip), 
                 "%u.%u.%u.%u", IP2STR(&ip_info.gw));
        snprintf(s_wifiInfo.subnet_mask, sizeof(s_wifiInfo.subnet_mask), 
                 "%u.%u.%u.%u", IP2STR(&ip_info.netmask));
    }
    
    // 获取AP信息
    wifi_ap_record_t ap_info;
    err = esp_wifi_sta_get_ap_info(&ap_info);
    if (err == ESP_OK) {
        s_wifiInfo.config.rssi = ap_info.rssi;
        s_wifiInfo.config.channel = ap_info.primary;
    }
}

static esp_netif_t* getStaNetif(void) {
    esp_netif_t* sta_netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (sta_netif == NULL) {
        sta_netif = esp_netif_create_default_wifi_sta();
    }
    return sta_netif;
}
