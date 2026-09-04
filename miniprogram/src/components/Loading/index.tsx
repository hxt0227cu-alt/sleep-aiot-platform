import React from 'react'
import { View, Text } from '@tarojs/components'
import './index.scss'

interface LoadingProps {
  text?: string
  size?: 'small' | 'medium' | 'large'
}

const Loading: React.FC<LoadingProps> = ({ text = '加载中...', size = 'medium' }) => {
  return (
    <View className={`loading-container ${size}`}>
      <View className='loading-spinner'>
        <View className='spinner-circle' />
        <View className='spinner-circle' />
        <View className='spinner-circle' />
        <View className='spinner-circle' />
      </View>
      {text && <Text className='loading-text'>{text}</Text>}
    </View>
  )
}

export default Loading
