import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Gauge, Registry } from 'prom-client';
import { MetricsService } from './metrics.service';
import { MqttService } from '../mqtt/mqtt.service';
import { WebSocketService } from '../websocket/websocket.service';

/**
 * 横向扩展基础设施的"状态量"指标（ADR-019）。
 *
 * 设计取舍 —— 为什么用拉取而不是推送：
 *
 * WS 连接数、MQTT 连接状态都是**当前状态**，不是事件。若采用推送式
 * （领域服务注入 MetricsService 并在每次变化时 set），会让 websocket /
 * mqtt 模块反向依赖 observability 模块，破坏依赖方向，也需要改动它们的
 * 构造函数与既有单测。
 *
 * 这里改为在抓取时回调拉取：observability 依赖领域服务（方向正确），
 * 领域服务完全不知道指标的存在。代价是采样精度只到抓取周期（30s），
 * 对于容量类指标这是可接受的——我们关心的是趋势和阈值，不是瞬时毛刺。
 *
 * 事件类指标（扇出发布/接收、抢锁结果）无法拉取，仍走推送，见
 * MetricsService 中的 Counter 与 realtime-fanout / leader-lock 的可选注入。
 */

/** 单副本 WebSocket 连接预算的默认值（ADR-012 连接预算公式的落地默认）。 */
export const DEFAULT_WS_CONNECTION_BUDGET = 5000;

/**
 * 解析单副本连接预算。非法或缺省值一律回落到默认，
 * 避免因为一个拼错的环境变量把 budget_ratio 变成 Infinity 或 NaN，
 * 进而让容量告警永远不触发（静默失效比报错更危险）。
 */
export function resolveWsConnectionBudget(raw?: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WS_CONNECTION_BUDGET;
  }
  return Math.floor(parsed);
}

export interface ScaleOutMetricSources {
  registry: Registry;
  connectionStats: () => {
    totalClients: number;
    connectedUsers: number;
    connectedDevices: number;
  };
  mqttConnected: () => boolean;
  budget: number;
  onError?: (error: unknown) => void;
}

/**
 * 注册拉取式 Gauge。抽成纯函数以便脱离 Nest DI 直接单测。
 *
 * 重要：任何 collect 回调抛异常都会让**整个 /metrics 端点 500**，
 * 即一个次要指标的故障会导致全部指标不可见。因此每个回调都必须自包含兜底。
 */
export function registerScaleOutGauges(sources: ScaleOutMetricSources): void {
  const { registry, connectionStats, mqttConnected, budget, onError } = sources;

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      onError?.(error);
    }
  };

  const wsConnections = new Gauge({
    name: 'sleep_ws_connections',
    help: 'WebSocket connections terminated on this replica, by kind',
    labelNames: ['kind'] as const,
    registers: [registry],
    collect() {
      guard(() => {
        const stats = connectionStats();
        wsConnections.set({ kind: 'clients' }, stats.totalClients);
        wsConnections.set({ kind: 'users' }, stats.connectedUsers);
        wsConnections.set({ kind: 'devices' }, stats.connectedDevices);
      });
    },
  });

  const budgetRatio = new Gauge({
    name: 'sleep_ws_connection_budget_ratio',
    help: 'WebSocket connections on this replica as a fraction of the per-replica budget',
    registers: [registry],
    collect() {
      guard(() => {
        const stats = connectionStats();
        budgetRatio.set(stats.totalClients / budget);
      });
    },
  });

  const budgetGauge = new Gauge({
    name: 'sleep_ws_connection_budget',
    help: 'Configured per-replica WebSocket connection budget',
    registers: [registry],
  });
  budgetGauge.set(budget);

  const mqttUp = new Gauge({
    name: 'sleep_mqtt_connected',
    help: 'MQTT broker connection state for this replica, where 1 is connected',
    registers: [registry],
    collect() {
      guard(() => {
        mqttUp.set(mqttConnected() ? 1 : 0);
      });
    },
  });
}

@Injectable()
export class ScaleOutMetricsRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ScaleOutMetricsRegistrar.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly websocket: WebSocketService,
    private readonly mqtt: MqttService,
  ) {}

  onModuleInit(): void {
    // 幂等保护：重复注册同名指标会让 prom-client 抛错并拖垮启动。
    if (this.metrics.registry.getSingleMetric('sleep_ws_connections')) {
      return;
    }

    registerScaleOutGauges({
      registry: this.metrics.registry,
      connectionStats: () => this.websocket.getConnectionStats(),
      mqttConnected: () => this.mqtt.isConnected(),
      budget: resolveWsConnectionBudget(
        process.env.WS_MAX_CONNECTIONS_PER_REPLICA,
      ),
      onError: (error) =>
        this.logger.warn(
          `Scale-out metric collection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    });
  }
}
