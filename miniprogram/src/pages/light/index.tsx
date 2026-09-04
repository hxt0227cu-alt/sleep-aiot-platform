import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, Slider, Switch } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading } from '../../utils/util'
import Loading from '../../components/Loading'
import './index.scss'

type Scene = 'reading' | 'sleep' | 'night' | 'custom'

const scenes: Array<{ id: Scene; name: string; brightness: number; colorTemp: number }> = [
  { id: 'reading', name: '阅读', brightness: 90, colorTemp: 5000 },
  { id: 'sleep', name: '助眠', brightness: 25, colorTemp: 2700 },
  { id: 'night', name: '夜灯', brightness: 10, colorTemp: 2700 },
  { id: 'custom', name: '自定义', brightness: 60, colorTemp: 4000 },
]

const getDeviceId = (device: any) => device?.device_id || device?.deviceId
const getDeviceName = (device: any) => device?.device_name || device?.deviceName || '智能台灯'

const LightControlPage: React.FC = () => {
  const { currentDevice } = useDeviceStore()
  const [loading, setLoading] = useState(true)
  const [power, setPower] = useState(false)
  const [brightness, setBrightness] = useState(60)
  const [colorTemp, setColorTemp] = useState(4000)
  const [scene, setScene] = useState<Scene>('custom')
  const [source, setSource] = useState('app')

  const deviceId = useMemo(() => getDeviceId(currentDevice), [currentDevice])
  const online = Boolean((currentDevice as any)?.online)

  useEffect(() => {
    if (!deviceId) {
      showToast('请先选择设备', 'error')
      Taro.navigateBack()
      return
    }
    loadLightState()
  }, [deviceId])

  const loadLightState = async () => {
    if (!deviceId) return

    try {
      setLoading(true)
      showLoading('加载灯光状态')
      const result = await api.device.getDeviceDetail(deviceId)
      if (result.code === 200) {
        const detail: any = result.data
        const state = detail.light_state || detail.config?.light_state || detail.status?.light || {}
        setPower(Boolean(state.power ?? state.on ?? false))
        setBrightness(Number(state.brightness ?? 60))
        setColorTemp(Number(state.color_temp ?? state.colorTemp ?? 4000))
        setScene((state.scene as Scene) || 'custom')
        setSource(state.source || 'device')
      }
    } catch (error) {
      console.error('load light state failed', error)
      showToast('灯光状态加载失败', 'error')
    } finally {
      hideLoading()
      setLoading(false)
    }
  }

  const sendLightCommand = async (params: Record<string, any>) => {
    if (!deviceId) return

    try {
      const result = await api.device.sendCommand(deviceId, 'light_control', {
        ...params,
        source: 'app',
      }, 8000)

      if (result.code !== 200) {
        showToast(result.message || '指令发送失败', 'error')
      }
    } catch (error) {
      console.error('send light command failed', error)
      showToast('设备暂不可用', 'error')
    }
  }

  const handlePower = async (value: boolean) => {
    setPower(value)
    setSource('app')
    await sendLightCommand({ power: value })
  }

  const handleBrightness = async (value: number) => {
    const next = Math.max(0, Math.min(100, Number(value)))
    setBrightness(next)
    setScene('custom')
    setSource('app')
    await sendLightCommand({ power: next > 0, brightness: next })
  }

  const handleColorTemp = async (value: number) => {
    const next = Math.max(2700, Math.min(6500, Number(value)))
    setColorTemp(next)
    setScene('custom')
    setSource('app')
    await sendLightCommand({ power: true, color_temp: next })
  }

  const applyScene = async (nextScene: Scene) => {
    const preset = scenes.find(item => item.id === nextScene)
    if (!preset) return

    setPower(true)
    setBrightness(preset.brightness)
    setColorTemp(preset.colorTemp)
    setScene(nextScene)
    setSource('app')
    await sendLightCommand({
      power: true,
      scene: nextScene,
      brightness: preset.brightness,
      color_temp: preset.colorTemp,
    })
  }

  if (loading) {
    return <Loading text='加载中' size='large' />
  }

  return (
    <View className='light-page'>
      <View className='light-hero'>
        <View className='top-row'>
          <View>
            <Text className='device-name'>{getDeviceName(currentDevice)}</Text>
            <Text className={`device-state ${online ? 'online' : 'offline'}`}>
              {online ? '在线' : '离线'} · {source}
            </Text>
          </View>
          <Switch checked={power} disabled={!online} onChange={event => handlePower(event.detail.value)} />
        </View>

        <View className={`lamp-stage ${power ? 'on' : 'off'}`}>
          <View className='ripple ripple-a' />
          <View className='ripple ripple-b' />
          <View className='lamp-body'>
            <Text className='lamp-cap' />
            <Text className='lamp-glow' />
            <Text className='lamp-base' />
          </View>
        </View>

        <View className='metrics-row'>
          <View className='metric'>
            <Text className='metric-value'>{brightness}%</Text>
            <Text className='metric-label'>亮度</Text>
          </View>
          <View className='metric'>
            <Text className='metric-value'>{colorTemp}K</Text>
            <Text className='metric-label'>色温</Text>
          </View>
        </View>
      </View>

      <View className='control-panel'>
        <View className='slider-card'>
          <View className='card-header'>
            <Text className='label'>亮度</Text>
            <Text className='value'>{brightness}%</Text>
          </View>
          <Slider value={brightness} min={0} max={100} step={1} disabled={!online} onChange={event => handleBrightness(event.detail.value)} />
        </View>

        <View className='slider-card'>
          <View className='card-header'>
            <Text className='label'>色温</Text>
            <Text className='value'>{colorTemp}K</Text>
          </View>
          <Slider value={colorTemp} min={2700} max={6500} step={100} disabled={!online} onChange={event => handleColorTemp(event.detail.value)} />
        </View>

        <View className='scene-grid'>
          {scenes.map(item => (
            <View
              key={item.id}
              className={`scene-tile ${scene === item.id ? 'active' : ''}`}
              onClick={() => online && applyScene(item.id)}
            >
              <Text className='scene-name'>{item.name}</Text>
              <Text className='scene-meta'>{item.brightness}% · {item.colorTemp}K</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  )
}

export default LightControlPage
