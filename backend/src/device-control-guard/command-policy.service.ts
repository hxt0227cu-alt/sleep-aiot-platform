import { Injectable, Logger } from '@nestjs/common';
import { CommandWhitelistEntry, CommandRiskLevel } from './dto/guard-command.dto';

/**
 * 指令策略服务
 *
 * 管理设备指令的安全策略，支持按租户、设备类型、用户角色
 * 配置不同的权限边界。
 */
@Injectable()
export class CommandPolicyService {
  private readonly logger = new Logger(CommandPolicyService.name);

  /** 默认指令白名单 */
  private readonly defaultWhitelist: CommandWhitelistEntry[] = [
    {
      command: 'light.set_brightness',
      riskLevel: CommandRiskLevel.MEDIUM,
      allowedParams: ['brightness', 'transition_ms'],
      paramConstraints: {
        brightness: { min: 0, max: 100, type: 'number' },
        transition_ms: { min: 0, max: 60000, type: 'number' },
      },
      requiresConfirmation: false,
      rateLimitPerMinute: 30,
      description: '设置灯光亮度',
    },
    {
      command: 'light.set_color_temp',
      riskLevel: CommandRiskLevel.MEDIUM,
      allowedParams: ['color_temp', 'transition_ms'],
      paramConstraints: {
        color_temp: { min: 2700, max: 6500, type: 'number' },
        transition_ms: { min: 0, max: 60000, type: 'number' },
      },
      requiresConfirmation: false,
      rateLimitPerMinute: 30,
      description: '设置灯光色温',
    },
    {
      command: 'light.set_power',
      riskLevel: CommandRiskLevel.LOW,
      allowedParams: ['power'],
      paramConstraints: { power: { enum: ['on', 'off'], type: 'string' } },
      requiresConfirmation: false,
      rateLimitPerMinute: 60,
      description: '灯光开关',
    },
    {
      command: 'light_alarm.create',
      riskLevel: CommandRiskLevel.MEDIUM,
      allowedParams: ['time', 'brightness_target', 'color_temp_target', 'duration_min', 'enabled'],
      paramConstraints: {
        duration_min: { min: 1, max: 120, type: 'number' },
        enabled: { enum: ['true', 'false'], type: 'string' },
      },
      requiresConfirmation: false,
      rateLimitPerMinute: 10,
      description: '创建灯光闹钟',
    },
    {
      command: 'light_alarm.delete',
      riskLevel: CommandRiskLevel.MEDIUM,
      allowedParams: ['alarm_id'],
      paramConstraints: {},
      requiresConfirmation: false,
      rateLimitPerMinute: 10,
      description: '删除灯光闹钟',
    },
    {
      command: 'ota.start_update',
      riskLevel: CommandRiskLevel.HIGH,
      allowedParams: ['firmware_version', 'firmware_url', 'signature'],
      paramConstraints: {},
      requiresConfirmation: true,
      rateLimitPerMinute: 2,
      description: '启动固件 OTA 升级',
    },
    {
      command: 'ota.cancel_update',
      riskLevel: CommandRiskLevel.MEDIUM,
      allowedParams: [],
      paramConstraints: {},
      requiresConfirmation: false,
      rateLimitPerMinute: 5,
      description: '取消 OTA 升级',
    },
    {
      command: 'device.factory_reset',
      riskLevel: CommandRiskLevel.CRITICAL,
      allowedParams: [],
      paramConstraints: {},
      requiresConfirmation: true,
      rateLimitPerMinute: 1,
      description: '设备工厂重置（不可逆）',
    },
    {
      command: 'device.reboot',
      riskLevel: CommandRiskLevel.MEDIUM,
      allowedParams: ['delay_seconds'],
      paramConstraints: { delay_seconds: { min: 0, max: 300, type: 'number' } },
      requiresConfirmation: false,
      rateLimitPerMinute: 3,
      description: '设备重启',
    },
    {
      command: 'alarm.update_threshold',
      riskLevel: CommandRiskLevel.HIGH,
      allowedParams: ['alarm_type', 'threshold_low', 'threshold_high', 'duration_seconds', 'enabled'],
      paramConstraints: {
        duration_seconds: { min: 0, max: 3600, type: 'number' },
      },
      requiresConfirmation: true,
      rateLimitPerMinute: 5,
      description: '更新报警阈值',
    },
    {
      command: 'voice.play_white_noise',
      riskLevel: CommandRiskLevel.LOW,
      allowedParams: ['noise_type', 'volume', 'duration_min'],
      paramConstraints: {
        volume: { min: 0, max: 100, type: 'number' },
        duration_min: { min: 1, max: 480, type: 'number' },
      },
      requiresConfirmation: false,
      rateLimitPerMinute: 10,
      description: '播放白噪音',
    },
    {
      command: 'voice.stop',
      riskLevel: CommandRiskLevel.LOW,
      allowedParams: [],
      paramConstraints: {},
      requiresConfirmation: false,
      rateLimitPerMinute: 20,
      description: '停止语音播放',
    },
    {
      command: 'device.get_status',
      riskLevel: CommandRiskLevel.LOW,
      allowedParams: [],
      paramConstraints: {},
      requiresConfirmation: false,
      rateLimitPerMinute: 120,
      description: '查询设备状态',
    },
    {
      command: 'device.sync_config',
      riskLevel: CommandRiskLevel.MEDIUM,
      allowedParams: ['config_key', 'config_value'],
      paramConstraints: {},
      requiresConfirmation: false,
      rateLimitPerMinute: 10,
      description: '同步设备配置',
    },
  ];

  /** 租户级策略覆盖 */
  private tenantOverrides: Map<string, Partial<CommandWhitelistEntry>[]> = new Map();

  /**
   * 获取指定设备类型和租户的指令白名单
   */
  getWhitelist(tenantId?: string, deviceType?: string): CommandWhitelistEntry[] {
    let list = [...this.defaultWhitelist];

    // 应用租户级覆盖
    if (tenantId && this.tenantOverrides.has(tenantId)) {
      const overrides = this.tenantOverrides.get(tenantId)!;
      list = list.map((entry) => {
        const override = overrides.find((o) => o.command === entry.command);
        return override ? { ...entry, ...override } : entry;
      });
    }

    // 设备类型过滤（某些指令仅适用于特定设备类型）
    if (deviceType) {
      list = list.filter((entry) => this.isCommandSupportedByDevice(entry.command, deviceType));
    }

    return list;
  }

  /**
   * 查找指定指令的白名单条目
   */
  findCommand(command: string, tenantId?: string, deviceType?: string): CommandWhitelistEntry | undefined {
    return this.getWhitelist(tenantId, deviceType).find((entry) => entry.command === command);
  }

  /**
   * 校验指令参数是否在允许范围内
   */
  validateParams(entry: CommandWhitelistEntry, params: Record<string, unknown>): { valid: boolean; invalidParam?: string; reason?: string } {
    for (const [key, value] of Object.entries(params)) {
      // 检查参数是否在允许列表中
      if (!entry.allowedParams.includes(key)) {
        return { valid: false, invalidParam: key, reason: `参数 ${key} 不在允许列表中` };
      }

      // 检查参数约束
      const constraint = entry.paramConstraints[key];
      if (constraint) {
        if (constraint.type === 'number') {
          const numValue = Number(value);
          if (isNaN(numValue)) {
            return { valid: false, invalidParam: key, reason: `参数 ${key} 必须为数字` };
          }
          if (constraint.min !== undefined && numValue < constraint.min) {
            return { valid: false, invalidParam: key, reason: `参数 ${key} 不能小于 ${constraint.min}` };
          }
          if (constraint.max !== undefined && numValue > constraint.max) {
            return { valid: false, invalidParam: key, reason: `参数 ${key} 不能大于 ${constraint.max}` };
          }
        }
        if (constraint.type === 'string' && constraint.enum) {
          if (!constraint.enum.includes(String(value))) {
            return { valid: false, invalidParam: key, reason: `参数 ${key} 必须为 ${constraint.enum.join('/')} 之一` };
          }
        }
      }
    }
    return { valid: true };
  }

  /**
   * 判断指令是否适用于指定设备类型
   */
  private isCommandSupportedByDevice(command: string, deviceType: string): boolean {
    const lightCommands = ['light.set_brightness', 'light.set_color_temp', 'light.set_power', 'light_alarm.create', 'light_alarm.delete'];
    const voiceCommands = ['voice.play_white_noise', 'voice.stop'];

    if (deviceType === 'sensor_only' && (lightCommands.includes(command) || voiceCommands.includes(command))) {
      return false;
    }
    if (deviceType === 'light_only' && voiceCommands.includes(command)) {
      return false;
    }
    return true;
  }

  /**
   * 设置租户级策略覆盖
   */
  setTenantOverride(tenantId: string, overrides: Partial<CommandWhitelistEntry>[]): void {
    this.tenantOverrides.set(tenantId, overrides);
    this.logger.log(`租户 ${tenantId} 指令策略已更新，共 ${overrides.length} 条覆盖`);
  }

  /**
   * 获取所有支持的指令列表
   */
  getAllCommands(): string[] {
    return this.defaultWhitelist.map((e) => e.command);
  }
}
