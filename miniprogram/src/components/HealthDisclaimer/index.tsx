import { View, Text } from '@tarojs/components';
import { useState } from 'react';
import './index.scss';

interface HealthDisclaimerProps {
  /** 免责声明类型 */
  type?: 'general' | 'alarm' | 'data' | 'severe';
  /** 是否显示确认按钮 */
  showAcknowledge?: boolean;
  /** 是否紧凑模式 */
  compact?: boolean;
  /** 自定义内容 */
  customContent?: string;
  /** 确认回调 */
  onAcknowledge?: () => void;
}

/**
 * 健康免责声明组件
 *
 * 功能：
 *   - 在涉及健康数据、报警、医疗建议的场景下显示免责声明
 *   - 支持多种类型：通用、报警、数据、严重
 *   - 支持用户确认（首次使用时）
 *   - 符合医疗合规要求
 */
export default function HealthDisclaimer({
  type = 'general',
  showAcknowledge = false,
  compact = false,
  customContent,
  onAcknowledge,
}: HealthDisclaimerProps) {
  const [acknowledged, setAcknowledged] = useState(false);

  // 免责声明内容配置
  const disclaimerConfig = {
    general: {
      icon: 'ℹ️',
      title: '健康提示',
      content: `
        <p>本产品提供的睡眠监测数据和分析仅供参考，不能替代专业医疗诊断、治疗或医生建议。</p>
        <p>如有任何健康疑虑或症状持续，请及时咨询专业医生。</p>
      `,
    },
    alarm: {
      icon: '⚠️',
      title: '报警提示',
      content: `
        <p>本产品的报警功能基于算法检测，可能存在误报或漏报。报警信息仅供参考，不能作为医疗诊断依据。</p>
        <p>如收到报警后感到不适，请立即就医或拨打120急救电话。</p>
      `,
    },
    data: {
      icon: '📊',
      title: '数据说明',
      content: `
        <p>睡眠监测数据可能受到设备佩戴位置、环境干扰、个体差异等因素影响，数据准确性有一定限制。</p>
        <p>数据仅供个人健康管理参考，不应用于医疗诊断或治疗决策。</p>
      `,
    },
    severe: {
      icon: '🚨',
      title: '重要提示',
      content: `
        <p>本产品不是医疗器械，不具备医疗诊断功能。所有数据和分析仅供健康管理参考。</p>
        <p>如出现胸痛、呼吸困难、意识不清等紧急症状，请立即拨打120急救电话。</p>
        <p>本产品不能替代医生的专业诊断和治疗，如有健康问题请及时就医。</p>
      `,
    },
  };

  const config = disclaimerConfig[type];

  const handleAcknowledge = () => {
    setAcknowledged(true);
    onAcknowledge?.();
  };

  // 如果已确认且不需要一直显示，则隐藏
  if (acknowledged && showAcknowledge) {
    return null;
  }

  const containerClass = [
    'disclaimer-container',
    compact ? 'disclaimer-compact' : '',
    type === 'severe' ? 'disclaimer-severe' : '',
  ].join(' ');

  return (
    <View className={containerClass}>
      <View className='disclaimer-header'>
        <Text className='disclaimer-icon'>{config.icon}</Text>
        <Text className='disclaimer-title'>{config.title}</Text>
      </View>
      <View
        className='disclaimer-content'
        dangerouslySetInnerHTML={{ __html: customContent || config.content }}
      />
      {showAcknowledge && (
        <View className='disclaimer-footer'>
          <Text className='disclaimer-version'>v1.0 · 2026-08-01</Text>
          <Text className='disclaimer-acknowledge' onClick={handleAcknowledge}>
            我已知晓
          </Text>
        </View>
      )}
      {!showAcknowledge && (
        <View className='disclaimer-footer'>
          <Text className='disclaimer-version'>v1.0 · 2026-08-01</Text>
        </View>
      )}
    </View>
  );
}
