import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading, formatDate } from '../../utils/util'
import Loading from '../../components/Loading'
import EmptyState from '../../components/EmptyState'
import './index.scss'

const DeviceListPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showUnbindModal, setShowUnbindModal] = useState(false)
  const [selectedDevice, setSelectedDevice] = useState<any>(null)
  const [unbinding, setUnbinding] = useState(false)

  const { devices, setDevices, removeDevice, currentDevice, setCurrentDevice } = useDeviceStore()

  useEffect(() => {
    loadDevices()
  }, [])

  const loadDevices = async () => {
    try {
      setLoading(true)
      showLoading('加载设备列表...')

      const result = await api.device.getDevices()
      if (result.code === 200) {
        setDevices(result.data.devices || [])
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('加载设备列表失败:', error)
      showToast('加载失败，请重试', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await loadDevices()
    setRefreshing(false)
  }

  const handleAddDevice = () => {
    Taro.navigateTo({ url: '/pages/device-provision/index' })
  }

  const handleDeviceClick = (device: any) => {
    setCurrentDevice(device)
    Taro.navigateTo({ url: `/pages/device-detail/index?deviceId=${device.device_id}` })
  }

  const handleUnbindClick = (device: any, e: any) => {
    e.stopPropagation()
    setSelectedDevice(device)
    setShowUnbindModal(true)
  }

  const handleConfirmUnbind = async () => {
    if (!selectedDevice) return

    try {
      setUnbinding(true)
      showLoading('正在解绑设备...')

      const result = await api.device.unbind(selectedDevice.device_id)
      if (result.code === 200) {
        showToast('设备解绑成功', 'success')
        removeDevice(selectedDevice.device_id)
        setShowUnbindModal(false)
        setSelectedDevice(null)
      } else {
        showToast(result.message || '解绑失败', 'error')
      }
    } catch (error: any) {
      console.error('解绑失败:', error)
      showToast('解绑失败，请重试', 'error')
    } finally {
      setUnbinding(false)
      hideLoading()
    }
  }

  const handleCancelUnbind = () => {
    setShowUnbindModal(false)
    setSelectedDevice(null)
  }

  const getDeviceStatusText = (device: any) => {
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

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  return (
    <View className='device-list-page'>
      <ScrollView
        scrollY
        className='scroll-container'
        refresherEnabled
        onRefresherRefresh={handleRefresh}
      >
        <View className='header-section'>
          <View className='header-content'>
            <View className='header-left'>
              <Text className='page-title'>我的设备</Text>
              <Text className='device-count'>
                已绑定 {devices.length} 台设备
              </Text>
            </View>
            <View className='add-button' onClick={handleAddDevice}>
              <Text className='add-icon'>+</Text>
              <Text className='add-text'>添加设备</Text>
            </View>
          </View>
        </View>

        {devices.length === 0 ? (
          <View className='empty-section'>
            <EmptyState
              icon='📱'
              title='暂无设备'
              description='您还没有绑定任何设备，点击下方按钮添加设备'
              actionText='添加设备'
              onAction={handleAddDevice}
            />
          </View>
        ) : (
          <View className='device-list'>
            {devices.map((device, index) => (
              <View
                key={device.device_id}
                className={`device-card ${currentDevice?.device_id === device.device_id ? 'active' : ''}`}
                onClick={() => handleDeviceClick(device)}
              >
                <View className='card-header'>
                  <View className='device-icon'>
                    <Text className='icon'>💡</Text>
                  </View>
                  <View className='device-info'>
                    <Text className='device-name'>{device.device_name}</Text>
                    <Text className='device-id'>ID: {device.device_id}</Text>
                  </View>
                  <View className={`device-status ${device.online ? 'online' : 'offline'}`}>
                    <Text className='status-text'>{getDeviceStatusText(device)}</Text>
                  </View>
                </View>

                <View className='card-body'>
                  <View className='info-row'>
                    <Text className='info-label'>设备类型</Text>
                    <Text className='info-value'>
                      {device.device_type === 'sleep_monitor' ? '睡眠监测仪' : device.device_type}
                    </Text>
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
                    {currentDevice?.device_id === device.device_id && (
                      <View className='status-badge current'>
                        <Text className='badge-text'>当前设备</Text>
                      </View>
                    )}
                  </View>
                  <View className='unbind-button' onClick={(e) => handleUnbindClick(device, e)}>
                    <Text className='unbind-text'>解绑</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}

        <View className='help-section'>
          <View className='help-card'>
            <Text className='help-title'>设备管理提示</Text>
            <Text className='help-item'>• 点击设备卡片查看详细信息</Text>
            <Text className='help-item'>• 长按设备可快速切换当前设备</Text>
            <Text className='help-item'>• 解绑设备后将无法查看该设备数据</Text>
            <Text className='help-item'>• 建议定期检查设备固件更新</Text>
          </View>
        </View>
      </ScrollView>

      {showUnbindModal && selectedDevice && (
        <View className='unbind-modal' onClick={handleCancelUnbind}>
          <View className='modal-content' onClick={(e) => e.stopPropagation()}>
            <View className='modal-header'>
              <Text className='modal-title'>确认解绑</Text>
              <View className='close-button' onClick={handleCancelUnbind}>
                <Text className='close-icon'>✕</Text>
              </View>
            </View>

            <View className='modal-body'>
              <View className='warning-icon'>
                <Text className='icon'>⚠️</Text>
              </View>
              <Text className='warning-text'>
                您确定要解绑设备 &ldquo;{selectedDevice.device_name}&rdquo; 吗？
              </Text>
              <Text className='warning-desc'>
                解绑后，您将无法查看该设备的任何数据，如需重新使用，请重新绑定。
              </Text>
            </View>

            <View className='modal-footer'>
              <View className='modal-button cancel' onClick={handleCancelUnbind}>
                <Text>取消</Text>
              </View>
              <View
                className={`modal-button confirm ${unbinding ? 'disabled' : ''}`}
                onClick={handleConfirmUnbind}
              >
                <Text>{unbinding ? '解绑中...' : '确认解绑'}</Text>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}

export default DeviceListPage
