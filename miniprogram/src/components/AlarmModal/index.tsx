import React from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

interface AlarmModalProps {
  visible: boolean
  alarm: any
  onConfirm?: () => void
  onCancel?: () => void
}

const AlarmModal: React.FC<AlarmModalProps> = ({ visible, alarm, onConfirm, onCancel }) => {
  const handleConfirm = () => {
    onConfirm?.()
  }

  const handleCancel = () => {
    onCancel?.()
  }

  if (!visible || !alarm) return null

  return (
    <View className='alarm-modal' onClick={handleCancel}>
      <View className='modal-overlay' onClick={(e) => e.stopPropagation()}>
        <View className='modal-content' onClick={(e) => e.stopPropagation()}>
          <View className='modal-header'>
            <Text className='modal-title'>报警详情</Text>
            <View className='close-button' onClick={handleCancel}>
              <Text className='close-icon'>✕</Text>
            </View>
          </View>
          
          <ScrollView scrollY className='modal-body'>
            <View className='alarm-info'>
              <View className='info-item'>
                <Text className='info-label'>报警类型</Text>
                <Text className='info-value'>{alarm.type}</Text>
              </View>
              
              <View className='info-item'>
                <Text className='info-label'>报警级别</Text>
                <Text className={`info-value ${alarm.level}`}>
                  {alarm.level === 'critical' ? '严重' : alarm.level === 'warning' ? '警告' : '信息'}
                </Text>
              </View>
              
              <View className='info-item'>
                <Text className='info-label'>报警时间</Text>
                <Text className='info-value'>
                  {new Date(alarm.timestamp).toLocaleString()}
                </Text>
              </View>
              
              <View className='info-item'>
                <Text className='info-label'>报警消息</Text>
                <Text className='info-value'>{alarm.message}</Text>
              </View>
              
              {alarm.value !== undefined && (
                <View className='info-item'>
                  <Text className='info-label'>当前值</Text>
                  <Text className='info-value'>{alarm.value}</Text>
                </View>
              )}
              
              {alarm.threshold !== undefined && (
                <View className='info-item'>
                  <Text className='info-label'>阈值</Text>
                  <Text className='info-value'>{alarm.threshold}</Text>
                </View>
              )}
              
              {alarm.status === 'pending' && (
                <View className='info-item'>
                  <Text className='info-label'>状态</Text>
                  <Text className='info-value pending'>未处理</Text>
                </View>
              )}
            </View>
          </ScrollView>
          
          <View className='modal-footer'>
            <View className='footer-button cancel' onClick={handleCancel}>
              <Text>取消</Text>
            </View>
            <View className='footer-button confirm' onClick={handleConfirm}>
              <Text>标记已读</Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  )
}

export default AlarmModal
