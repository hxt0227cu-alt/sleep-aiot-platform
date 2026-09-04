/**
 * backend 的 MQTT 订阅所有权规划（ADR-013）。
 *
 * 核心约束：telemetry-ingest 服务已通过
 *   `$share/telemetry-ingest/device/+/telemetry`
 * 独占了设备遥测写入路径。backend 若再裸订阅 `device/+/telemetry` 会造成跨服务
 * 重复消费（同一消息被两个服务各处理一次，且 backend 没有对应的落库逻辑，纯属
 * 噪音与资源浪费）。因此 backend 必须从订阅清单中剔除该主题。
 *
 * 其余主题 backend 通过 EMQX **共享订阅**（`$share/<group>/<topic>`）消费：
 * 同一 group 内的多个 backend 副本只有一个会收到某条消息，天然避免了副本间重复。
 * 代价：同一 device 的消息顺序不再跨副本保证，因此设备状态必须以"按来源时间戳
 * 的 last-write-wins"为准（与 ADR-013 一致）。
 */

export const MQTT_SHARED_GROUP = 'sleep-backend';

/** backend 拥有（并应以共享订阅方式消费）的主题。注意：不含 device/+/telemetry。 */
export const BACKEND_OWNED_TOPICS: readonly string[] = [
  'sleep/+/data',
  'sleep/+/state',
  'sleep/+/report',
  'device/+/status',
  'device/+/alarm',
  'device/+/log',
  'device/+/command/response',
  'device/+/ota/progress',
  'device/+/voice/query',
];

/** telemetry-ingest 独占、backend 必须退订的主题。 */
export const BACKEND_MUST_UNSUBSCRIBE: readonly string[] = [
  'device/+/telemetry',
  'device/+/command',
  'device/+/ota/command',
];

export interface BackendSubscription {
  /** 原始主题（用于日志/对照） */
  raw: string;
  /** 实际订阅的共享订阅形式 */
  shared: string;
}

/**
 * 解析 backend 应订阅的主题清单（共享订阅形式）。
 * 纯函数，便于单测断言所有权矩阵。
 */
export function resolveBackendSubscriptions(): BackendSubscription[] {
  return BACKEND_OWNED_TOPICS.map((raw) => ({
    raw,
    shared: `$share/${MQTT_SHARED_GROUP}/${raw}`,
  }));
}
