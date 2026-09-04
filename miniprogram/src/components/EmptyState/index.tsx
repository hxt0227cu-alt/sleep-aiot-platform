import React from 'react'
import { View, Text } from '@tarojs/components'
import './index.scss'

interface EmptyStateProps {
  icon?: string
  title: string
  description?: string
  actionText?: string
  onAction?: () => void
}

const EmptyState: React.FC<EmptyStateProps> = ({ 
  icon = '📭', 
  title, 
  description = '暂无数据', 
  actionText = '去添加', 
  onAction 
}) => {
  return (
    <View className='empty-state'>
      <View className='empty-icon'>{icon}</View>
      <Text className='empty-title'>{title}</Text>
      {description && (
        <Text className='empty-description'>{description}</Text>
      )}
      {actionText && onAction && (
        <View className='empty-action' onClick={onAction}>
          <Text className='action-text'>{actionText}</Text>
        </View>
      )}
    </View>
  )
}

export default EmptyState
