#include "provisioning_service.h"

#include <stdio.h>
#include <string.h>

#include "config.h"
#include "wifi_manager.h"

#include "cJSON.h"
#include "esp_err.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs.h"

#if CONFIG_BT_NIMBLE_ENABLED
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#endif

static const char* TAG = "PROVISIONING";

#define NVS_NAMESPACE_PROVISIONING "provisioning"
#define NVS_KEY_BIND_TOKEN "bind_token"
#define PROVISIONING_QUEUE_LEN 3
#define PROVISIONING_JSON_MAX_LEN 320
#define PROVISIONING_SOFTAP_CHANNEL 6
#define PROVISIONING_SOFTAP_MAX_CONN 4

#if CONFIG_BT_NIMBLE_ENABLED
#define UUID16_PROVISIONING_SERVICE 0xA100
#define UUID16_PROVISIONING_WRITE   0xA101
#define UUID16_PROVISIONING_STATUS  0xA102
#endif

typedef struct {
    char ssid[WIFI_MAX_SSID_LEN + 1];
    char password[WIFI_MAX_PASS_LEN + 1];
    char bind_token[PROVISIONING_BIND_TOKEN_MAX_LEN];
} provisioning_request_t;

static QueueHandle_t s_requestQueue = NULL;
static TaskHandle_t s_workerTask = NULL;
static httpd_handle_t s_httpServer = NULL;
static volatile bool s_running = false;
static char s_statusJson[160] = "{\"state\":\"idle\"}";
static char s_deviceName[PROVISIONING_DEVICE_NAME_MAX_LEN] = "SleepLamp";

#if CONFIG_BT_NIMBLE_ENABLED
static uint8_t s_bleAddrType = 0;
static uint16_t s_statusConnHandle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_statusValHandle = 0;
static volatile bool s_bleInitialized = false;
static volatile bool s_bleAdvertiseRequested = false;
#endif

static void workerTask(void* pv);
static bool parseProvisioningJson(const char* json, provisioning_request_t* out);
static void setStatus(const char* state, const char* detail);
static void publishStatusNotify(void);
static void buildDeviceName(void);
static bool saveBindToken(const char* bind_token);
static bool startSoftAp(void);
static bool startHttpServer(void);
static esp_err_t provisionHttpHandler(httpd_req_t* req);

#if CONFIG_BT_NIMBLE_ENABLED
static bool initBleStack(void);
static bool startBleAdvertising(void);
static void bleHostTask(void* param);
static void bleOnSync(void);
static int bleGapEvent(struct ble_gap_event* event, void* arg);
static int bleGattAccess(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt* ctxt, void* arg);

static const ble_uuid16_t s_uuidProvisioningService = BLE_UUID16_INIT(UUID16_PROVISIONING_SERVICE);
static const ble_uuid16_t s_uuidProvisioningWrite = BLE_UUID16_INIT(UUID16_PROVISIONING_WRITE);
static const ble_uuid16_t s_uuidProvisioningStatus = BLE_UUID16_INIT(UUID16_PROVISIONING_STATUS);

static const struct ble_gatt_chr_def s_gattCharacteristics[] = {
    {
        (const ble_uuid_t*)&s_uuidProvisioningWrite,
        bleGattAccess,
        NULL,
        NULL,
        BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
        0,
        NULL,
        NULL,
    },
    {
        (const ble_uuid_t*)&s_uuidProvisioningStatus,
        bleGattAccess,
        NULL,
        NULL,
        BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
        0,
        &s_statusValHandle,
        NULL,
    },
    { 0 },
};

static const struct ble_gatt_svc_def s_gattServices[] = {
    {
        BLE_GATT_SVC_TYPE_PRIMARY,
        (const ble_uuid_t*)&s_uuidProvisioningService,
        NULL,
        s_gattCharacteristics,
    },
    { 0 },
};
#endif

bool provisioning_service_init(void) {
    if (s_requestQueue == NULL) {
        s_requestQueue = xQueueCreate(PROVISIONING_QUEUE_LEN, sizeof(provisioning_request_t));
        if (s_requestQueue == NULL) {
            ESP_LOGE(TAG, "Failed to create provisioning queue");
            return false;
        }
    }

    buildDeviceName();

    return true;
}

bool provisioning_service_start(provisioning_reason_t reason) {
    if (!provisioning_service_init()) {
        return false;
    }

    if (s_running) {
        return true;
    }

    s_running = true;
    setStatus("waiting", "waiting for WiFi credentials");
    ESP_LOGI(TAG, "Starting provisioning mode, reason=%d, name=%s", (int)reason, s_deviceName);

    if (s_workerTask == NULL) {
        BaseType_t ok = xTaskCreatePinnedToCore(
            workerTask,
            "ProvisioningTask",
            3072,
            NULL,
            TASK_PRIORITY_NORMAL,
            &s_workerTask,
            0
        );
        if (ok != pdPASS) {
            ESP_LOGE(TAG, "Failed to create provisioning task");
            s_running = false;
            return false;
        }
    }

#if CONFIG_BT_NIMBLE_ENABLED
    if (!startBleAdvertising()) {
        ESP_LOGW(TAG, "BLE provisioning unavailable, SoftAP fallback stays active");
    }
#else
    ESP_LOGW(TAG, "BLE provisioning is disabled in sdkconfig; SoftAP fallback stays active");
#endif

    if (!startSoftAp()) {
        ESP_LOGW(TAG, "SoftAP fallback failed to start");
    }

    return true;
}

bool provisioning_service_is_running(void) {
    return s_running;
}

bool provisioning_service_get_bind_token(char* buffer, size_t buffer_size) {
    if (buffer == NULL || buffer_size == 0) {
        return false;
    }
    buffer[0] = '\0';

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE_PROVISIONING, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return false;
    }

    size_t len = buffer_size;
    err = nvs_get_str(handle, NVS_KEY_BIND_TOKEN, buffer, &len);
    nvs_close(handle);
    return err == ESP_OK && buffer[0] != '\0';
}

bool provisioning_service_clear_bind_token(void) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE_PROVISIONING, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return false;
    }
    nvs_erase_key(handle, NVS_KEY_BIND_TOKEN);
    err = nvs_commit(handle);
    nvs_close(handle);
    return err == ESP_OK;
}

static void workerTask(void* pv) {
    (void)pv;
    provisioning_request_t request;

    for (;;) {
        if (xQueueReceive(s_requestQueue, &request, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        ESP_LOGI(TAG, "Provisioning request received for SSID=%s", request.ssid);
        setStatus("connecting_router", request.ssid);

        if (!saveBindToken(request.bind_token)) {
            ESP_LOGW(TAG, "Failed to persist bind token");
        }

        bool ok = wifi_manager_connect(request.ssid, request.password, WIFI_CONNECT_TIMEOUT_MS);
        if (ok) {
            setStatus("wifi_connected", "router connected");
            s_running = false;
            ESP_LOGI(TAG, "Provisioning WiFi connected; MQTT status will carry bind token");
        } else {
            setStatus("wifi_failed", "check password or 2.4G router signal");
            ESP_LOGW(TAG, "Provisioning WiFi connect failed");
        }
    }
}

static bool parseProvisioningJson(const char* json, provisioning_request_t* out) {
    if (json == NULL || out == NULL) {
        return false;
    }

    cJSON* root = cJSON_Parse(json);
    if (root == NULL) {
        return false;
    }

    cJSON* ssid = cJSON_GetObjectItem(root, "ssid");
    cJSON* password = cJSON_GetObjectItem(root, "password");
    cJSON* bindToken = cJSON_GetObjectItem(root, "bindToken");
    if (bindToken == NULL) {
        bindToken = cJSON_GetObjectItem(root, "bind_token");
    }

    bool ok = cJSON_IsString(ssid) && ssid->valuestring[0] != '\0' &&
              strlen(ssid->valuestring) <= WIFI_MAX_SSID_LEN &&
              (!password || (cJSON_IsString(password) && strlen(password->valuestring) <= WIFI_MAX_PASS_LEN)) &&
              cJSON_IsString(bindToken) && bindToken->valuestring[0] != '\0' &&
              strlen(bindToken->valuestring) < PROVISIONING_BIND_TOKEN_MAX_LEN;

    if (ok) {
        memset(out, 0, sizeof(*out));
        strncpy(out->ssid, ssid->valuestring, sizeof(out->ssid) - 1);
        if (password && password->valuestring) {
            strncpy(out->password, password->valuestring, sizeof(out->password) - 1);
        }
        strncpy(out->bind_token, bindToken->valuestring, sizeof(out->bind_token) - 1);
    }

    cJSON_Delete(root);
    return ok;
}

static void setStatus(const char* state, const char* detail) {
    snprintf(s_statusJson, sizeof(s_statusJson),
             "{\"state\":\"%s\",\"detail\":\"%s\"}",
             state != NULL ? state : "unknown",
             detail != NULL ? detail : "");
    ESP_LOGI(TAG, "Provisioning status: %s", s_statusJson);
    publishStatusNotify();
}

static void publishStatusNotify(void) {
#if CONFIG_BT_NIMBLE_ENABLED
    if (s_statusConnHandle != BLE_HS_CONN_HANDLE_NONE && s_statusValHandle != 0) {
        struct os_mbuf* om = ble_hs_mbuf_from_flat(s_statusJson, strlen(s_statusJson));
        if (om != NULL) {
            ble_gatts_notify_custom(s_statusConnHandle, s_statusValHandle, om);
        }
    }
#endif
}

static void buildDeviceName(void) {
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        snprintf(s_deviceName, sizeof(s_deviceName), "SleepLamp-%02X%02X", mac[4], mac[5]);
    }
}

static bool saveBindToken(const char* bind_token) {
    if (bind_token == NULL || bind_token[0] == '\0') {
        return false;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE_PROVISIONING, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return false;
    }

    err = nvs_set_str(handle, NVS_KEY_BIND_TOKEN, bind_token);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err == ESP_OK;
}

static bool startSoftAp(void) {
    esp_netif_t* ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if (ap == NULL) {
        ap = esp_netif_create_default_wifi_ap();
    }
    if (ap == NULL) {
        return false;
    }

    wifi_config_t ap_config = {};
    strncpy((char*)ap_config.ap.ssid, s_deviceName, sizeof(ap_config.ap.ssid) - 1);
    ap_config.ap.ssid_len = strlen(s_deviceName);
    ap_config.ap.channel = PROVISIONING_SOFTAP_CHANNEL;
    ap_config.ap.max_connection = PROVISIONING_SOFTAP_MAX_CONN;
    ap_config.ap.authmode = WIFI_AUTH_OPEN;

    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_mode(WIFI_MODE_APSTA));
    esp_err_t err = esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set SoftAP config: %s", esp_err_to_name(err));
        return false;
    }

    ESP_LOGI(TAG, "SoftAP fallback active: SSID=%s URL=http://192.168.4.1/provision", s_deviceName);
    return startHttpServer();
}

static bool startHttpServer(void) {
    if (s_httpServer != NULL) {
        return true;
    }

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 2048;
    esp_err_t err = httpd_start(&s_httpServer, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "HTTP server start failed: %s", esp_err_to_name(err));
        s_httpServer = NULL;
        return false;
    }

    httpd_uri_t provision_uri = {};
    provision_uri.uri = "/provision";
    provision_uri.method = HTTP_POST;
    provision_uri.handler = provisionHttpHandler;
    provision_uri.user_ctx = NULL;
    httpd_register_uri_handler(s_httpServer, &provision_uri);
    return true;
}

static esp_err_t provisionHttpHandler(httpd_req_t* req) {
    char body[PROVISIONING_JSON_MAX_LEN] = {0};
    int received = httpd_req_recv(req, body, sizeof(body) - 1);
    if (received <= 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty body");
        return ESP_FAIL;
    }
    body[received] = '\0';

    provisioning_request_t request;
    if (!parseProvisioningJson(body, &request)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid provisioning json");
        return ESP_FAIL;
    }

    if (xQueueSend(s_requestQueue, &request, pdMS_TO_TICKS(100)) != pdTRUE) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "queue full");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":true}");
    return ESP_OK;
}

#if CONFIG_BT_NIMBLE_ENABLED
static bool initBleStack(void) {
    if (!s_bleInitialized) {
        ESP_LOGI(TAG, "Initializing NimBLE stack, internal heap=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        esp_err_t err = nimble_port_init();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "nimble_port_init failed: %s", esp_err_to_name(err));
            return false;
        }

        ble_svc_gap_init();
        ble_svc_gatt_init();
        ble_svc_gap_device_name_set(s_deviceName);

        int rc = ble_gatts_count_cfg(s_gattServices);
        if (rc != 0) {
            ESP_LOGE(TAG, "ble_gatts_count_cfg failed: %d", rc);
            return false;
        }
        rc = ble_gatts_add_svcs(s_gattServices);
        if (rc != 0) {
            ESP_LOGE(TAG, "ble_gatts_add_svcs failed: %d", rc);
            return false;
        }

        ble_hs_cfg.sync_cb = bleOnSync;
        nimble_port_freertos_init(bleHostTask);
        s_bleInitialized = true;
        ESP_LOGI(TAG, "NimBLE stack initialized, internal heap=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    }

    return true;
}

static bool startBleAdvertising(void) {
    s_bleAdvertiseRequested = true;
    if (!initBleStack()) {
        return false;
    }

    bleOnSync();
    return true;
}

static void bleHostTask(void* param) {
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void bleOnSync(void) {
    if (!s_bleAdvertiseRequested || !s_running) {
        ESP_LOGI(TAG, "BLE stack synced; provisioning advertising is idle");
        return;
    }

    int rc = ble_hs_id_infer_auto(0, &s_bleAddrType);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_hs_id_infer_auto failed: %d", rc);
        return;
    }

    struct ble_hs_adv_fields fields = {};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (const uint8_t*)s_deviceName;
    fields.name_len = strlen(s_deviceName);
    fields.name_is_complete = 1;
    ble_uuid16_t service_uuid = BLE_UUID16_INIT(UUID16_PROVISIONING_SERVICE);
    fields.uuids16 = &service_uuid;
    fields.num_uuids16 = 1;
    fields.uuids16_is_complete = 1;
    ble_gap_adv_set_fields(&fields);

    struct ble_gap_adv_params adv_params = {};
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(s_bleAddrType, NULL, BLE_HS_FOREVER, &adv_params, bleGapEvent, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGE(TAG, "ble_gap_adv_start failed: %d", rc);
    } else {
        ESP_LOGI(TAG, "BLE provisioning advertising as %s", s_deviceName);
    }
}

static int bleGapEvent(struct ble_gap_event* event, void* arg) {
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                s_statusConnHandle = event->connect.conn_handle;
                setStatus("ble_connected", "phone connected");
            } else {
                bleOnSync();
            }
            return 0;

        case BLE_GAP_EVENT_DISCONNECT:
            s_statusConnHandle = BLE_HS_CONN_HANDLE_NONE;
            if (s_running) {
                bleOnSync();
            }
            return 0;

        case BLE_GAP_EVENT_SUBSCRIBE:
            publishStatusNotify();
            return 0;

        default:
            return 0;
    }
}

static int bleGattAccess(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt* ctxt, void* arg) {
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        os_mbuf_append(ctxt->om, s_statusJson, strlen(s_statusJson));
        return 0;
    }

    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        char body[PROVISIONING_JSON_MAX_LEN] = {0};
        uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
        if (len >= sizeof(body)) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }

        int rc = ble_hs_mbuf_to_flat(ctxt->om, body, sizeof(body) - 1, &len);
        if (rc != 0) {
            return BLE_ATT_ERR_UNLIKELY;
        }
        body[len] = '\0';

        provisioning_request_t request;
        if (!parseProvisioningJson(body, &request)) {
            setStatus("invalid_payload", "ssid/password/bindToken required");
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }

        if (xQueueSend(s_requestQueue, &request, pdMS_TO_TICKS(100)) != pdTRUE) {
            setStatus("busy", "provisioning queue full");
            return BLE_ATT_ERR_INSUFFICIENT_RES;
        }

        setStatus("credentials_received", "connecting router");
        return 0;
    }

    return BLE_ATT_ERR_UNLIKELY;
}
#endif
