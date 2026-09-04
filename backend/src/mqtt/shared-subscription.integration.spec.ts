import * as mqtt from 'mqtt';

/**
 * MQTT 共享订阅去重的"真实"验证（ADR-013）。
 *
 * 之前的 mqtt-shared-subscription.spec.ts 只验证了订阅规划（字符串层面的
 * $share 命名与退订矩阵），并未在真实 broker 上证明"同组内多副本不会重复消费"。
 * 本测试在 MQTT_URL 可用时，用两个 mqtt 客户端模拟两个 backend 副本，
 * 同属 $share/sleep-backend 组订阅同一主题，发布 N 条消息，断言每条消息
 * 仅被其中一个副本收到（无重复消费）——即 ADR-013 的核心主张。
 *
 * 若 broker 不可达（如本地未起 EMQX），测试以 this.skip() 优雅跳过，
 * 避免未就绪的基础设施拖垮 CI。
 */

const MQTT_URL = process.env.MQTT_URL;
const describeOrSkip = MQTT_URL ? describe : describe.skip;

function connect(url: string): Promise<mqtt.MqttClient> {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(url, { connectTimeout: 15000, reconnectPeriod: 0 });
    c.on('connect', () => resolve(c));
    c.on('error', reject);
  });
}

function close(client: mqtt.MqttClient): Promise<void> {
  return new Promise((resolve, reject) =>
    client.end(true, {}, (error) => (error ? reject(error) : resolve())),
  );
}

describeOrSkip('MQTT 共享订阅去重（真实 broker）', () => {
  it('同 $share 组内多副本，每条消息仅被一个副本消费', async function (this: any) {
    let subA: mqtt.MqttClient;
    let subB: mqtt.MqttClient;
    let pub: mqtt.MqttClient;
    try {
      [subA, subB, pub] = await Promise.all([
        connect(MQTT_URL!),
        connect(MQTT_URL!),
        connect(MQTT_URL!),
      ]);
    } catch {
      this.skip();
      return;
    }

    const testId = Date.now();
    const topic = `$share/sleep-backend/test/dedup/${testId}`;
    const publishTopic = `test/dedup/${testId}`;

    const received = new Map<string, number>();
    let resolveDone: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const onMsg = (buf: Buffer) => {
      const id = buf.toString();
      received.set(id, (received.get(id) || 0) + 1);
      if (received.size >= 10) resolveDone();
    };
    subA.on('message', (_t: string, m: Buffer) => onMsg(m));
    subB.on('message', (_t: string, m: Buffer) => onMsg(m));

    await Promise.all([
      new Promise<void>((res, rej) =>
        subA.subscribe(topic, { qos: 1 }, (e) => (e ? rej(e) : res())),
      ),
      new Promise<void>((res, rej) =>
        subB.subscribe(topic, { qos: 1 }, (e) => (e ? rej(e) : res())),
      ),
    ]);

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((res, rej) =>
        pub.publish(publishTopic, `m${i}`, { qos: 1 }, (e) =>
          e ? rej(e) : res(),
        ),
      );
    }

    try {
      await Promise.race([
        done,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error('超时未收齐消息')), 8000),
        ),
      ]);
    } finally {
      await Promise.all([close(subA), close(subB), close(pub)]);
    }

    // 核心断言：每条消息恰好被一个副本收到（无跨副本重复消费）
    for (const count of received.values()) {
      expect(count).toBe(1);
    }
    expect(received.size).toBe(10);
  });
});
