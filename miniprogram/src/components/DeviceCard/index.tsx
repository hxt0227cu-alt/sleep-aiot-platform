import React from 'react'
import { View, Text } from '@tarojs/components'
import type { DeviceInfo } from '../../types'
import { formatDate } from '../../utils/util'
import './index.scss'

interface DeviceCardProps {
  device: DeviceInfo
  isActive?: boolean
  onClick?: () => void
  onUnbind?: () => void
  showUnbindButton?: boolean
}

const DeviceCard: React.FC<DeviceCardProps> = ({
  device,
  isActive = false,
  onClick,
  onUnbind,
  showUnbindButton = true
}) => {
  const getDeviceStatusText = () => {
    if (device.online) {
      return '在线'
    }
    const lastSeen = device.last_seen ? Date.now() - device.last_seen : Infinity
    if (lastSeen < 5 * 60 * 1000) {
      return '刚刚离线'
    } else if (lastSeen < 60 * 60 * 1000) {
      return `${Math.floor(lastSeen / (60 * 1000))}分钟前离线`
    } else if (lastSeen < 24 * 60 * 60 * 1000) {
      return `${Math.floor(lastSeen / (60 * 60 * 1000))}小时前离线`
    } else {
      return '长期离线'
    }
  }

  const getDeviceTypeText = () => {
    switch (device.device_type) {
      case 'sleep_monitor':
        return '睡眠监测仪'
      case 'smart_lamp':
        return '智能台灯'
      default:
        return device.device_type
    }
  }

  return (
    <View
      className={`device-card ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <View className='card-header'>
        <View className='device-icon'>
        <Text className='icon'>💡</Text>
        </View>
        <View className='device-info'>
          <Text className='device-name'>{device.device_name}</Text>
          <Text className='device-id'>{device.device_id}</Text>
        </View>
        <View className={`device-status ${device.online ? 'online' : 'offline'}`}>
          <Text className='status-text'>{getDeviceStatusText()}</Text>
        </View>
      </View>

      <View className='card-body'>
        <View className='info-row'>
          <Text className='info-label'>设备类型</Text>
          <Text className='info-value'>{getDeviceTypeText()}</Text>
        </View>
        <View className='info-row'>
          <Text className='info-label'>固件版本</Text>
          <Text className='info-value'>{device.firmware_version}</Text>
        </View>
        <View className='info-row'>
          <Text className='info-label'>最后在线</Text>
          <Text className='info-value'>
            {device.last_seen ? formatDate(device.last_seen, 'MM-DD HH:mm') : '-'}
          </Text>
        </View>
      </View>

      <View className='card-footer'>
        <View className='footer-left'>
          {device.online && (
            <View className='status-badge online'>
              <Text className='badge-text'>在线</Text>
            </View>
          )}
          {isActive && (
            <View className='status-badge current'>
              <Text className='badge-text'>当前设备</Text>
            </View>
          )}
        </View>
        {showUnbindButton && onUnbind && (
          <View className='unbind-button' onClick={(e) => {
            e.stopPropagation()
            onUnbind()
          }}
          >
            <Text className='unbind-text'>解绑</Text>
          </View>
        )}
      </View>
    </View>
  )
}

export default DeviceCard
