import {
  Controller,
  INestApplication,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';

/**
 * 这个 spec 验证的是 ADR-012/生产就绪评估里发现的一个"假门禁"：
 * backend 在 auth.module 里注册了 ThrottlerModule.forRoot，并在 auth.controller
 * 的各路由上写了 @Throttle(...)，但 @nestjs/throttler v6 的 forRoot 不会自动把
 * ThrottlerGuard 挂成全局/路由守卫——所以那些 @Throttle 装饰器从未被强制执行，
 * 登录接口实际无限流。
 *
 * 修复方式（见 auth.controller.ts）：在 AuthController 类上加 @UseGuards(ThrottlerGuard)。
 * 本测试用一个完全同构的探针控制器证明：一旦守卫被挂载，@Throttle 限制就真实生效，
 * 超额请求返回 429。
 */
@Controller('throttle-probe')
@UseGuards(ThrottlerGuard)
class ProbeController {
  @Post('login')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  login(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 3 }])],
  controllers: [ProbeController],
})
class ProbeModule {}

describe('ThrottlerGuard 真实挂载后强制限流', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('同一客户端超出 @Throttle 上限后返回 429', async () => {
    const http = request(app.getHttpServer());
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await http.post('/throttle-probe/login').send({});
      statuses.push(res.status);
    }

    // 前 3 次成功（POST 默认 201），第 4 次被限流
    expect(statuses.slice(0, 3).every((s) => s < 400)).toBe(true);
    expect(statuses[3]).toBe(429);
  });
});
