import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading, formatDate } from '../../utils/util'
import { formatSignalStrength, formatFileSize } from '../../utils/formatter'
import Loading from '../../components/Loading'
import './index.scss'

const DeviceDetailPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [deviceDetail, setDeviceDetail] = useState<any>(null)
  const [otaInfo, setOtaInfo] = useState<any>(null)
  const [showOtaModal, setShowOtaModal] = useState(false)
  const [otaProgress, setOtaProgress] = useState(0)
  const [showUnbindModal, setShowUnbindModal] = useState(false)
  const [unbinding, setUnbinding] = useState(false)

  const { currentDevice, removeDevice } = useDeviceStore()

  useEffect(() => {
    const deviceId = Taro.getCurrentInstance().router?.params?.deviceId
    if (deviceId) {
      loadDeviceDetail(deviceId)
    } else if (currentDevice) {
      loadDeviceDetail(currentDevice.device_id)
    }
  }, [])

  const loadDeviceDetail = async (deviceId: string) => {
    try {
      setLoading(true)
      showLoading('加载中...')

      const result = await api.device.getDeviceDetail(deviceId)
      if (result.code === 200) {
        setDeviceDetail(result.data)
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('加载设备详情失败:', error)
      showToast('加载失败，请重试', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const handleCheckUpdate = async () => {
    if (!deviceDetail) return

    try {
      showLoading('检查更新...')

      const result = await api.ota.checkUpdate(deviceDetail.device_id)
      if (result.code === 200) {
        setOtaInfo(result.data)
        setShowOtaModal(true)
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('检查更新失败:', error)
      showToast('检查更新失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleStartOta = async () => {
    if (!otaInfo) return

    try {
      showLoading('开始升级...')
      setShowOtaModal(false)

      setOtaProgress(0)

      const interval = setInterval(() => {
        setOtaProgress(prev => {
          const newProgress = prev + 10
          if (newProgress >= 100) {
            clearInterval(interval)
            return 100
          }
          return newProgress
        })
      }, 1000)

    } catch (error: any) {
      console.error('开始升级失败:', error)
      showToast('升级失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleSendCommand = async (command: string, params: any) => {
    if (!deviceDetail) return

    try {
      showLoading('发送指令...')

      const result = await api.device.sendCommand(
        deviceDetail.device_id,
        command,
        params
      )

      if (result.code === 200) {
        showToast('指令发送成功', 'success')
        await loadDeviceDetail(deviceDetail.device_id)
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('发送指令失败:', error)
      showToast('发送失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleUnbind = async () => {
    if (!deviceDetail) return

    try {
      setUnbinding(true)
      showLoading('正在解绑设备...')

      const result = await api.device.unbind(deviceDetail.device_id)
      if (result.code === 200) {
        showToast('设备解绑成功', 'success')
        removeDevice(deviceDetail.device_id)
        setShowUnbindModal(false)
        setTimeout(() => {
          Taro.navigateBack()
        }, 1500)
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
  }

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  return (
    <View className='device-detail-page'>
      <ScrollView scrollY className='scroll-container'>
        <View className='header-section'>
          <View className='device-icon'>
            <Text className='icon'>💡</Text>
          </View>
          <View className='device-info'>
            <Text className='device-name'>{deviceDetail?.device_name || '设备名称'}</Text>
            <Text className={`device-status ${deviceDetail?.online ? 'online' : 'offline'}`}>
              {deviceDetail?.online ? '在线' : '离线'}
            </Text>
          </View>
        </View>

        <View className='info-section'>
          <View className='info-card'>
            <View className='card-header'>
              <Text className='card-title'>基本信息</Text>
            </View>
            <View className='card-content'>
              <View className='info-row'>
                <Text className='info-label'>设备ID</Text>
                <Text className='info-value'>{deviceDetail?.device_id || '-'}</Text>
              </View>
              <View className='info-row'>
                <Text className='info-label'>设备类型</Text>
                <Text className='info-value'>
                  {deviceDetail?.device_type === 'sleep_monitor' ? '睡眠监测仪' : deviceDetail?.device_type || '-'}
                </Text>
              </View>
              <View className='info-row'>
                <Text className='info-label'>固件版本</Text>
                <Text className='info-value'>{deviceDetail?.firmware_version || '-'}</Text>
              </View>
              <View className='info-row'>
                <Text className='info-label'>最后在线</Text>
                <Text className='info-value'>
                  {deviceDetail?.last_seen ? formatDate(deviceDetail.last_seen, 'MM-DD HH:mm') : '-'}
                </Text>
              </View>
            </View>
          </View>

          {deviceDetail?.hardware_info && (
            <View className='info-card'>
              <View className='card-header'>
                <Text className='card-title'>硬件信息</Text>
              </View>
              <View className='card-content'>
                <View className='info-row'>
                  <Text className='info-label'>芯片型号</Text>
                  <Text className='info-value'>{deviceDetail.hardware_info.chip_id || '-'}</Text>
                </View>
                <View className='info-row'>
                  <Text className='info-label'>MAC地址</Text>
                  <Text className='info-value'>{deviceDetail.hardware_info.mac_address || '-'}</Text>
                </View>
                <View className='info-row'>
                  <Text className='info-label'>PSRAM</Text>
                  <Text className='info-value'>{deviceDetail.hardware_info.psram_size || '-'}</Text>
                </View>
              </View>
            </View>
          )}

          {deviceDetail?.network_info && (
            <View className='info-card'>
              <View className='card-header'>
                <Text className='card-title'>网络信息</Text>
              </View>
              <View className='card-content'>
                <View className='info-row'>
                  <Text className='info-label'>WiFi名称</Text>
                  <Text className='info-value'>{deviceDetail.network_info.wifi_ssid || '-'}</Text>
                </View>
                <View className='info-row'>
                  <Text className='info-label'>信号强度</Text>
                  <Text className='info-value'>
                    {deviceDetail.network_info.signal_strength !== undefined ?
                      `${deviceDetail.network_info.signal_strength} dBm (${formatSignalStrength(deviceDetail.network_info.signal_strength)})` : '-'}
                  </Text>
                </View>
                <View className='info-row'>
                  <Text className='info-label'>IP地址</Text>
                  <Text className='info-value'>{deviceDetail.network_info.ip_address || '-'}</Text>
                </View>
              </View>
            </View>
          )}

          <View className='ota-section'>
            <View className='card-header'>
              <Text className='card-title'>固件升级</Text>
            </View>
            <View className='ota-content'>
              <View className='current-version'>
                <Text className='version-label'>当前版本</Text>
                <Text className='version-value'>{deviceDetail?.firmware_version || '-'}</Text>
              </View>
              <View className='check-button' onClick={handleCheckUpdate}>
                <Text className='button-text'>检查更新</Text>
              </View>
            </View>
          </View>

          <View className='actions-section'>
            <View className='section-title'>
              <Text className='title-text'>设备控制</Text>
            </View>

            <View className='action-grid'>
              <View className='action-item' onClick={() => handleSendCommand('light_control', { power: true })}>
                <View className='action-icon'>
                  <Text className='icon'>💡</Text>
                </View>
                <Text className='action-text'>开灯</Text>
              </View>

              <View className='action-item' onClick={() => handleSendCommand('light_control', { power: false })}>
                <View className='action-icon'>
                  <Text className='icon'>🌙</Text>
                </View>
                <Text className='action-text'>关灯</Text>
              </View>

              <View className='action-item' onClick={() => handleSendCommand('anion_control', { power: true })}>
                <View className='action-icon'>
                  <Text className='icon'>🌬</Text>
                </View>
                <Text className='action-text'>开启负离子</Text>
              </View>

              <View className='action-item' onClick={() => handleSendCommand('anion_control', { power: false })}>
                <View className='action-icon'>
                  <Text className='icon'>🚫</Text>
                </View>
                <Text className='action-text'>关闭负离子</Text>
              </View>

              <View className='action-item' onClick={() => handleSendCommand('voice_control', { enabled: true })}>
                <View className='action-icon'>
                  <Text className='icon'>🎤</Text>
                </View>
                <Text className='action-text'>开启语音</Text>
              </View>

              <View className='action-item' onClick={() => handleSendCommand('voice_control', { enabled: false })}>
                <View className='action-icon'>
                  <Text className='icon'>🔇</Text>
                </View>
                <Text className='action-text'>关闭语音</Text>
              </View>
            </View>
          </View>

          <View className='danger-section'>
            <View className='section-title'>
              <Text className='title-text'>危险操作</Text>
            </View>
            <View className='unbind-button' onClick={() => setShowUnbindModal(true)}>
              <Text className='unbind-text'>解绑设备</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      {showOtaModal && otaInfo && (
        <View className='ota-modal' onClick={() => setShowOtaModal(false)}>
          <View className='modal-content' onClick={(e) => e.stopPropagation()}>
            <View className='modal-header'>
              <Text className='modal-title'>发现新版本</Text>
              <View className='close-button' onClick={() => setShowOtaModal(false)}>
                <Text className='close-icon'>✕</Text>
              </View>
            </View>

            <View className='modal-body'>
              <View className='version-info'>
                <View className='version-item'>
                  <Text className='version-label'>当前版本</Text>
                  <Text className='version-value'>{deviceDetail?.firmware_version}</Text>
                </View>
                <View className='version-item'>
                  <Text className='version-label'>最新版本</Text>
                  <Text className='version-value'>{otaInfo.latest_version}</Text>
                </View>
              </View>

              <View className='update-info'>
                <Text className='update-label'>更新类型</Text>
                <Text className='update-value'>
                  {otaInfo.update_type === 'incremental' ? '增量更新' : '完整更新'}
                </Text>
              </View>
              <View className='update-info'>
                <Text className='update-label'>文件大小</Text>
                <Text className='update-value'>{formatFileSize(otaInfo.file_size)}</Text>
              </View>

              <View className='release-notes'>
                <Text className='notes-label'>更新说明</Text>
                <Text className='notes-text'>{otaInfo.release_notes || '无更新说明'}</Text>
              </View>

              {otaProgress > 0 && (
                <View className='progress-section'>
                  <View className='progress-bar'>
                    <View
                      className='progress-fill'
                      style={{ width: `${otaProgress}%` }}
                    />
                  </View>
                  <Text className='progress-text'>{otaProgress}%</Text>
                </View>
              )}
            </View>

            <View className='modal-footer'>
              <View className='modal-button cancel' onClick={() => setShowOtaModal(false)}>
                <Text>取消</Text>
              </View>
              <View
                className={`modal-button confirm ${otaProgress > 0 ? 'disabled' : ''}`}
                onClick={handleStartOta}
              >
                <Text>{otaProgress > 0 ? '升级中...' : '开始升级'}</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {showUnbindModal && (
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
                您确定要解绑设备 &ldquo;{deviceDetail?.device_name}&rdquo; 吗？
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
                onClick={handleUnbind}
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

export default DeviceDetailPage
