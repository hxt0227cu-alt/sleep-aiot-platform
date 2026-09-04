import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MqttModule } from '../mqtt/mqtt.module';
import { INFRA_METRICS_SINK } from '../redis/contracts';
import { WebSocketModule } from '../websocket/websocket.module';
import { HealthService } from './health.service';
import { PrometheusInfraMetricsSink } from './infra-metrics.sink';
import { MetricsService } from './metrics.service';
import { ObservabilityController } from './observability.controller';
import { RequestMetricsInterceptor } from './request-metrics.interceptor';
import { ScaleOutMetricsRegistrar } from './scale-out-metrics';

/**
 * 依赖方向说明（ADR-019）：
 * observability -> mqtt / websocket 是**有意为之**的单向依赖。
 * 领域模块不反向依赖本模块，因此状态类指标全部由本模块在抓取时拉取。
 */
@Global()
@Module({
  imports: [MqttModule, WebSocketModule],
  controllers: [ObservabilityController],
  providers: [
    MetricsService,
    HealthService,
    ScaleOutMetricsRegistrar,
    PrometheusInfraMetricsSink,
    // 供 redis 模块（扇出 / 领导者锁）按接口令牌可选注入。
    { provide: INFRA_METRICS_SINK, useExisting: PrometheusInfraMetricsSink },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestMetricsInterceptor,
    },
  ],
  exports: [MetricsService, INFRA_METRICS_SINK],
})
export class ObservabilityModule {}
