import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, Input, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading } from '../../utils/util'
import './index.scss'

const SERVICE_UUID = '0000A100-0000-1000-8000-00805F9B34FB'
const WRITE_UUID = '0000A101-0000-1000-8000-00805F9B34FB'
const STATUS_UUID = '0000A102-0000-1000-8000-00805F9B34FB'

type ProvisionStep = 'idle' | 'scanning' | 'sending' | 'router' | 'server' | 'success' | 'error'

interface BleDevice {
  deviceId: string
  name: string
  RSSI?: number
}

const encoder = (text: string) => {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i)
  }
  return bytes.buffer
}

const DeviceProvisionPage: React.FC = () => {
  const [devices, setDevices] = useState<BleDevice[]>([])
  const [selected, setSelected] = useState<BleDevice | null>(null)
  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [step, setStep] = useState<ProvisionStep>('idle')
  const [statusText, setStatusText] = useState('长按设备 BOOT/配网键 5 秒，让台灯进入配网模式')
  const [bindToken, setBindToken] = useState('')

  const progress = useMemo(() => {
    const index = ['idle', 'scanning', 'sending', 'router', 'server', 'success'].indexOf(step)
    return Math.max(0, Math.min(100, Math.round((index / 5) * 100)))
  }, [step])

  useEffect(() => {
    return () => {
      Taro.stopBluetoothDevicesDiscovery().catch(() => undefined)
      Taro.closeBluetoothAdapter().catch(() => undefined)
    }
  }, [])

  const startScan = async () => {
    try {
      setStep('scanning')
      setStatusText('正在扫描附近的 SleepLamp 设备')
      setDevices([])
      await Taro.openBluetoothAdapter()
      await Taro.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: false,
        services: [SERVICE_UUID]
      })
      Taro.onBluetoothDeviceFound((result) => {
        const found = result.devices
          .map((item: any) => ({
            deviceId: item.deviceId,
            name: item.name || item.localName || '',
            RSSI: item.RSSI
          }))
          .filter((item) => item.name.startsWith('SleepLamp-'))

        if (found.length === 0) return
        setDevices((prev) => {
          const next = [...prev]
          found.forEach((item) => {
            const idx = next.findIndex((old) => old.deviceId === item.deviceId)
            if (idx >= 0) next[idx] = item
            else next.push(item)
          })
          return next.sort((a, b) => (b.RSSI || -100) - (a.RSSI || -100))
        })
      })
    } catch (error) {
      console.error('BLE scan failed:', error)
      setStep('error')
      setStatusText('蓝牙不可用，请确认手机蓝牙和微信蓝牙权限已开启')
      showToast('蓝牙扫描失败', 'error')
    }
  }

  const connectAndProvision = async () => {
    if (!selected) {
      showToast('请选择台灯设备', 'error')
      return
    }
    if (!ssid.trim()) {
      showToast('请输入 2.4G WiFi 名称', 'error')
      return
    }
    if (ssid.includes('_5G') || ssid.includes('5G')) {
      showToast('ESP32-S3 只支持 2.4G WiFi，请选择 2.4G 网络', 'error')
      return
    }

    try {
      setStep('sending')
      showLoading('发送配网信息...')

      const tokenResult = await api.device.createProvisioningToken()
      if (tokenResult.code !== 200) {
        throw new Error(tokenResult.message || '生成绑定 token 失败')
      }
      const token = tokenResult.data.bindToken || tokenResult.data.bind_token
      setBindToken(token)

      await Taro.stopBluetoothDevicesDiscovery()
      await Taro.createBLEConnection({ deviceId: selected.deviceId, timeout: 10000 })
      try {
        await Taro.setBLEMTU({ deviceId: selected.deviceId, mtu: 247 })
      } catch (error) {
        console.warn('setBLEMTU skipped:', error)
      }

      await Taro.notifyBLECharacteristicValueChange({
        deviceId: selected.deviceId,
        serviceId: SERVICE_UUID,
        characteristicId: STATUS_UUID,
        state: true
      })

      Taro.onBLECharacteristicValueChange((event) => {
        if (event.deviceId !== selected.deviceId || event.characteristicId.toUpperCase() !== STATUS_UUID) {
          return
        }
        const text = String.fromCharCode(...new Uint8Array(event.value))
        try {
          const parsed = JSON.parse(text)
          if (parsed.state === 'connecting_router') {
            setStep('router')
            setStatusText('设备正在连接路由器')
          } else if (parsed.state === 'wifi_connected') {
            setStep('server')
            setStatusText('设备已联网，等待服务器确认')
          } else if (parsed.state === 'wifi_failed') {
            setStep('error')
            setStatusText('WiFi 连接失败，请检查密码、信号和 2.4G 网络')
          } else {
            setStatusText(parsed.detail || parsed.state || text)
          }
        } catch {
          setStatusText(text)
        }
      })

      const payload = JSON.stringify({
        ssid: ssid.trim(),
        password,
        bindToken: token
      })
      await Taro.writeBLECharacteristicValue({
        deviceId: selected.deviceId,
        serviceId: SERVICE_UUID,
        characteristicId: WRITE_UUID,
        value: encoder(payload)
      })

      setStep('router')
      setStatusText('设备正在连接路由器，请稍等')
      await waitForServerBinding(token)
    } catch (error: any) {
      console.error('Provisioning failed:', error)
      setStep('error')
      setStatusText(error.message || '配网失败，请重试')
      showToast('配网失败', 'error')
    } finally {
      hideLoading()
    }
  }

  const waitForServerBinding = async (token: string) => {
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      setStep('server')
      const result = await api.device.completeProvisioning({ bindToken: token })
      if (result.code === 200) {
        setStep('success')
        setStatusText('绑定成功，设备已加入当前账号')
        showToast('添加成功', 'success')
        setTimeout(() => Taro.navigateBack(), 1200)
        return
      }
    }
    throw new Error('服务器未收到设备上线信息，请确认 MQTT 和后端服务可用')
  }

  return (
    <View className='device-provision-page'>
      <ScrollView scrollY className='scroll'>
        <View className='header'>
          <Text className='title'>添加智能台灯</Text>
          <Text className='subtitle'>通过 BLE 把家里的 2.4G WiFi 写入设备</Text>
        </View>

        <View className='progress'>
          <View className='progress-fill' style={{ width: `${progress}%` }} />
        </View>
        <Text className={`status ${step}`}>{statusText}</Text>

        <View className='section'>
          <View className='section-title-row'>
            <Text className='section-title'>附近设备</Text>
            <View className='small-button' onClick={startScan}>
              <Text>{step === 'scanning' ? '扫描中' : '扫描'}</Text>
            </View>
          </View>
          {devices.length === 0 ? (
            <Text className='empty'>还没有发现设备，请确认台灯正在慢闪等待配网</Text>
          ) : (
            devices.map((device) => (
              <View
                key={device.deviceId}
                className={`device-row ${selected?.deviceId === device.deviceId ? 'active' : ''}`}
                onClick={() => setSelected(device)}
              >
                <View>
                  <Text className='device-name'>{device.name}</Text>
                  <Text className='device-id'>{device.deviceId}</Text>
                </View>
                <Text className='rssi'>{device.RSSI || '-'} dBm</Text>
              </View>
            ))
          )}
        </View>

        <View className='section'>
          <Text className='section-title'>家庭 WiFi</Text>
          <Input className='input' placeholder='2.4G WiFi 名称' value={ssid} onInput={(e) => setSsid(e.detail.value)} />
          <Input className='input' password placeholder='WiFi 密码' value={password} onInput={(e) => setPassword(e.detail.value)} />
          <Text className='hint'>ESP32-S3 不支持 5G WiFi；上市版本不会写死公司 WiFi。</Text>
        </View>

        <View className={`primary-button ${step === 'sending' || step === 'router' || step === 'server' ? 'disabled' : ''}`} onClick={connectAndProvision}>
          <Text>开始配网并绑定</Text>
        </View>

        {bindToken && (
          <Text className='token-hint'>绑定 token 已生成，设备上线后自动完成绑定。</Text>
        )}
      </ScrollView>
    </View>
  )
}

export default DeviceProvisionPage
