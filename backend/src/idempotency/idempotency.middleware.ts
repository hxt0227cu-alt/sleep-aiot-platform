import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { IdempotencyService } from './idempotency.service';

/**
 * 幂等中间件
 *
 * 对设备上报接口自动执行幂等校验。
 * 从请求头或请求体中提取 deviceId 和 localSequence，
 * 如果事件已处理则直接返回缓存结果，避免重复处理。
 */
@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(IdempotencyMiddleware.name);

  /** 需要幂等校验的路径前缀 */
  private readonly IDEMPOTENT_PATHS = [
    '/api/device/data',
    '/api/sleep/data',
    '/api/alarm/event',
    '/api/telemetry',
  ];

  constructor(private readonly idempotencyService: IdempotencyService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // 检查是否需要幂等校验
    if (!this.requiresIdempotency(req.path)) {
      next();
      return;
    }

    // 提取设备 ID 和序列号
    const deviceId = this.extractDeviceId(req);
    const localSequence = this.extractLocalSequence(req);

    if (!deviceId || localSequence === undefined) {
      this.logger.debug(`幂等中间件: 缺少 deviceId 或 localSequence，跳过校验`);
      next();
      return;
    }

    // 检查是否已处理
    const isProcessed = await this.idempotencyService.isProcessed(
      deviceId,
      localSequence,
    );

    if (isProcessed) {
      this.logger.debug(
        `幂等中间件: 重复请求，device=${deviceId}, seq=${localSequence}`,
      );
      res.status(200).json({
        success: true,
        idempotent: true,
        message: '请求已处理，返回缓存结果',
        deviceId,
        localSequence,
      });
      return;
    }

    // 标记为处理中（防止并发重复）
    await this.idempotencyService.markProcessed(
      deviceId,
      localSequence,
      'processing',
    );

    // 捕获响应，在响应完成后标记处理结果
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      // 处理完成后更新结果
      this.idempotencyService
        .markProcessed(deviceId, localSequence, JSON.stringify(body))
        .catch((err) => {
          this.logger.warn(`幂等结果更新失败: ${err.message}`);
        });
      return originalJson(body);
    };

    next();
  }

  /**
   * 检查路径是否需要幂等校验
   */
  private requiresIdempotency(path: string): boolean {
    return this.IDEMPOTENT_PATHS.some((p) => path.startsWith(p));
  }

  /**
   * 从请求中提取设备 ID
   */
  private extractDeviceId(req: Request): string | null {
    return (
      (req.headers['x-device-id'] as string) ||
      req.body?.deviceId ||
      (req.query?.deviceId as string) ||
      null
    );
  }

  /**
   * 从请求中提取本地序列号
   */
  private extractLocalSequence(req: Request): number | undefined {
    const seq =
      req.headers['x-local-sequence'] ||
      req.body?.localSequence ||
      req.query?.localSequence;

    if (seq === undefined || seq === null) return undefined;
    const num = Number(seq);
    return isNaN(num) ? undefined : num;
  }
}
