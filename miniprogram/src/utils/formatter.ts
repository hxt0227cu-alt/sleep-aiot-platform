export const formatHeartRate = (value: number): string => {
  return `${value} bpm`
}

export const formatBreathingRate = (value: number): string => {
  return `${value} 次/分`
}

export const formatBodyMovement = (value: number): string => {
  return `${value.toFixed(2)} g`
}

export const formatSleepState = (state: string): string => {
  const stateMap: Record<string, string> = {
    awake: '清醒',
    light_sleep: '浅睡',
    deep_sleep: '深睡',
    rem_sleep: '快速眼动'
  }
  return stateMap[state] || state
}

export const formatSleepScore = (score: number): string => {
  if (score >= 90) return '优秀'
  if (score >= 80) return '良好'
  if (score >= 70) return '一般'
  if (score >= 60) return '较差'
  return '很差'
}

export const formatSleepScoreColor = (score: number): string => {
  if (score >= 90) return '#10b981'
  if (score >= 80) return '#3b82f6'
  if (score >= 70) return '#f59e0b'
  if (score >= 60) return '#f97316'
  return '#ef4444'
}

export const formatAlarmLevel = (level: string): string => {
  const levelMap: Record<string, string> = {
    info: '信息',
    warning: '警告',
    critical: '严重'
  }
  return levelMap[level] || level
}

export const formatAlarmLevelColor = (level: string): string => {
  const colorMap: Record<string, string> = {
    info: '#3b82f6',
    warning: '#f59e0b',
    critical: '#ef4444'
  }
  return colorMap[level] || '#6b7280'
}

export const formatAlarmType = (type: string): string => {
  const typeMap: Record<string, string> = {
    heart_rate_high: '心率过高',
    heart_rate_low: '心率过低',
    breathing_rate_high: '呼吸率过高',
    breathing_rate_low: '呼吸率过低',
    no_movement: '长时间无体动',
    device_offline: '设备离线'
  }
  return typeMap[type] || type
}

export const formatBrightness = (value: number): string => {
  return `${Math.round(value)}%`
}

export const formatColorTemp = (value: number): string => {
  if (value < 3000) return '暖光'
  if (value < 4500) return '自然光'
  if (value < 6000) return '冷白光'
  return '冷光'
}

export const formatSignalStrength = (value: number): string => {
  if (value >= -50) return '强'
  if (value >= -70) return '良好'
  if (value >= -85) return '一般'
  return '弱'
}

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export const formatPercentage = (value: number, decimals: number = 1): string => {
  return `${value.toFixed(decimals)}%`
}

export const formatNumber = (value: number, decimals: number = 2): string => {
  return value.toFixed(decimals)
}
