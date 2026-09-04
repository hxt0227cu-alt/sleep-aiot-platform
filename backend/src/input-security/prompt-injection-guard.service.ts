import { Injectable, Logger } from '@nestjs/common';

/**
 * 提示词注入防护服务
 *
 * 基于规则+分类器双层检测，拦截越狱指令、系统提示覆盖、
 * 越权操作诱导等注入攻击。
 */
@Injectable()
export class PromptInjectionGuardService {
  private readonly logger = new Logger(PromptInjectionGuardService.name);

  /** 已知注入模式 */
  private readonly injectionPatterns: InjectionPattern[] = [
    // 系统提示覆盖
    {
      pattern:
        /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts|rules)/i,
      type: 'system_override',
      severity: 'high',
    },
    {
      pattern:
        /disregard\s+(all\s+)?(previous|above)\s+(instructions|prompts)/i,
      type: 'system_override',
      severity: 'high',
    },
    {
      pattern: /forget\s+(everything|all|your\s+instructions)/i,
      type: 'system_override',
      severity: 'high',
    },
    {
      pattern:
        /you\s+are\s+now\s+((a|an)\s+)?(DAN|AI|assistant|bot|system|developer)/i,
      type: 'role_hijack',
      severity: 'high',
    },
    {
      pattern: /new\s+(instructions|rules|persona|system\s+prompt)/i,
      type: 'system_override',
      severity: 'medium',
    },

    // 越权操作诱导
    {
      pattern: /(execute|run|call)\s+(system|shell|command|terminal|bash|cmd)/i,
      type: 'command_injection',
      severity: 'critical',
    },
    {
      pattern:
        /(execute|run|call)\s+(the\s+)?(following\s+)?(system|shell|terminal|bash|cmd)\s+command/i,
      type: 'command_injection',
      severity: 'critical',
    },
    {
      pattern:
        /(read|access|expose|reveal)\s+(system\s+prompt|initial\s+instructions|hidden\s+prompt)/i,
      type: 'prompt_leak',
      severity: 'high',
    },
    {
      pattern:
        /(bypass|override|disable|turn\s+off)\s+(your\s+|the\s+)?(safety|security|filter|guardrail|moderation)/i,
      type: 'safety_bypass',
      severity: 'critical',
    },

    // 数据泄露诱导
    {
      pattern:
        /(reveal|show|display|output)\s+(all|your|the)\s+(system|hidden|secret|private)\s+(prompt|instructions|rules)/i,
      type: 'prompt_leak',
      severity: 'high',
    },
    {
      pattern:
        /(print|echo|output)\s+(your|the)\s+((initial|system|full|entire)\s+){1,2}prompt/i,
      type: 'prompt_leak',
      severity: 'high',
    },

    // 多轮诱导
    {
      pattern:
        /in\s+(the\s+)?(next|following)\s+(message|turn|response|reply)/i,
      type: 'multi_turn_induction',
      severity: 'medium',
    },
    {
      pattern: /(pretend|act\s+as|roleplay|role\s+play)\s+(you\s+are|as\s+if)/i,
      type: 'role_hijack',
      severity: 'medium',
    },

    // 编码混淆
    {
      pattern: /base64\s*(decode|decrypt|interpret)/i,
      type: 'encoded_injection',
      severity: 'medium',
    },
    {
      pattern: /(hex|octal|binary|rot13)\s*(decode|decrypt)/i,
      type: 'encoded_injection',
      severity: 'medium',
    },

    // 越权设备控制
    {
      pattern:
        /(disable|turn\s+off|bypass)\s+(the\s+)?(safety\s+guard|device\s+guard|device\s+security\s+guard|security\s+guard|security\s+check)/i,
      type: 'device_guard_bypass',
      severity: 'critical',
    },
    {
      pattern:
        /(grant|give|elevate)\s+(admin|root|superuser|full)\s+(access|permission|privileges)/i,
      type: 'privilege_escalation',
      severity: 'critical',
    },
  ];

  /** 可疑关键词 */
  private readonly suspiciousKeywords = [
    'ignore previous',
    'disregard all',
    'forget everything',
    'you are now',
    'new instructions',
    'system prompt',
    'initial instructions',
    'hidden prompt',
    'bypass safety',
    'disable filter',
    'override security',
    'jailbreak',
    'DAN mode',
    'developer mode',
    'unrestricted',
    'no limits',
  ];

  /**
   * 检测提示词注入
   *
   * @param input 用户输入文本
   * @param context 上下文（可选，用于多轮检测）
   * @returns 检测结果
   */
  detect(
    input: string,
    context?: InjectionDetectionContext,
  ): InjectionDetectionResult {
    if (!input || input.trim().length === 0) {
      return { safe: true, threats: [], riskScore: 0 };
    }

    const threats: DetectedThreat[] = [];
    let riskScore = 0;

    // 1. 规则匹配
    for (const pattern of this.injectionPatterns) {
      if (pattern.pattern.test(input)) {
        threats.push({
          type: pattern.type,
          severity: pattern.severity,
          matchedPattern: pattern.pattern.source,
          description: this.getThreatDescription(pattern.type),
        });
        riskScore += this.getSeverityScore(pattern.severity);
      }
    }

    // 2. 关键词检测
    const lowerInput = input.toLowerCase();
    for (const keyword of this.suspiciousKeywords) {
      if (lowerInput.includes(keyword)) {
        const existing = threats.find((t) => t.type === 'suspicious_keyword');
        if (!existing) {
          threats.push({
            type: 'suspicious_keyword',
            severity: 'low',
            matchedPattern: keyword,
            description: `检测到可疑关键词: ${keyword}`,
          });
          riskScore += 10;
        }
      }
    }

    // 3. 多轮上下文检测
    if (
      context?.conversationHistory &&
      context.conversationHistory.length > 0
    ) {
      const multiTurnThreat = this.detectMultiTurnInduction(
        input,
        context.conversationHistory,
      );
      if (multiTurnThreat) {
        threats.push(multiTurnThreat);
        riskScore += this.getSeverityScore(multiTurnThreat.severity);
      }
    }

    // 4. 编码混淆检测
    const encodedThreat = this.detectEncodedInjection(input);
    if (encodedThreat) {
      threats.push(encodedThreat);
      riskScore += this.getSeverityScore(encodedThreat.severity);
    }

    // 仅当完全无威胁，或仅命中低危关键词且风险分低于阈值时视为安全
    const safe =
      threats.length === 0 ||
      (riskScore < 30 && threats.every((t) => t.severity === 'low'));

    if (!safe) {
      this.logger.warn(
        `提示词注入检测: riskScore=${riskScore}, threats=${threats.map((t) => t.type).join(',')}`,
      );
    }

    return {
      safe,
      threats,
      riskScore: Math.min(100, riskScore),
      action: this.determineAction(riskScore, threats),
    };
  }

  /**
   * 多轮诱导检测
   */
  private detectMultiTurnInduction(
    input: string,
    history: string[],
  ): DetectedThreat | null {
    const recentHistory = history.slice(-5).join(' ').toLowerCase();

    // 检测渐进式诱导
    if (
      recentHistory.includes("let's play") ||
      recentHistory.includes('hypothetical scenario')
    ) {
      if (
        input.toLowerCase().includes('now') ||
        input.toLowerCase().includes('in this scenario')
      ) {
        return {
          type: 'multi_turn_induction',
          severity: 'medium',
          matchedPattern: 'progressive_induction',
          description: '检测到多轮渐进式诱导攻击',
        };
      }
    }

    return null;
  }

  /**
   * 编码混淆检测
   */
  private detectEncodedInjection(input: string): DetectedThreat | null {
    // 检测 Base64 编码的可疑内容
    const base64Match = input.match(/[A-Za-z0-9+/]{40,}={0,2}/);
    if (base64Match) {
      try {
        const decoded = Buffer.from(base64Match[0], 'base64').toString('utf-8');
        if (
          decoded.includes('ignore') ||
          decoded.includes('system prompt') ||
          decoded.includes('bypass')
        ) {
          return {
            type: 'encoded_injection',
            severity: 'high',
            matchedPattern: 'base64_encoded_payload',
            description: '检测到 Base64 编码的注入载荷',
          };
        }
      } catch {
        // 解码失败，忽略
      }
    }
    return null;
  }

  /**
   * 获取威胁描述
   */
  private getThreatDescription(type: string): string {
    const descriptions: Record<string, string> = {
      system_override: '检测到系统提示覆盖尝试',
      role_hijack: '检测到角色劫持尝试',
      command_injection: '检测到命令注入尝试',
      prompt_leak: '检测到系统提示泄露诱导',
      safety_bypass: '检测到安全机制绕过尝试',
      multi_turn_induction: '检测到多轮诱导攻击',
      encoded_injection: '检测到编码混淆注入',
      device_guard_bypass: '检测到设备安全闸绕过尝试',
      privilege_escalation: '检测到权限提升尝试',
    };
    return descriptions[type] || `检测到 ${type} 类型威胁`;
  }

  /**
   * 获取严重程度分数
   */
  private getSeverityScore(severity: string): number {
    switch (severity) {
      case 'critical':
        return 50;
      case 'high':
        return 30;
      case 'medium':
        return 15;
      case 'low':
        return 5;
      default:
        return 10;
    }
  }

  /**
   * 确定应对措施
   */
  private determineAction(
    riskScore: number,
    threats: DetectedThreat[],
  ): InjectionAction {
    if (riskScore >= 70 || threats.some((t) => t.severity === 'critical')) {
      return 'block';
    }
    if (riskScore >= 40 || threats.some((t) => t.severity === 'high')) {
      return 'flag_and_warn';
    }
    if (riskScore >= 20) {
      return 'monitor';
    }
    return 'allow';
  }
}

/**
 * 注入模式
 */
interface InjectionPattern {
  pattern: RegExp;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * 检测到的威胁
 */
export interface DetectedThreat {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  matchedPattern: string;
  description: string;
}

/**
 * 注入检测结果
 */
export interface InjectionDetectionResult {
  safe: boolean;
  threats: DetectedThreat[];
  riskScore: number;
  action?: InjectionAction;
}

/**
 * 应对措施
 */
export type InjectionAction = 'allow' | 'monitor' | 'flag_and_warn' | 'block';

/**
 * 注入检测上下文
 */
export interface InjectionDetectionContext {
  conversationHistory?: string[];
  userId?: string;
  tenantId?: string;
  source?: 'app' | 'api' | 'ai' | 'voice';
}
