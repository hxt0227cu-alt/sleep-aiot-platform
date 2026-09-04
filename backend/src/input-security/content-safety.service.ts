import { Injectable, Logger } from '@nestjs/common';

/**
 * 内容安全服务
 *
 * 检测文本与语音识别结果中的违规内容、敏感信息，拦截有害输入。
 */
@Injectable()
export class ContentSafetyService {
  private readonly logger = new Logger(ContentSafetyService.name);

  /** 敏感个人信息模式 */
  private readonly piiPatterns: { pattern: RegExp; type: string }[] = [
    { pattern: /1[3-9]\d{9}/g, type: 'phone_number' },
    { pattern: /\d{17}[\dXx]/g, type: 'id_card' },
    { pattern: /\d{16,19}/g, type: 'bank_card' },
    { pattern: /[\w.-]+@[\w.-]+\.\w+/g, type: 'email' },
    { pattern: /\d{6}/g, type: 'verification_code' },
  ];

  /** 违规内容关键词 */
  private readonly violationKeywords: { keyword: string; category: string; severity: 'high' | 'medium' | 'low' }[] = [
    // 暴力恐怖
    { keyword: '自杀', category: 'violence', severity: 'high' },
    { keyword: '自残', category: 'violence', severity: 'high' },
    { keyword: '杀人', category: 'violence', severity: 'high' },
    { keyword: '炸弹', category: 'violence', severity: 'high' },
    // 色情
    { keyword: '色情', category: 'pornography', severity: 'high' },
    { keyword: '裸体', category: 'pornography', severity: 'medium' },
    // 毒品
    { keyword: '毒品', category: 'drugs', severity: 'high' },
    { keyword: '吸毒', category: 'drugs', severity: 'high' },
    // 赌博
    { keyword: '赌博', category: 'gambling', severity: 'medium' },
    // 诈骗
    { keyword: '诈骗', category: 'fraud', severity: 'high' },
    { keyword: '转账', category: 'fraud', severity: 'medium' },
    // 医疗建议（产品边界）
    { keyword: '诊断', category: 'medical_advice', severity: 'medium' },
    { keyword: '处方', category: 'medical_advice', severity: 'medium' },
    { keyword: '治疗', category: 'medical_advice', severity: 'low' },
    { keyword: '用药', category: 'medical_advice', severity: 'low' },
  ];

  /**
   * 检测内容安全
   *
   * @param content 待检测内容
   * @param options 检测选项
   * @returns 检测结果
   */
  detect(content: string, options?: ContentSafetyOptions): ContentSafetyResult {
    if (!content || content.trim().length === 0) {
      return { safe: true, violations: [], piiDetected: [], riskScore: 0, action: 'allow' };
    }

    const violations: ContentViolation[] = [];
    const piiDetected: PiiDetection[] = [];
    let riskScore = 0;

    // 1. PII 检测
    if (options?.detectPii !== false) {
      for (const pii of this.piiPatterns) {
        const matches = content.match(pii.pattern);
        if (matches) {
          for (const match of matches) {
            piiDetected.push({
              type: pii.type,
              value: this.maskPii(pii.type, match),
              originalLength: match.length,
            });
          }
          riskScore += 15;
        }
      }
    }

    // 2. 违规内容检测
    if (options?.detectViolation !== false) {
      const lowerContent = content.toLowerCase();
      for (const item of this.violationKeywords) {
        if (lowerContent.includes(item.keyword.toLowerCase())) {
          violations.push({
            category: item.category,
            keyword: item.keyword,
            severity: item.severity,
            description: this.getViolationDescription(item.category),
          });
          riskScore += item.severity === 'high' ? 40 : item.severity === 'medium' ? 20 : 10;
        }
      }
    }

    // 3. 医疗建议边界检测（产品定位为辅助工具，禁止诊断处方）
    if (options?.enforceProductBoundary !== false) {
      const medicalViolations = violations.filter((v) => v.category === 'medical_advice');
      if (medicalViolations.length > 0) {
        riskScore += 10; // 额外边界风险
      }
    }

    const safe = violations.length === 0 || riskScore < 30;

    if (!safe) {
      this.logger.warn(`内容安全检测: riskScore=${riskScore}, violations=${violations.map((v) => v.category).join(',')}, pii=${piiDetected.length}`);
    }

    return {
      safe,
      violations,
      piiDetected,
      riskScore: Math.min(100, riskScore),
      action: riskScore >= 60 ? 'block' : riskScore >= 30 ? 'flag' : 'allow',
      sanitizedContent: options?.autoSanitize ? this.sanitizeContent(content, piiDetected) : undefined,
    };
  }

  /**
   * 脱敏 PII 信息
   */
  maskPii(type: string, value: string): string {
    switch (type) {
      case 'phone_number':
        return value.slice(0, 3) + '****' + value.slice(-4);
      case 'id_card':
        return value.slice(0, 6) + '********' + value.slice(-4);
      case 'bank_card':
        return '**** **** **** ' + value.slice(-4);
      case 'email':
        const [name, domain] = value.split('@');
        return name.slice(0, 2) + '***@' + domain;
      case 'verification_code':
        return '******';
      default:
        return '***';
    }
  }

  /**
   * 清理内容中的 PII
   */
  sanitizeContent(content: string, piiList: PiiDetection[]): string {
    let sanitized = content;
    for (const pii of piiList) {
      // 简单替换（实际应使用正则精确匹配）
      sanitized = sanitized.replace(new RegExp(pii.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
    }
    return sanitized;
  }

  /**
   * 获取违规描述
   */
  private getViolationDescription(category: string): string {
    const descriptions: Record<string, string> = {
      violence: '检测到暴力相关内容',
      pornography: '检测到色情相关内容',
      drugs: '检测到毒品相关内容',
      gambling: '检测到赌博相关内容',
      fraud: '检测到诈骗相关内容',
      medical_advice: '检测到医疗诊断/处方相关内容（产品边界限制）',
    };
    return descriptions[category] || `检测到 ${category} 类违规内容`;
  }
}

/**
 * 内容安全检测选项
 */
export interface ContentSafetyOptions {
  /** 是否检测 PII（默认 true） */
  detectPii?: boolean;
  /** 是否检测违规内容（默认 true） */
  detectViolation?: boolean;
  /** 是否强制执行产品边界（默认 true） */
  enforceProductBoundary?: boolean;
  /** 是否自动脱敏（默认 false） */
  autoSanitize?: boolean;
}

/**
 * 内容安全检测结果
 */
export interface ContentSafetyResult {
  safe: boolean;
  violations: ContentViolation[];
  piiDetected: PiiDetection[];
  riskScore: number;
  action: 'allow' | 'flag' | 'block';
  sanitizedContent?: string;
}

/**
 * 内容违规
 */
export interface ContentViolation {
  category: string;
  keyword: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
}

/**
 * PII 检测
 */
export interface PiiDetection {
  type: string;
  value: string;
  originalLength: number;
}
