import { Registry } from 'prom-client';
import {
  DEFAULT_WS_CONNECTION_BUDGET,
  registerScaleOutGauges,
  resolveWsConnectionBudget,
} from './scale-out-metrics';

describe('resolveWsConnectionBudget', () => {
  it('接受合法的正整数', () => {
    expect(resolveWsConnectionBudget('1200')).toBe(1200);
  });

  it('向下取整，避免出现分数预算', () => {
    expect(resolveWsConnectionBudget('1200.9')).toBe(1200);
  });

  it.each([
    ['未设置', undefined],
    ['空字符串', ''],
    ['非数字', 'many'],
    ['零', '0'],
    ['负数', '-5'],
    ['null', null],
  ])('%s 时回落到默认值，而不是产生 NaN/Infinity', (_label, raw) => {
    expect(resolveWsConnectionBudget(raw)).toBe(DEFAULT_WS_CONNECTION_BUDGET);
  });

  it('默认值必须为正，否则 budget_ratio 会失去意义', () => {
    expect(DEFAULT_WS_CONNECTION_BUDGET).toBeGreaterThan(0);
  });
});

describe('registerScaleOutGauges', () => {
  const buildRegistry = (
    overrides: Partial<{
      stats: () => {
        totalClients: number;
        connectedUsers: number;
        connectedDevices: number;
      };
      mqttConnected: () => boolean;
      budget: number;
      onError: (error: unknown) => void;
    }> = {},
  ) => {
    const registry = new Registry();
    registerScaleOutGauges({
      registry,
      connectionStats:
        overrides.stats ??
        (() => ({
          totalClients: 40,
          connectedUsers: 25,
          connectedDevices: 15,
        })),
      mqttConnected: overrides.mqttConnected ?? (() => true),
      budget: overrides.budget ?? 100,
      onError: overrides.onError,
    });
    return registry;
  };

  it('抓取时拉取当前 WS 连接数并按 kind 打标', async () => {
    const output = await buildRegistry().metrics();

    expect(output).toContain('sleep_ws_connections{kind="clients"} 40');
    expect(output).toContain('sleep_ws_connections{kind="users"} 25');
    expect(output).toContain('sleep_ws_connections{kind="devices"} 15');
  });

  it('把 ADR-012 的连接预算换算成可告警的比值', async () => {
    const output = await buildRegistry().metrics();

    expect(output).toContain('sleep_ws_connection_budget_ratio 0.4');
    expect(output).toContain('sleep_ws_connection_budget 100');
  });

  it('每次抓取都重新读取，而不是缓存首次的值', async () => {
    let clients = 10;
    const registry = buildRegistry({
      stats: () => ({
        totalClients: clients,
        connectedUsers: 0,
        connectedDevices: 0,
      }),
    });

    await registry.metrics();
    clients = 90;
    const second = await registry.metrics();

    expect(second).toContain('sleep_ws_connections{kind="clients"} 90');
    expect(second).toContain('sleep_ws_connection_budget_ratio 0.9');
  });

  it('MQTT 断开时输出 0，便于 == 0 告警', async () => {
    const output = await buildRegistry({
      mqttConnected: () => false,
    }).metrics();

    expect(output).toContain('sleep_mqtt_connected 0');
  });

  it('单个 collect 回调抛错时，不能拖垮整个 /metrics 渲染', async () => {
    const onError = jest.fn();
    const registry = buildRegistry({
      stats: () => {
        throw new Error('gateway exploded');
      },
      onError,
    });

    // 关键断言：渲染不抛异常，其余指标依然可见。
    // 否则一个次要指标的故障会让所有指标一起消失。
    const output = await registry.metrics();

    expect(output).toContain('sleep_mqtt_connected 1');
    expect(onError).toHaveBeenCalled();
  });
});
