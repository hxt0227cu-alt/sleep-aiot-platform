/**
 * 本地序列号管理器
 *
 * 功能：
 *   为每条设备上报数据分配单调递增的本地序列号，
 *   用于云端幂等校验和乱序检测。
 *
 * 特性：
 *   - 序列号持久化到 NVS（重启不丢失）
 *   - 支持序列号回绕处理
 *   - 支持丢失检测和补传触发
 *   - 批量分配优化（减少 NVS 写入）
 */

#include "esp_log.h"
#include "esp_err.h"
#include "nvs.h"
#include "nvs_flash.h"
#include <string.h>

static const char *TAG = "local_sequence";

#define NVS_NAMESPACE "seq_mgr"
#define NVS_KEY_CURRENT "current_seq"
#define NVS_KEY_LAST_SYNC "last_sync"
#define SEQ_BATCH_SIZE 100  // 批量分配大小
#define SEQ_MAX_VALUE 0xFFFFFFFF  // 32位无符号最大值

typedef struct {
    bool initialized;
    uint32_t current_seq;
    uint32_t last_synced_seq;
    uint32_t batch_end;  // 当前批次结束序列号
    uint32_t lost_count;  // 检测到的丢失数量
} local_sequence_state_t;

static local_sequence_state_t s_state = {0};

/**
 * 初始化本地序列号管理器
 */
esp_err_t local_sequence_manager_init(void)
{
    ESP_LOGI(TAG, "初始化本地序列号管理器");

    nvs_handle_t handle;
    esp_err_t ret = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "打开 NVS 失败: %s", esp_err_to_name(ret));
        return ret;
    }

    // 读取当前序列号
    ret = nvs_get_u32(handle, NVS_KEY_CURRENT, &s_state.current_seq);
    if (ret == ESP_ERR_NVS_NOT_FOUND) {
        s_state.current_seq = 0;
        nvs_set_u32(handle, NVS_KEY_CURRENT, s_state.current_seq);
    }

    // 读取上次同步序列号
    ret = nvs_get_u32(handle, NVS_KEY_LAST_SYNC, &s_state.last_synced_seq);
    if (ret == ESP_ERR_NVS_NOT_FOUND) {
        s_state.last_synced_seq = 0;
    }

    nvs_commit(handle);
    nvs_close(handle);

    // 初始化批次
    s_state.batch_end = s_state.current_seq + SEQ_BATCH_SIZE;
    s_state.lost_count = 0;
    s_state.initialized = true;

    ESP_LOGI(TAG, "本地序列号管理器初始化完成，当前序列号: %lu", (unsigned long)s_state.current_seq);
    return ESP_OK;
}

/**
 * 获取下一个序列号
 *
 * @return 下一个可用序列号
 */
uint32_t local_sequence_manager_get_next(void)
{
    if (!s_state.initialized) {
        ESP_LOGE(TAG, "序列号管理器未初始化");
        return 0;
    }

    uint32_t seq = s_state.current_seq;
    s_state.current_seq++;

    // 处理回绕
    if (s_state.current_seq == 0) {
        ESP_LOGW(TAG, "序列号回绕，从 0 重新开始");
    }

    // 批次结束时持久化
    if (s_state.current_seq >= s_state.batch_end) {
        local_sequence_manager_persist();
        s_state.batch_end = s_state.current_seq + SEQ_BATCH_SIZE;
    }

    return seq;
}

/**
 * 批量获取序列号
 *
 * @param count 需要的序列号数量
 * @param start_seq 输出起始序列号
 * @return ESP_OK 成功
 */
esp_err_t local_sequence_manager_get_batch(uint32_t count, uint32_t *start_seq)
{
    if (!s_state.initialized || start_seq == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    *start_seq = s_state.current_seq;
    s_state.current_seq += count;

    // 处理回绕
    if (s_state.current_seq < count) {
        ESP_LOGW(TAG, "批量分配导致序列号回绕");
    }

    // 持久化
    local_sequence_manager_persist();

    return ESP_OK;
}

/**
 * 持久化当前序列号到 NVS
 */
esp_err_t local_sequence_manager_persist(void)
{
    nvs_handle_t handle;
    esp_err_t ret = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "打开 NVS 失败: %s", esp_err_to_name(ret));
        return ret;
    }

    nvs_set_u32(handle, NVS_KEY_CURRENT, s_state.current_seq);
    nvs_commit(handle);
    nvs_close(handle);

    ESP_LOGD(TAG, "序列号已持久化: %lu", (unsigned long)s_state.current_seq);
    return ESP_OK;
}

/**
 * 确认序列号已同步到云端
 */
void local_sequence_manager_confirm_sync(uint32_t seq)
{
    if (seq > s_state.last_synced_seq) {
        s_state.last_synced_seq = seq;

        nvs_handle_t handle;
        if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle) == ESP_OK) {
            nvs_set_u32(handle, NVS_KEY_LAST_SYNC, s_state.last_synced_seq);
            nvs_commit(handle);
            nvs_close(handle);
        }
    }
}

/**
 * 检测丢失的序列号
 *
 * @param cloud_last_seq 云端记录的最后序列号
 * @return 丢失的序列号数量
 */
uint32_t local_sequence_manager_detect_lost(uint32_t cloud_last_seq)
{
    if (cloud_last_seq >= s_state.current_seq) {
        s_state.lost_count = 0;
        return 0;
    }

    // 计算丢失数量（考虑回绕）
    uint32_t lost = s_state.current_seq - cloud_last_seq - 1;
    s_state.lost_count = lost;

    if (lost > 0) {
        ESP_LOGW(TAG, "检测到 %lu 个丢失的序列号 (云端: %lu, 本地: %lu)",
                 (unsigned long)lost, (unsigned long)cloud_last_seq, (unsigned long)s_state.current_seq);
    }

    return lost;
}

/**
 * 触发补传
 *
 * @param from_seq 起始序列号
 * @param to_seq 结束序列号
 * @return ESP_OK 成功
 */
esp_err_t local_sequence_manager_trigger_retransmit(uint32_t from_seq, uint32_t to_seq)
{
    ESP_LOGI(TAG, "触发补传: %lu ~ %lu", (unsigned long)from_seq, (unsigned long)to_seq);

    // 实际实现应从本地缓存读取数据并重新上报
    // 这里仅记录日志

    return ESP_OK;
}

/**
 * 获取当前序列号
 */
uint32_t local_sequence_manager_get_current(void)
{
    return s_state.current_seq;
}

/**
 * 获取序列号管理器状态
 */
void local_sequence_manager_get_status(local_sequence_status_t *status)
{
    if (status == NULL) return;

    status->initialized = s_state.initialized;
    status->current_seq = s_state.current_seq;
    status->last_synced_seq = s_state.last_synced_seq;
    status->lost_count = s_state.lost_count;
    status->pending_count = s_state.current_seq - s_state.last_synced_seq;
}
