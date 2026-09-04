import {
  resolveBackendSubscriptions,
  BACKEND_OWNED_TOPICS,
  BACKEND_MUST_UNSUBSCRIBE,
  MQTT_SHARED_GROUP,
} from './mqtt-subscriptions';

describe('backend MQTT 订阅所有权（ADR-013）', () => {
  const subs = resolveBackendSubscriptions();

  it('所有 backend 自有主题都以共享订阅形式（$share/<group>/...）订阅', () => {
    expect(subs.length).toBe(BACKEND_OWNED_TOPICS.length);
    for (const s of subs) {
      expect(s.shared).toBe(`$share/${MQTT_SHARED_GROUP}/${s.raw}`);
    }
  });

  it('已退订 device/+/telemetry（该主题由 telemetry-ingest 独占，避免跨服务重复消费）', () => {
    const ownedRaws = subs.map((s) => s.raw);
    expect(ownedRaws).not.toContain('device/+/telemetry');
    expect(BACKEND_MUST_UNSUBSCRIBE).toContain('device/+/telemetry');
  });

  it('只消费上行响应与状态，不订阅自身发布的下行主题', () => {
    const ownedRaws = subs.map((s) => s.raw);
    expect(ownedRaws).not.toContain('device/+/command');
    expect(ownedRaws).not.toContain('device/+/ota/command');
    expect(ownedRaws).toContain('device/+/command/response');
    expect(ownedRaws).toContain('device/+/status');
    expect(ownedRaws).toContain('device/+/alarm');
    expect(ownedRaws).toContain('device/+/voice/query');
  });

  it('共享订阅组名稳定，便于在 EMQX 侧核对 consumer group', () => {
    expect(MQTT_SHARED_GROUP).toBe('sleep-backend');
  });
});
