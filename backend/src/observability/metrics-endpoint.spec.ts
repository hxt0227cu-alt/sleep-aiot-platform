import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthService } from './health.service';
import { MetricsService } from './metrics.service';
import { ObservabilityController } from './observability.controller';
import { RequestMetricsInterceptor } from './request-metrics.interceptor';
import { registerScaleOutGauges } from './scale-out-metrics';

/**
 * 端到端证据（ADR-019）：证明"请求 -> 拦截器 -> 注册表 -> /metrics 端点"整条链路可用。
 *
 * 为什么这个测试有价值：指标类代码最典型的失败模式不是算错，而是
 * **根本没被调用**（拦截器没挂上、端点路径不对、注册表用错实例）。
 * 单测各个类都绿、线上却一条数据都没有。这里用真实 HTTP 往返来堵住这个缺口。
 *
 * 刻意不依赖 Postgres/Redis/MQTT：HealthService 用桩替换，
 * 因此本测试在本地与 CI 都会真实执行，不会被 skip 掉。
 */

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('boom')
  boom() {
    throw new Error('intentional failure');
  }
}

describe('/metrics 端点', () => {
  let app: INestApplication;
  let metrics: MetricsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ObservabilityController, ProbeController],
      providers: [
        MetricsService,
        {
          provide: HealthService,
          useValue: {
            liveness: () => ({
              status: 'ok',
              service: 'test',
              uptimeSeconds: 1,
            }),
            readiness: () => Promise.resolve({ status: 'ready', checks: {} }),
          },
        },
        { provide: APP_INTERCEPTOR, useClass: RequestMetricsInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    metrics = app.get(MetricsService);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('以 Prometheus 文本格式暴露指标', async () => {
    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('# HELP sleep_http_requests_total');
    expect(response.text).toContain('# TYPE sleep_http_requests_total counter');
  });

  it('真实请求后计数器确实增长，且 method/route/status_code 标签正确', async () => {
    await request(app.getHttpServer()).get('/probe/ok').expect(200);

    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(response.text).toMatch(
      /sleep_http_requests_total\{method="GET",route="\/probe\/ok",status_code="200"\} [1-9]\d*/,
    );
    expect(response.text).toContain(
      'sleep_http_request_duration_seconds_bucket{le="10",method="GET",route="/probe/ok",status_code="200"}',
    );
  });

  it('失败请求以 5xx 计入，使错误率告警有数据可用', async () => {
    await request(app.getHttpServer()).get('/probe/boom').expect(500);

    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(response.text).toMatch(
      /sleep_http_requests_total\{method="GET",route="\/probe\/boom",status_code="500"\} [1-9]\d*/,
    );
  });

  it('为每个请求分配 x-request-id，并透传调用方传入的值', async () => {
    const generated = await request(app.getHttpServer())
      .get('/probe/ok')
      .expect(200);
    expect(generated.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);

    const passthrough = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('x-request-id', 'trace-me-123')
      .expect(200);
    expect(passthrough.headers['x-request-id']).toBe('trace-me-123');
  });

  it('拉取式的扩容指标也能通过同一端点渲染', async () => {
    registerScaleOutGauges({
      registry: metrics.registry,
      connectionStats: () => ({
        totalClients: 12,
        connectedUsers: 7,
        connectedDevices: 5,
      }),
      mqttConnected: () => true,
      budget: 100,
    });

    const response = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(response.text).toContain('sleep_ws_connections{kind="clients"} 12');
    expect(response.text).toContain('sleep_ws_connection_budget_ratio 0.12');
    expect(response.text).toContain('sleep_mqtt_connected 1');
  });
});
