import { Injectable, Logger } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Saga 编排服务
 *
 * 实现跨服务分布式事务补偿，保障设备解绑、数据删除等
 * 长链路操作的数据一致性。
 *
 * 采用编排式 Saga 模式：由本服务协调各步骤的执行与补偿。
 */
@Injectable()
export class SagaOrchestratorService {
  private readonly logger = new Logger(SagaOrchestratorService.name);

  /** 运行中的 Saga 实例 */
  private runningSagas: Map<string, SagaInstance> = new Map();

  constructor(private readonly outboxService: OutboxService) {}

  /**
   * 执行 Saga 事务
   *
   * @param definition Saga 定义
   * @param context 事务上下文
   * @returns Saga 执行结果
   */
  async execute<T>(
    definition: SagaDefinition<T>,
    context: T,
  ): Promise<SagaResult<T>> {
    const sagaId = `saga-${definition.name}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const startTime = Date.now();

    this.logger.log(`Saga 开始: ${sagaId}, type=${definition.name}`);

    const instance: SagaInstance = {
      id: sagaId,
      name: definition.name,
      status: 'running',
      currentStep: 0,
      context,
      executedSteps: [],
      startTime: new Date().toISOString(),
      error: null,
    };

    this.runningSagas.set(sagaId, instance);

    try {
      // 依次执行每个步骤
      for (let i = 0; i < definition.steps.length; i++) {
        const step = definition.steps[i];
        instance.currentStep = i;

        this.logger.debug(`Saga 步骤执行: ${sagaId}, step=${step.name}`);

        try {
          // 执行步骤
          const stepResult = await step.execute(context);

          instance.executedSteps.push({
            stepIndex: i,
            name: step.name,
            completedAt: new Date().toISOString(),
            result: stepResult,
          });
        } catch (stepError) {
          this.logger.error(
            `Saga 步骤失败: ${sagaId}, step=${step.name}, error=${stepError.message}`,
          );

          // 执行补偿（回滚已执行的步骤）
          instance.status = 'compensating';
          await this.compensate(instance, definition);

          instance.status = 'failed';
          instance.error = stepError.message;
          instance.endTime = new Date().toISOString();

          this.logger.error(`Saga 失败: ${sagaId}, error=${stepError.message}`);

          return {
            success: false,
            sagaId,
            name: definition.name,
            context,
            error: stepError.message,
            compensatedSteps: instance.executedSteps.length,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // 所有步骤成功
      instance.status = 'completed';
      instance.endTime = new Date().toISOString();

      this.logger.log(
        `Saga 完成: ${sagaId}, steps=${definition.steps.length}, duration=${Date.now() - startTime}ms`,
      );

      return {
        success: true,
        sagaId,
        name: definition.name,
        context,
        completedSteps: definition.steps.length,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // 清理运行中的实例（保留一段时间用于查询）
      setTimeout(() => {
        this.runningSagas.delete(sagaId);
      }, 3600000); // 1 小时后清理
    }
  }

  /**
   * 执行补偿（回滚）
   */
  private async compensate(
    instance: SagaInstance,
    definition: SagaDefinition<unknown>,
  ): Promise<void> {
    this.logger.warn(
      `Saga 补偿开始: ${instance.id}, steps_to_compensate=${instance.executedSteps.length}`,
    );

    // 逆序执行补偿
    for (let i = instance.executedSteps.length - 1; i >= 0; i--) {
      const executedStep = instance.executedSteps[i];
      const stepDefinition = definition.steps[executedStep.stepIndex];

      if (stepDefinition.compensate) {
        try {
          this.logger.debug(
            `Saga 补偿步骤: ${instance.id}, step=${stepDefinition.name}`,
          );
          await stepDefinition.compensate(
            instance.context,
            executedStep.result,
          );
        } catch (compError) {
          // 补偿失败需要记录，但继续尝试其他补偿
          this.logger.error(
            `Saga 补偿步骤失败: ${instance.id}, step=${stepDefinition.name}, error=${compError.message}`,
          );
          // 补偿失败需要记录，用于人工介入
          await this.outboxService
            .enqueue({
              aggregateType: 'saga',
              aggregateId: instance.id,
              eventType: 'saga_compensation_failed',
              tenantId: (instance.context as { tenantId?: string } | undefined)
                ?.tenantId,
              payload: {
                sagaId: instance.id,
                stepName: stepDefinition.name,
                error: compError.message,
                context: JSON.stringify(instance.context),
              },
            })
            .catch(() => {});
        }
      }
    }

    this.logger.warn(`Saga 补偿完成: ${instance.id}`);
  }

  /**
   * 获取 Saga 实例状态
   */
  getSagaStatus(sagaId: string): SagaInstance | null {
    return this.runningSagas.get(sagaId) || null;
  }

  /**
   * 列出运行中的 Saga
   */
  listRunningSagas(): Array<{
    id: string;
    name: string;
    status: string;
    currentStep: number;
    startTime: string;
  }> {
    return Array.from(this.runningSagas.values())
      .filter((s) => s.status === 'running' || s.status === 'compensating')
      .map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        currentStep: s.currentStep,
        startTime: s.startTime,
      }));
  }

  /**
   * 创建设备解绑 Saga 定义
   */
  createDeviceUnbindSaga(): SagaDefinition<DeviceUnbindContext> {
    return {
      name: 'device_unbind',
      steps: [
        {
          name: 'validate_device_ownership',
          execute: async (ctx) => {
            this.logger.debug(
              `验证设备归属: device=${ctx.deviceId}, user=${ctx.userId}`,
            );
            // 实际应调用 DeviceService 验证
            return { validated: true };
          },
          compensate: async () => {
            // 验证步骤无需补偿
          },
        },
        {
          name: 'revoke_device_cert',
          execute: async (ctx) => {
            this.logger.debug(`吊销设备证书: device=${ctx.deviceId}`);
            // 实际应调用 DeviceCertService
            return { revoked: true, serialNumber: ctx.certSerialNumber };
          },
          compensate: async (ctx, result) => {
            this.logger.warn(`恢复设备证书: device=${ctx.deviceId}`);
            // 实际应重新签发证书
          },
        },
        {
          name: 'clear_device_data',
          execute: async (ctx) => {
            this.logger.debug(`清除设备关联数据: device=${ctx.deviceId}`);
            // 实际应调用数据清理服务
            return { cleared: true };
          },
          compensate: async (ctx) => {
            this.logger.warn(`恢复设备数据: device=${ctx.deviceId}`);
            // 实际应从备份恢复
          },
        },
        {
          name: 'remove_user_binding',
          execute: async (ctx) => {
            this.logger.debug(
              `解除用户绑定: device=${ctx.deviceId}, user=${ctx.userId}`,
            );
            // 实际应调用 DeviceService
            return { unbound: true };
          },
          compensate: async (ctx) => {
            this.logger.warn(
              `恢复用户绑定: device=${ctx.deviceId}, user=${ctx.userId}`,
            );
            // 实际应重新绑定
          },
        },
        {
          name: 'notify_device',
          execute: async (ctx) => {
            this.logger.debug(`通知设备解绑: device=${ctx.deviceId}`);
            // 实际应通过 MQTT 通知设备
            return { notified: true };
          },
          compensate: async () => {
            // 通知步骤无需补偿
          },
        },
      ],
    };
  }

  /**
   * 创建用户数据删除 Saga 定义
   */
  createUserDataDeletionSaga(): SagaDefinition<UserDataDeletionContext> {
    return {
      name: 'user_data_deletion',
      steps: [
        {
          name: 'validate_deletion_request',
          execute: async (ctx) => {
            this.logger.debug(`验证删除请求: user=${ctx.userId}`);
            return { validated: true };
          },
        },
        {
          name: 'backup_user_data',
          execute: async (ctx) => {
            this.logger.debug(`备份用户数据: user=${ctx.userId}`);
            // 实际应创建数据备份快照
            return { backupId: `backup-${ctx.userId}-${Date.now()}` };
          },
          compensate: async (ctx, result) => {
            const backupId = (result as { backupId?: string } | undefined)
              ?.backupId;
            this.logger.warn(`删除备份: backup=${backupId}`);
            // 实际应删除备份
          },
        },
        {
          name: 'delete_sleep_data',
          execute: async (ctx) => {
            this.logger.debug(`删除睡眠数据: user=${ctx.userId}`);
            return { deleted: true };
          },
          compensate: async (ctx, result) => {
            this.logger.warn(`恢复睡眠数据: user=${ctx.userId}`);
          },
        },
        {
          name: 'delete_alarm_data',
          execute: async (ctx) => {
            this.logger.debug(`删除报警数据: user=${ctx.userId}`);
            return { deleted: true };
          },
          compensate: async (ctx) => {
            this.logger.warn(`恢复报警数据: user=${ctx.userId}`);
          },
        },
        {
          name: 'unbind_all_devices',
          execute: async (ctx) => {
            this.logger.debug(`解绑所有设备: user=${ctx.userId}`);
            return { unbound: true };
          },
          compensate: async (ctx) => {
            this.logger.warn(`恢复设备绑定: user=${ctx.userId}`);
          },
        },
        {
          name: 'delete_user_account',
          execute: async (ctx) => {
            this.logger.debug(`删除用户账号: user=${ctx.userId}`);
            return { deleted: true };
          },
          compensate: async (ctx) => {
            this.logger.warn(`恢复用户账号: user=${ctx.userId}`);
          },
        },
      ],
    };
  }
}

/**
 * Saga 定义
 */
export interface SagaDefinition<T> {
  name: string;
  steps: Array<SagaStep<T>>;
}

/**
 * Saga 步骤
 */
export interface SagaStep<T> {
  name: string;
  execute: (context: T) => Promise<unknown>;
  compensate?: (context: T, result?: unknown) => Promise<void>;
}

/**
 * Saga 实例
 */
export interface SagaInstance {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'compensating';
  currentStep: number;
  context: unknown;
  executedSteps: Array<{
    stepIndex: number;
    name: string;
    completedAt: string;
    result: unknown;
  }>;
  startTime: string;
  endTime?: string;
  error: string | null;
}

/**
 * Saga 执行结果
 */
export interface SagaResult<T> {
  success: boolean;
  sagaId: string;
  name: string;
  context: T;
  error?: string;
  completedSteps?: number;
  compensatedSteps?: number;
  durationMs: number;
}

/**
 * 设备解绑上下文
 */
export interface DeviceUnbindContext {
  deviceId: string;
  userId: string;
  tenantId?: string;
  certSerialNumber?: string;
  reason?: string;
}

/**
 * 用户数据删除上下文
 */
export interface UserDataDeletionContext {
  userId: string;
  tenantId?: string;
  reason?: string;
  requestedBy?: string;
}
