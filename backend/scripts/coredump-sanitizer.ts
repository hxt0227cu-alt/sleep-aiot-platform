/**
 * Core Dump 脱敏校验脚本
 *
 * 功能：
 *   接收设备上传的故障转储时自动扫描敏感字段，
 *   过滤私钥、Token、原始健康数据、语音片段等敏感内容后再存储。
 *
 * 使用：
 *   npx ts-node scripts/coredump-sanitizer.ts <input-file> <output-file>
 *
 * 敏感字段类型：
 *   - 私钥材料（ECDSA/RSA private keys）
 *   - 认证 Token（JWT、API Key、Session ID）
 *   - 原始健康数据（心率/呼吸原始波形）
 *   - 语音片段（PCM/音频数据）
 *   - WiFi 凭据（SSID/密码）
 *   - 证书私钥
 *   - 个人身份信息
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// 配置
// ============================================================

interface SanitizerConfig {
  // 敏感字段正则模式
  patterns: Array<{
    name: string;
    pattern: RegExp;
    replacement: string | ((match: string, ...args: string[]) => string);
    severity: 'critical' | 'high' | 'medium' | 'low';
  }>;
  // 二进制敏感区域标记
  binaryMarkers: Array<{
    name: string;
    marker: Buffer;
    maxSize: number; // 该区域最大保留大小（字节），超出则截断
  }>;
  // 输出选项
  output: {
    preserveStructure: boolean;
    addSanitizationLog: boolean;
    hashOriginal: boolean;
  };
}

const DEFAULT_CONFIG: SanitizerConfig = {
  patterns: [
    // 私钥 PEM 格式
    {
      name: 'private_key_pem',
      pattern: /-----BEGIN (EC |RSA |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (EC |RSA |DSA |OPENSSH )?PRIVATE KEY-----/g,
      replacement: '[REDACTED: PRIVATE KEY]',
      severity: 'critical',
    },
    // eFuse 密钥区域标记
    {
      name: 'efuse_key_data',
      pattern: /EFUSE_KEY_BLOCK_\d+[\s\S]{0,512}/g,
      replacement: '[REDACTED: EFUSE KEY DATA]',
      severity: 'critical',
    },
    // JWT Token
    {
      name: 'jwt_token',
      pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      replacement: '[REDACTED: JWT TOKEN]',
      severity: 'high',
    },
    // API Key / Bearer Token
    {
      name: 'api_key',
      pattern: /(api[_-]?key|bearer|authorization|token|secret)["'\s:=]+([A-Za-z0-9_\-]{20,})/gi,
      replacement: '$1: [REDACTED]',
      severity: 'high',
    },
    // WiFi 密码
    {
      name: 'wifi_password',
      pattern: /(wifi[_-]?password|psk|wpa[_-]?key)["'\s:=]+([^\s"',}]{8,})/gi,
      replacement: '$1: [REDACTED: WIFI PASSWORD]',
      severity: 'high',
    },
    // WiFi SSID（保留前2字符）
    {
      name: 'wifi_ssid',
      pattern: /(ssid|wifi[_-]?name)["'\s:=]+"([^"]{4,})"/gi,
      replacement: (match: string, key: string, ssid: string) => {
        const masked = ssid.substring(0, 2) + '****' + (ssid.length > 4 ? ssid.substring(ssid.length - 2) : '');
        return `${key}: "${masked}"`;
      },
      severity: 'medium',
    },
    // 原始健康数据数组（心率/呼吸波形）
    {
      name: 'raw_health_waveform',
      pattern: /(raw[_-]?(heart[_-]?rate|respiration|ppg|ecg)|waveform)["'\s:=]+\[([\d,.\s-]{100,})\]/gi,
      replacement: '$1: [REDACTED: RAW HEALTH WAVEFORM, length=$3]',
      severity: 'medium',
    },
    // 语音/音频数据标记
    {
      name: 'audio_data',
      pattern: /(audio[_-]?data|pcm[_-]?data|voice[_-]?sample)["'\s:=]+"([A-Za-z0-9+/=]{100,})"/gi,
      replacement: '$1: [REDACTED: AUDIO DATA]',
      severity: 'medium',
    },
    // 手机号
    {
      name: 'phone_number',
      pattern: /1[3-9]\d{9}/g,
      replacement: (match: string) => match.substring(0, 3) + '****' + match.substring(7),
      severity: 'medium',
    },
    // 身份证号
    {
      name: 'id_card',
      pattern: /\d{17}[\dXx]/g,
      replacement: (match: string) => match.substring(0, 6) + '********' + match.substring(14),
      severity: 'high',
    },
    // 邮箱
    {
      name: 'email',
      pattern: /[\w.-]+@[\w.-]+\.\w+/g,
      replacement: (match: string) => {
        const [name, domain] = match.split('@');
        return name.substring(0, 2) + '***@' + domain;
      },
      severity: 'low',
    },
  ],
  binaryMarkers: [
    {
      name: 'secure_boot_key',
      marker: Buffer.from('SECURE_BOOT_KEY'),
      maxSize: 0, // 完全移除
    },
    {
      name: 'flash_encryption_key',
      marker: Buffer.from('FLASH_ENC_KEY'),
      maxSize: 0,
    },
    {
      name: 'device_private_key',
      marker: Buffer.from('DEV_PRIV_KEY'),
      maxSize: 0,
    },
    {
      name: 'raw_radar_data',
      marker: Buffer.from('RAW_RADAR'),
      maxSize: 64, // 仅保留前64字节用于诊断
    },
    {
      name: 'audio_buffer',
      marker: Buffer.from('AUDIO_BUF'),
      maxSize: 0,
    },
  ],
  output: {
    preserveStructure: true,
    addSanitizationLog: true,
    hashOriginal: true,
  },
};

// ============================================================
// 脱敏引擎
// ============================================================

interface SanitizationResult {
  output: Buffer;
  originalHash: string;
  outputHash: string;
  findings: Array<{
    type: string;
    severity: string;
    count: number;
    description: string;
  }>;
  totalRedactions: number;
  originalSize: number;
  outputSize: number;
  sanitizedAt: string;
}

class CoredumpSanitizer {
  private config: SanitizerConfig;

  constructor(config?: Partial<SanitizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 脱敏 Core Dump 文件
   */
  sanitize(inputPath: string, outputPath: string): SanitizationResult {
    console.log(`[CoreDump Sanitizer] 开始处理: ${inputPath}`);

    // 读取输入文件
    const originalBuffer = fs.readFileSync(inputPath);
    const originalHash = this.hashBuffer(originalBuffer);
    const originalSize = originalBuffer.length;

    console.log(`[CoreDump Sanitizer] 原始大小: ${originalSize} bytes, SHA256: ${originalHash}`);

    // 执行脱敏
    let outputBuffer: Buffer = Buffer.from(originalBuffer);
    const findings: SanitizationResult['findings'] = [];
    let totalRedactions = 0;

    // 1. 文本模式脱敏（将 Buffer 转为字符串处理，再转回 Buffer）
    const textResult = this.sanitizeTextPatterns(outputBuffer.toString('utf8'));
    outputBuffer = Buffer.from(textResult.sanitizedText, 'utf8');
    findings.push(...textResult.findings);
    totalRedactions += textResult.totalRedactions;

    // 2. 二进制敏感区域处理
    const binaryResult = this.sanitizeBinaryMarkers(outputBuffer);
    outputBuffer = binaryResult.output;
    findings.push(...binaryResult.findings);
    totalRedactions += binaryResult.totalRedactions;

    // 3. 添加脱敏日志（如果配置要求）
    if (this.config.output.addSanitizationLog) {
      const logEntry = this.buildSanitizationLog(originalHash, findings, totalRedactions);
      outputBuffer = Buffer.concat([outputBuffer, Buffer.from('\n\n=== SANITIZATION LOG ===\n' + logEntry + '\n')]);
    }

    // 写入输出文件
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, outputBuffer);

    const outputHash = this.hashBuffer(outputBuffer);
    const outputSize = outputBuffer.length;

    console.log(`[CoreDump Sanitizer] 脱敏完成: ${outputSize} bytes, SHA256: ${outputHash}`);
    console.log(`[CoreDump Sanitizer] 共发现 ${findings.length} 类敏感内容，执行 ${totalRedactions} 处脱敏`);

    return {
      output: outputBuffer,
      originalHash,
      outputHash,
      findings,
      totalRedactions,
      originalSize,
      outputSize,
      sanitizedAt: new Date().toISOString(),
    };
  }

  /**
   * 文本模式脱敏
   */
  private sanitizeTextPatterns(text: string): {
    sanitizedText: string;
    findings: SanitizationResult['findings'];
    totalRedactions: number;
  } {
    let sanitizedText = text;
    const findings: SanitizationResult['findings'] = [];
    let totalRedactions = 0;

    for (const patternConfig of this.config.patterns) {
      let count = 0;
      sanitizedText = sanitizedText.replace(patternConfig.pattern, (match, ...args) => {
        count++;
        if (typeof patternConfig.replacement === 'function') {
          return patternConfig.replacement(match, ...args);
        }
        return patternConfig.replacement;
      });

      if (count > 0) {
        findings.push({
          type: patternConfig.name,
          severity: patternConfig.severity,
          count,
          description: `发现 ${count} 处 ${patternConfig.name} 敏感内容`,
        });
        totalRedactions += count;
      }
    }

    return { sanitizedText, findings, totalRedactions };
  }

  /**
   * 二进制敏感区域脱敏
   */
  private sanitizeBinaryMarkers(buffer: Buffer): {
    output: Buffer;
    findings: SanitizationResult['findings'];
    totalRedactions: number;
  } {
    let output = Buffer.from(buffer);
    const findings: SanitizationResult['findings'] = [];
    let totalRedactions = 0;

    for (const markerConfig of this.config.binaryMarkers) {
      let position = 0;
      let count = 0;

      while ((position = output.indexOf(markerConfig.marker, position)) !== -1) {
        count++;

        if (markerConfig.maxSize === 0) {
          // 完全移除：用 [REDACTED] 替换标记及其后的数据（直到下一个标记或文件末尾）
          const endPosition = this.findNextMarker(output, position + markerConfig.marker.length);
          const redaction = Buffer.from(`[REDACTED: ${markerConfig.name}]`);
          output = Buffer.concat([
            output.subarray(0, position),
            redaction,
            output.subarray(endPosition),
          ]);
          position += redaction.length;
        } else {
          // 截断：仅保留前 maxSize 字节
          const dataStart = position + markerConfig.marker.length;
          const truncateEnd = dataStart + markerConfig.maxSize;
          const truncation = Buffer.from(`... [TRUNCATED: ${markerConfig.name}, only first ${markerConfig.maxSize} bytes preserved]`);
          output = Buffer.concat([
            output.subarray(0, truncateEnd),
            truncation,
            output.subarray(this.findNextMarker(output, truncateEnd)),
          ]);
          position = truncateEnd + truncation.length;
        }
      }

      if (count > 0) {
        findings.push({
          type: markerConfig.name,
          severity: 'critical',
          count,
          description: `发现 ${count} 处二进制敏感区域: ${markerConfig.name}`,
        });
        totalRedactions += count;
      }
    }

    return { output, findings, totalRedactions };
  }

  /**
   * 查找下一个标记位置
   */
  private findNextMarker(buffer: Buffer, fromPosition: number): number {
    let minPosition = buffer.length;
    for (const markerConfig of this.config.binaryMarkers) {
      const pos = buffer.indexOf(markerConfig.marker, fromPosition);
      if (pos !== -1 && pos < minPosition) {
        minPosition = pos;
      }
    }
    return minPosition;
  }

  /**
   * 构建脱敏日志
   */
  private buildSanitizationLog(
    originalHash: string,
    findings: SanitizationResult['findings'],
    totalRedactions: number,
  ): string {
    const log = {
      sanitizerVersion: '1.0.0',
      sanitizedAt: new Date().toISOString(),
      originalSha256: originalHash,
      totalRedactions,
      findings: findings.map((f) => ({
        type: f.type,
        severity: f.severity,
        count: f.count,
      })),
    };
    return JSON.stringify(log, null, 2);
  }

  /**
   * 计算 Buffer 的 SHA256 哈希
   */
  private hashBuffer(buffer: Buffer): string {
    return require('crypto').createHash('sha256').update(buffer).digest('hex');
  }
}

// ============================================================
// 命令行入口
// ============================================================

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('用法: npx ts-node scripts/coredump-sanitizer.ts <input-file> <output-file>');
    console.error('');
    console.error('示例:');
    console.error('  npx ts-node scripts/coredump-sanitizer.ts ./coredumps/device-001.bin ./sanitized/device-001.sanitized.bin');
    process.exit(1);
  }

  const [inputPath, outputPath] = args;

  if (!fs.existsSync(inputPath)) {
    console.error(`错误: 输入文件不存在: ${inputPath}`);
    process.exit(1);
  }

  try {
    const sanitizer = new CoredumpSanitizer();
    const result = sanitizer.sanitize(inputPath, outputPath);

    console.log('');
    console.log('=== 脱敏结果摘要 ===');
    console.log(`原始大小: ${result.originalSize} bytes`);
    console.log(`输出大小: ${result.outputSize} bytes`);
    console.log(`原始哈希: ${result.originalHash}`);
    console.log(`输出哈希: ${result.outputHash}`);
    console.log(`脱敏处数: ${result.totalRedactions}`);
    console.log('');
    console.log('发现的敏感内容:');
    for (const finding of result.findings) {
      console.log(`  [${finding.severity.toUpperCase()}] ${finding.type}: ${finding.count} 处`);
    }
    console.log('');
    console.log(`脱敏文件已保存至: ${outputPath}`);
  } catch (error) {
    console.error(`脱敏失败: ${(error as Error).message}`);
    console.error((error as Error).stack);
    process.exit(1);
  }
}

// 仅在直接运行时执行
if (require.main === module) {
  main();
}

export { CoredumpSanitizer };
export type { SanitizationResult, SanitizerConfig };
