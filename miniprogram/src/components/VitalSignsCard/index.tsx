import React from 'react'
import { View, Text } from '@tarojs/components'  
import { formatHeartRate, formatBreathingRate, formatBodyMovement, formatSleepState } from '../../utils/formatter'
import type { VitalSigns } from '../../types'
import './index.scss'

interface VitalSignsCardProps {
  data: VitalSigns | null
  loading?: boolean
}

const VitalSignsCard: React.FC<VitalSignsCardProps> = ({ data, loading }) => {
  if (loading) {
    return (
      <View className='vital-signs-card loading'>
        <View className='skeleton' />
        <View className='skeleton' />
        <View className='skeleton' />
      </View>
    )
  }

  if (!data) {
    return (
      <View className='vital-signs-card empty'>
        <Text className='empty-text'>暂无数据</Text>
      </View>
    )
  }

  return (
    <View className='vital-signs-card'>
      <View className='sign-item'>
        <View className='sign-icon heart'>
          <Text className='icon'>❤️</Text>
        </View>
        <View className='sign-info'>
          <Text className='sign-value'>{data.heart_rate.value}</Text>
          <Text className='sign-unit'>{data.heart_rate.unit}</Text>
          <Text className={`sign-status ${data.heart_rate.status}`}>
            {data.heart_rate.status === 'normal' ? '正常' : '异常'}
          </Text>
        </View>
      </View>

      <View className='sign-item'>
        <View className='sign-icon breathing'>
          <Text className='icon'>🫁</Text>
        </View>
        <View className='sign-info'>
          <Text className='sign-value'>{data.breathing_rate.value}</Text>
          <Text className='sign-unit'>{data.breathing_rate.unit}</Text>
          <Text className={`sign-status ${data.breathing_rate.status}`}>
            {data.breathing_rate.status === 'normal' ? '正常' : '异常'}
          </Text>
        </View>
      </View>

      <View className='sign-item'>
        <View className='sign-icon movement'>
          <Text className='icon'>🏃</Text>
        </View>
        <View className='sign-info'>
          <Text className='sign-value'>{formatBodyMovement(data.body_movement.value)}</Text>
          <Text className={`sign-status ${data.body_movement.status}`}>
            {data.body_movement.status === 'low' ? '平静' : '活跃'}
          </Text>
        </View>
      </View>

      <View className='sign-item'>
        <View className='sign-icon sleep'>
          <Text className='icon'>😴</Text>
        </View>
        <View className='sign-info'>
          <Text className='sign-value'>{formatSleepState(data.sleep_state.state)}</Text>
          <Text className='sign-confidence'>
            置信度: {(data.sleep_state.confidence * 100).toFixed(0)}%
          </Text>
        </View>
      </View>
    </View>
  )
}

export default VitalSignsCard
