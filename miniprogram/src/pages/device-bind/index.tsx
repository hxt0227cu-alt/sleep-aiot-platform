import React, { useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading } from '../../utils/util'
import Loading from '../../components/Loading'
import './index.scss'

const DeviceBindPage: React.FC = () => {
  const [bindMethod, setBindMethod] = useState<'scan' | 'manual'>('scan')
  const [bindingCode, setBindingCode] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [loading, setLoading] = useState(false)
  const [binding, setBinding] = useState(false)
  const [bindProgress, setBindProgress] = useState(0)

  const { addDevice } = useDeviceStore()

  const handleScanQRCode = async () => {
    try {
      const result = await Taro.scanCode({
        onlyFromCamera: true,
        scanType: ['qrCode']
      })

      if (result.result) {
        const code = result.result
        // 解析二维码内容，格式: sleep://device/{device_id}?code={binding_code}
        if (code.startsWith('sleep://device/')) {
          const url = new URL(code.replace('sleep://', 'http://'))
          const parsedDeviceId = url.pathname.replace('/device/', '')
          const parsedBindingCode = url.searchParams.get('code')

          if (parsedDeviceId && parsedBindingCode) {
            setDeviceId(parsedDeviceId)
            setBindingCode(parsedBindingCode)
            setBindMethod('manual')
            showToast('扫描成功，请确认绑定', 'success')
          } else {
            showToast('二维码格式错误', 'error')
          }
        } else {
          // 直接使用扫描结果作为绑定码
          setBindingCode(code)
          setBindMethod('manual')
          showToast('扫描成功，请输入设备名称', 'success')
        }
      }
    } catch (error: any) {
      console.error('扫描失败:', error)
      if (error.errMsg !== 'scanCode:fail cancel') {
        showToast('扫描失败，请重试', 'error')
      }
    }
  }

  const handleBindDevice = async () => {
    if (!deviceId) {
      showToast('请输入设备ID', 'error')
      return
    }

    if (!bindingCode) {
      showToast('请输入绑定码', 'error')
      return
    }

    if (!deviceName) {
      showToast('请输入设备名称', 'error')
      return
    }

    try {
      setBinding(true)
      setBindProgress(0)
      showLoading('正在绑定设备...')

      // 模拟绑定进度
      const progressInterval = setInterval(() => {
        setBindProgress(prev => {
          if (prev >= 90) {
            clearInterval(progressInterval)
            return 90
          }
          return prev + 10
        })
      }, 200)

      const result = await api.device.bind({
        device_id: deviceId,
        binding_code: bindingCode
      })

      clearInterval(progressInterval)
      setBindProgress(100)

      if (result.code === 200) {
        showToast('设备绑定成功', 'success')

        // 添加设备到store
        addDevice({
          device_id: deviceId,
          device_name: deviceName,
          device_type: 'sleep_monitor',
          online: true,
          last_seen: Date.now(),
          firmware_version: '1.0.0'
        })

        // 延迟跳转到设备列表
        setTimeout(() => {
          Taro.navigateBack()
        }, 1500)
      } else {
        showToast(result.message || '绑定失败', 'error')
        setBinding(false)
        setBindProgress(0)
      }
    } catch (error: any) {
      console.error('绑定失败:', error)
      showToast('绑定失败，请重试', 'error')
      setBinding(false)
      setBindProgress(0)
    } finally {
      hideLoading()
    }
  }

  const handleCancel = () => {
    Taro.navigateBack()
  }

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  return (
    <View className='device-bind-page'>
      <View className='header-section'>
        <Text className='page-title'>绑定设备</Text>
        <Text className='page-desc'>选择绑定方式，将设备添加到您的账户</Text>
      </View>

      <View className='bind-method-section'>
        <View className='method-tabs'>
          <View
            className={`method-tab ${bindMethod === 'scan' ? 'active' : ''}`}
            onClick={() => setBindMethod('scan')}
          >
            <Text className='tab-text'>扫码绑定</Text>
          </View>
          <View
            className={`method-tab ${bindMethod === 'manual' ? 'active' : ''}`}
            onClick={() => setBindMethod('manual')}
          >
            <Text className='tab-text'>手动绑定</Text>
          </View>
        </View>
      </View>

      {bindMethod === 'scan' && (
        <View className='scan-section'>
          <View className='scan-content'>
            <View className='scan-icon'>
              <Text className='icon'>📷</Text>
            </View>
            <Text className='scan-title'>扫描设备二维码</Text>
            <Text className='scan-desc'>
              请确保设备已通电并进入配网模式，然后扫描设备上的二维码
            </Text>
          </View>

          <View className='scan-steps'>
            <View className='step-item'>
              <View className='step-number'>1</View>
              <Text className='step-text'>确保设备已通电</Text>
            </View>
            <View className='step-item'>
              <View className='step-number'>2</View>
              <Text className='step-text'>长按设备按钮进入配网模式</Text>
            </View>
            <View className='step-item'>
              <View className='step-number'>3</View>
              <Text className='step-text'>扫描设备二维码完成绑定</Text>
            </View>
          </View>

          <View className='scan-button' onClick={handleScanQRCode}>
            <Text className='button-text'>开始扫描</Text>
          </View>
        </View>
      )}

      {bindMethod === 'manual' && (
        <View className='manual-section'>
          <View className='form-section'>
            <View className='form-item'>
              <Text className='form-label'>设备ID</Text>
              <Input
                className='form-input'
                placeholder='请输入设备ID'
                value={deviceId}
                onInput={(e) => setDeviceId(e.detail.value)}
                disabled={binding}
              />
            </View>

            <View className='form-item'>
              <Text className='form-label'>绑定码</Text>
              <Input
                className='form-input'
                placeholder='请输入绑定码'
                value={bindingCode}
                onInput={(e) => setBindingCode(e.detail.value)}
                disabled={binding}
              />
              <Text className='form-hint'>绑定码可在设备标签或说明书中找到</Text>
            </View>

            <View className='form-item'>
              <Text className='form-label'>设备名称</Text>
              <Input
                className='form-input'
                placeholder='请输入设备名称，如：卧室'
                value={deviceName}
                onInput={(e) => setDeviceName(e.detail.value)}
                disabled={binding}
              />
            </View>
          </View>

          {binding && (
            <View className='binding-progress'>
              <View className='progress-bar'>
                <View
                  className='progress-fill'
                  style={{ width: `${bindProgress}%` }}
                />
              </View>
              <Text className='progress-text'>
                {bindProgress < 100 ? '正在绑定...' : '绑定成功！'}
              </Text>
            </View>
          )}

          <View className='action-buttons'>
            <View className='action-button cancel' onClick={handleCancel}>
              <Text className='button-text'>取消</Text>
            </View>
            <View
              className={`action-button confirm ${binding ? 'disabled' : ''}`}
              onClick={handleBindDevice}
            >
              <Text className='button-text'>
                {binding ? '绑定中...' : '确认绑定'}
              </Text>
            </View>
          </View>
        </View>
      )}

      <View className='help-section'>
        <Text className='help-title'>遇到问题？</Text>
        <Text className='help-text'>
          1. 确保设备已通电并进入配网模式
        </Text>
        <Text className='help-text'>
          2. 检查设备网络连接是否正常
        </Text>
        <Text className='help-text'>
          3. 确认绑定码输入正确
        </Text>
        <Text className='help-text'>
          4. 如仍有问题，请联系客服
        </Text>
      </View>
    </View>
  )
}

export default DeviceBindPage
