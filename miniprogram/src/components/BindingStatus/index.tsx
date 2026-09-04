import React from 'react'
import { View, Text } from '@tarojs/components'
import './index.scss'

interface BindingStatusProps {
  status: 'idle' | 'scanning' | 'binding' | 'success' | 'error'
  progress?: number
  message?: string
}

const BindingStatus: React.FC<BindingStatusProps> = ({
  status,
  progress = 0,
  message
}) => {
  const getStatusIcon = () => {
    switch (status) {
      case 'idle':
        return '📱'
      case 'scanning':
        return '📷'
      case 'binding':
        return '🔄'
      case 'success':
        return '✅'
      case 'error':
        return '❌'
      default:
        return '📱'
    }
  }

  const getStatusText = () => {
    switch (status) {
      case 'idle':
        return '准备绑定'
      case 'scanning':
        return '正在扫描二维码...'
      case 'binding':
        return '正在绑定设备...'
      case 'success':
        return '绑定成功'
      case 'error':
        return '绑定失败'
      default:
        return '准备绑定'
    }
  }

  const getStatusDescription = () => {
    if (message) return message

    switch (status) {
      case 'idle':
        return '请选择绑定方式'
      case 'scanning':
        return '请将设备二维码放入扫描框内'
      case 'binding':
        return '正在连接设备，请稍候...'
      case 'success':
        return '设备已成功绑定到您的账户'
      case 'error':
        return '绑定过程中出现错误，请重试'
      default:
        return ''
    }
  }

  return (
    <View className='binding-status'>
      <View className='status-icon'>
        <Text className='icon'>{getStatusIcon()}</Text>
        {status === 'binding' && (
          <View className='loading-spinner' />
        )}
      </View>

      <Text className='status-text'>{getStatusText()}</Text>
      <Text className='status-description'>{getStatusDescription()}</Text>

      {status === 'binding' && (
        <View className='progress-section'>
          <View className='progress-bar'>
            <View
              className='progress-fill'
              style={{ width: `${progress}%` }}
            />
          </View>
          <Text className='progress-text'>{progress}%</Text>
        </View>
      )}

      {status === 'error' && (
        <View className='error-actions'>
          <Text className='error-hint'>请检查：</Text>
          <Text className='error-item'>• 设备是否已通电</Text>
          <Text className='error-item'>• 设备是否进入配网模式</Text>
          <Text className='error-item'>• 绑定码是否正确</Text>
          <Text className='error-item'>• 置络连接是否正常</Text>
        </View>
      )}
    </View>
  )
}

export default BindingStatus
