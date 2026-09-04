import React, { useEffect, useMemo, useState } from 'react'
import { Image, Picker, ScrollView, Slider, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useAlarmStore, useDeviceStore, useSleepDataStore, useUserStore } from '../../store'
import { api } from '../../utils/api'
import { subscribeAlarm, subscribeVitalSigns, wsClient } from '../../utils/websocket'
import { hideLoading, showLoading, showToast } from '../../utils/util'
import type { DeviceInfo, LightAlarm, LightScene, VitalSigns } from '../../types'
import Loading from '../../components/Loading'
import './index.scss'

// eslint-disable-next-line import/no-commonjs -- Taro static asset import (resolved at build time)
const homeBg = require('../../assets/figma/home-bg.jpg') as string
// eslint-disable-next-line import/no-commonjs -- Taro static asset import (resolved at build time)
const lampHigh = require('../../assets/figma/lamp-high.png') as string
// eslint-disable-next-line import/no-commonjs -- Taro static asset import (resolved at build time)
const lampMed = require('../../assets/figma/lamp-med.png') as string
// eslint-disable-next-line import/no-commonjs -- Taro static asset import (resolved at build time)
const lampOff = require('../../assets/figma/lamp-off.png') as string

const COLOR_TEMP_MIN = 2700
const COLOR_TEMP_MAX = 6500
const LIGHT_ALARMS_KEY = 'light_alarms'

const PRESET_SCENES: LightScene[] = [
  {
    id: 'sleep',
    name: '助眠',
    brightness: 20,
    colorTemp: 2700,
    icon: 'sleep',
    description: '低亮暖光'
  },
  {
    id: 'reading',
    name: '阅读',
    brightness: 80,
    colorTemp: 4200,
    icon: 'read',
    description: '清晰自然光'
  },
  {
    id: 'relax',
    name: '放松',
    brightness: 45,
    colorTemp: 3200,
    icon: 'relax',
    description: '柔和氛围'
  },
  {
    id: 'work',
    name: '工作',
    brightness: 90,
    colorTemp: 5600,
    icon: 'work',
    description: '高亮冷白'
  }
]

const ALARM_MODES = [
  { label: '柔和唤醒', brightness: 50, colorTemp: 3000 },
  { label: '强力唤醒', brightness: 100, colorTemp: 5200 },
  { label: '助眠模式', brightness: 15, colorTemp: 2700 }
]

const clamp = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

const normalizeColorTemp = (value?: number) => {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return 4000

  if (numericValue >= 0 && numericValue <= 100) {
    return Math.round(COLOR_TEMP_MIN + (numericValue / 100) * (COLOR_TEMP_MAX - COLOR_TEMP_MIN))
  }

  return clamp(Math.round(numericValue), COLOR_TEMP_MIN, COLOR_TEMP_MAX)
}

const colorTempToPercent = (value: number) => {
  const normalized = normalizeColorTemp(value)
  return Math.round(((normalized - COLOR_TEMP_MIN) / (COLOR_TEMP_MAX - COLOR_TEMP_MIN)) * 100)
}

const percentToColorTemp = (value: number) => {
  const percent = clamp(Number(value), 0, 100)
  return Math.round(COLOR_TEMP_MIN + (percent / 100) * (COLOR_TEMP_MAX - COLOR_TEMP_MIN))
}

const formatColorTone = (value: number) => {
  if (value < 3200) return '暖光'
  if (value < 4600) return '自然光'
  if (value < 5800) return '冷白光'
  return '清冷光'
}

const formatSleepState = (state?: string) => {
  const stateMap: Record<string, string> = {
    awake: '清醒',
    light_sleep: '浅睡',
    deep_sleep: '深睡',
    rem_sleep: '快速眼动',
    unknown: '等待识别'
  }
  return stateMap[state || 'unknown'] || state || '等待识别'
}

const getGreeting = () => {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

const getVitalNumber = (data: VitalSigns | null, key: 'heart_rate' | 'breathing_rate') => {
  const value = data?.[key]?.value
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

const getLightFromDevice = (device: DeviceInfo | null) => {
  return device?.status?.light || device?.light_state
}

const IndexPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [brightness, setBrightness] = useState(50)
  const [colorTemp, setColorTemp] = useState(4000)
  const [lightPower, setLightPower] = useState(false)
  const [alarms, setAlarms] = useState<LightAlarm[]>([])
  const [alarmModalVisible, setAlarmModalVisible] = useState(false)
  const [alarmTime, setAlarmTime] = useState('07:00')
  const [alarmModeIndex, setAlarmModeIndex] = useState(0)
  const [lastSyncText, setLastSyncText] = useState('等待设备同步')

  const { userInfo, isAuthenticated } = useUserStore()
  const { currentDevice, setCurrentDevice } = useDeviceStore()
  const { realtimeData, setRealtimeData } = useSleepDataStore()
  const { alarms: systemAlarms, unreadCount } = useAlarmStore()

  const tempPercent = useMemo(() => colorTempToPercent(colorTemp), [colorTemp])
  const heartRate = getVitalNumber(realtimeData, 'heart_rate')
  const breathingRate = getVitalNumber(realtimeData, 'breathing_rate')
  const motionValue = Number(realtimeData?.body_movement?.value || 0)
  const sleepState = realtimeData?.sleep_state?.state
  const activeScene = PRESET_SCENES.find((scene) => (
    scene.brightness === brightness && scene.colorTemp === colorTemp && lightPower
  ))
  const lampSrc = !lightPower ? lampOff : brightness > 60 ? lampHigh : lampMed
  const deviceLight = getLightFromDevice(currentDevice)

  useEffect(() => {
    Taro.hideTabBar({ animation: false }).catch(() => undefined)

    if (!isAuthenticated) {
      Taro.redirectTo({ url: '/pages/login/index' })
      return () => {
        Taro.showTabBar({ animation: false }).catch(() => undefined)
      }
    }

    initPage()

    return () => {
      Taro.showTabBar({ animation: false }).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (!isAuthenticated || !currentDevice) return

    initWebSocket()
    fetchRealtimeData(currentDevice.device_id)

    return () => {
      wsClient.disconnect()
    }
  }, [isAuthenticated, currentDevice?.device_id])

  const syncLightState = (device: DeviceInfo) => {
    const light = getLightFromDevice(device)
    if (!light) return

    setBrightness(clamp(Number(light.brightness ?? 50), 0, 100))
    setColorTemp(normalizeColorTemp(light.color_temp))
    setLightPower(Boolean(light.power ?? light.on))
    setLastSyncText('已同步设备状态')
  }

  const initPage = async () => {
    try {
      showLoading('加载设备...')

      const devicesResult = await api.device.getDevices()
      const devices = devicesResult.data?.devices || []

      if (devicesResult.code === 200 && devices.length > 0) {
        const firstDevice = devices[0]
        setCurrentDevice(firstDevice)
        syncLightState(firstDevice)
        await fetchRealtimeData(firstDevice.device_id)
      } else {
        setLastSyncText('还没有绑定设备')
      }

      const savedAlarms = Taro.getStorageSync(LIGHT_ALARMS_KEY)
      setAlarms(Array.isArray(savedAlarms) ? savedAlarms : [])
    } catch (error: any) {
      console.error('初始化首页失败:', error)
      showToast('加载失败，请检查本地服务器', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const initWebSocket = async () => {
    try {
      const token = api.getToken()
      if (!token || !currentDevice) return

      await wsClient.connect({
        token,
        deviceId: currentDevice.device_id
      })

      subscribeVitalSigns((data) => {
        setRealtimeData(data)
      })

      subscribeAlarm((alarm) => {
        useAlarmStore.getState().addAlarm(alarm)
      })
    } catch (error: any) {
      console.error('WebSocket连接失败:', error)
    }
  }

  const fetchRealtimeData = async (deviceId: string) => {
    try {
      const result = await api.sleep.getRealtimeData(deviceId)
      if (result.code === 200 && result.data) {
        setRealtimeData(result.data)
      }
    } catch (error) {
      console.warn('实时体征暂不可用:', error)
    }
  }

  const sendLightCommand = async (params: {
    power?: boolean
    brightness?: number
    color_temp?: number
    scene?: string
  }) => {
    if (!currentDevice) {
      showToast('请先绑定设备', 'error')
      return
    }

    const nextBrightness = clamp(Number(params.brightness ?? brightness), 0, 100)
    const nextColorTemp = normalizeColorTemp(params.color_temp ?? colorTemp)
    const nextPower = Boolean(params.power ?? lightPower)

    try {
      await api.device.sendCommand(
        currentDevice.device_id,
        'light_control',
        {
          power: nextPower,
          brightness: nextBrightness,
          color_temp: nextColorTemp,
          scene: params.scene,
          source: 'app'
        },
        5000
      )
      setLastSyncText('小程序已通过 MQTT 下发')
    } catch (error: any) {
      console.error('发送灯光指令失败:', error)
      setLastSyncText('指令下发失败')
      showToast('控制失败，请检查设备在线状态', 'error')
    }
  }

  const handleLampTap = async () => {
    const nextPower = !lightPower
    const nextBrightness = nextPower && brightness === 0 ? 50 : brightness

    setLightPower(nextPower)
    setBrightness(nextBrightness)
    await sendLightCommand({ power: nextPower, brightness: nextBrightness })
  }

  const handleBrightnessChange = async (event: any) => {
    const nextBrightness = clamp(Number(event.detail.value), 0, 100)
    const nextPower = nextBrightness > 0

    setBrightness(nextBrightness)
    setLightPower(nextPower)
    await sendLightCommand({ brightness: nextBrightness, power: nextPower })
  }

  const handleColorTempChange = async (event: any) => {
    const nextColorTemp = percentToColorTemp(event.detail.value)

    setColorTemp(nextColorTemp)
    setLightPower(true)
    await sendLightCommand({ color_temp: nextColorTemp, power: true })
  }

  const handleSceneSelect = async (scene: LightScene) => {
    setBrightness(scene.brightness)
    setColorTemp(scene.colorTemp)
    setLightPower(true)
    await sendLightCommand({
      power: true,
      brightness: scene.brightness,
      color_temp: scene.colorTemp,
      scene: scene.id
    })
    showToast(`已切换到${scene.name}`, 'success')
  }

  const saveAlarms = (nextAlarms: LightAlarm[]) => {
    setAlarms(nextAlarms)
    Taro.setStorageSync(LIGHT_ALARMS_KEY, nextAlarms)
  }

  const handleAddAlarm = () => {
    const mode = ALARM_MODES[alarmModeIndex]
    const nextAlarm: LightAlarm = {
      alarm_id: `alarm_${Date.now()}`,
      time: alarmTime,
      enabled: true,
      repeat_days: [1, 2, 3, 4, 5],
      fade_duration: 20,
      target_brightness: mode.brightness,
      target_color_temp: mode.colorTemp,
      type: 'light',
      label: mode.label
    }

    saveAlarms([nextAlarm, ...alarms])
    setAlarmModalVisible(false)
    showToast('光闹钟已添加', 'success')
  }

  const handleToggleAlarm = (alarmId: string) => {
    saveAlarms(alarms.map((alarm) => (
      alarm.alarm_id === alarmId ? { ...alarm, enabled: !alarm.enabled } : alarm
    )))
  }

  const handleViewHistory = () => {
    Taro.switchTab({ url: '/pages/history/index' })
  }

  const handleViewReport = () => {
    if (!currentDevice) {
      showToast('请先绑定设备', 'error')
      return
    }
    Taro.navigateTo({ url: `/pages/sleep-report/index?deviceId=${currentDevice.device_id}` })
  }

  const handleViewProfile = () => {
    Taro.switchTab({ url: '/pages/profile/index' })
  }

  const handleViewDevice = () => {
    if (!currentDevice) {
      Taro.navigateTo({ url: '/pages/device-provision/index' })
      return
    }
    Taro.navigateTo({ url: `/pages/device/index?deviceId=${currentDevice.device_id}` })
  }

  const renderVitalCard = (
    className: string,
    label: string,
    value: string | number,
    unit: string,
    status?: string
  ) => (
    <View className={`vital-chip ${className}`}>
      <Text className='vital-label'>{label}</Text>
      <View className='vital-value-row'>
        <Text className='vital-value'>{value}</Text>
        {unit && <Text className='vital-unit'>{unit}</Text>}
      </View>
      {status && <Text className='vital-status'>{status}</Text>}
    </View>
  )

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  return (
    <View className='figma-home'>
      <Image className={`figma-bg ${lightPower ? 'is-on' : 'is-off'}`} src={homeBg} mode='aspectFill' />
      <View className='figma-overlay' />

      <ScrollView scrollY className='figma-scroll' showScrollbar={false}>
        <View className='wechat-capsule'>
          <View className='capsule-more'>
            <View className='capsule-dot small' />
            <View className='capsule-dot' />
            <View className='capsule-dot small' />
          </View>
          <View className='capsule-divider' />
          <View className='capsule-circle'>
            <View className='capsule-circle-core' />
          </View>
        </View>

        <View className='home-header'>
          <View>
            <Text className='greeting'>{getGreeting()}，{userInfo?.nickname || '用户'}</Text>
            <Text className='subtitle'>智能睡眠台灯</Text>
          </View>
          <View className='device-pill' onClick={handleViewDevice}>
            <View className={`device-dot ${currentDevice?.online ? 'online' : 'offline'}`} />
            <Text className='device-pill-text'>{currentDevice?.online ? '在线' : '离线'}</Text>
          </View>
        </View>

        <View className='device-glance'>
          <Text className='device-name'>{currentDevice?.device_name || currentDevice?.device_id || '未绑定设备'}</Text>
          <Text className='device-sync'>{lastSyncText}</Text>
        </View>

        <View className='scene-row'>
          {PRESET_SCENES.slice(0, 2).map((scene) => (
            <View
              key={scene.id}
              className={`scene-pill ${activeScene?.id === scene.id ? 'active' : ''}`}
              onClick={() => handleSceneSelect(scene)}
            >
              <Text className='scene-pill-mark'>{scene.name.slice(0, 1)}</Text>
              <Text className='scene-pill-text'>{scene.name}</Text>
            </View>
          ))}
        </View>

        <View className='alarm-glass'>
          <View className='alarm-header'>
            <Text className='alarm-title'>光闹钟</Text>
            <View className='alarm-add' onClick={() => setAlarmModalVisible(true)}>
              <Text className='alarm-add-text'>+</Text>
            </View>
          </View>
          {alarms.length === 0 ? (
            <View className='alarm-empty'>
              <Text className='alarm-empty-text'>点击右上角添加光闹钟</Text>
            </View>
          ) : (
            <View className='alarm-list'>
              {alarms.slice(0, 2).map((alarm) => (
                <View key={alarm.alarm_id} className='alarm-item'>
                  <View>
                    <Text className={`alarm-time ${alarm.enabled ? '' : 'disabled'}`}>{alarm.time}</Text>
                    <Text className='alarm-mode'>{alarm.label || '柔和唤醒'}</Text>
                  </View>
                  <View
                    className={`alarm-switch ${alarm.enabled ? 'on' : ''}`}
                    onClick={() => handleToggleAlarm(alarm.alarm_id)}
                  >
                    <View className='alarm-switch-dot' />
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>

        <View className='lamp-stage'>
          {lightPower && (
            <View className='ripples'>
              <View className='ripple one' />
              <View className='ripple two' />
            </View>
          )}
          <View className={`lamp-arc arc-brightness ${lightPower ? 'active' : ''}`} />
          <View className={`lamp-arc arc-temp ${lightPower ? 'active' : ''}`} />
          <View className='lamp-touch' onClick={handleLampTap}>
            <Image className='lamp-image' src={lampSrc} mode='widthFix' />
            <View className='lamp-state-card'>
              <Text className='lamp-state'>{lightPower ? '已开启' : '已关闭'}</Text>
              <Text className='lamp-percent'>{lightPower ? `${brightness}%` : 'OFF'}</Text>
            </View>
          </View>
        </View>

        <View className='control-glass'>
          <View className='control-header'>
            <Text className='control-title'>灯光控制</Text>
            <Text className='control-source'>{deviceLight ? '同一套灯光状态' : '等待设备状态'}</Text>
          </View>

          <View className='control-row'>
            <View className='control-meta'>
              <Text className='control-label'>亮度</Text>
              <Text className='control-value'>{brightness}%</Text>
            </View>
            <Slider
              className='figma-slider brightness-slider'
              value={brightness}
              min={0}
              max={100}
              step={1}
              activeColor='#D8C6E0'
              backgroundColor='rgba(255,255,255,0.45)'
              blockColor='#ffffff'
              blockSize={22}
              showValue={false}
              onChange={handleBrightnessChange}
            />
          </View>

          <View className='control-row'>
            <View className='control-meta'>
              <Text className='control-label'>色温</Text>
              <Text className='control-value'>{formatColorTone(colorTemp)} · {colorTemp}K</Text>
            </View>
            <Slider
              className='figma-slider temp-slider'
              value={tempPercent}
              min={0}
              max={100}
              step={1}
              activeColor='#8264A2'
              backgroundColor='rgba(255,255,255,0.45)'
              blockColor='#ffffff'
              blockSize={22}
              showValue={false}
              onChange={handleColorTempChange}
            />
          </View>

          <View className='scene-grid'>
            {PRESET_SCENES.map((scene) => (
              <View
                key={scene.id}
                className={`scene-card ${activeScene?.id === scene.id ? 'active' : ''}`}
                onClick={() => handleSceneSelect(scene)}
              >
                <Text className='scene-name'>{scene.name}</Text>
                <Text className='scene-desc'>{scene.description}</Text>
              </View>
            ))}
          </View>
        </View>

        <View className='vitals-glass'>
          <View className='section-title-row'>
            <Text className='section-title'>实时体征</Text>
            <Text className='section-link' onClick={handleViewHistory}>查看数据</Text>
          </View>
          <View className='vital-grid'>
            {renderVitalCard('heart', '心率', heartRate || '--', heartRate ? 'bpm' : '', heartRate ? '雷达上报' : '等待')}
            {renderVitalCard('breath', '呼吸', breathingRate || '--', breathingRate ? '次/分' : '', breathingRate ? '实时' : '等待')}
            {renderVitalCard('motion', '体动', motionValue.toFixed(1), '级', motionValue > 0 ? '有人活动' : '平稳')}
            {renderVitalCard('sleep', '睡眠', formatSleepState(sleepState), '', realtimeData ? '毫米波识别' : '等待')}
          </View>
        </View>

        <View className='quick-grid'>
          <View className='quick-card' onClick={handleViewReport}>
            <Text className='quick-title'>睡眠报告</Text>
            <Text className='quick-desc'>查看整晚趋势</Text>
          </View>
          <View className='quick-card' onClick={handleViewDevice}>
            <Text className='quick-title'>设备管理</Text>
            <Text className='quick-desc'>{currentDevice ? '查看连接详情' : '添加设备'}</Text>
          </View>
          <View className='quick-card alert' onClick={() => Taro.navigateTo({ url: '/pages/alarm/index' })}>
            <Text className='quick-title'>告警记录</Text>
            <Text className='quick-desc'>{unreadCount > 0 ? `${unreadCount} 条未读` : systemAlarms.length > 0 ? '查看告警' : '暂无新告警'}</Text>
          </View>
        </View>
      </ScrollView>

      <View className='figma-bottom-nav'>
        <View className='nav-item active'>
          <View className='nav-icon home-shape' />
          <Text className='nav-text'>首页</Text>
        </View>
        <View className='nav-item' onClick={handleViewReport}>
          <View className='nav-icon moon-shape' />
          <Text className='nav-text'>入睡</Text>
        </View>
        <View className='nav-item' onClick={handleViewHistory}>
          <View className='nav-icon calendar-shape' />
          <Text className='nav-text'>打卡</Text>
        </View>
        <View className='nav-item' onClick={handleViewProfile}>
          <View className='nav-icon user-shape' />
          <Text className='nav-text'>我的</Text>
        </View>
      </View>

      {alarmModalVisible && (
        <View className='alarm-modal' onClick={() => setAlarmModalVisible(false)}>
          <View className='alarm-sheet' onClick={(event) => event.stopPropagation()}>
            <View className='sheet-handle' />
            <View className='sheet-header'>
              <Text className='sheet-title'>新建光闹钟</Text>
              <View className='sheet-close' onClick={() => setAlarmModalVisible(false)}>
                <Text className='sheet-close-text'>×</Text>
              </View>
            </View>

            <View className='sheet-field'>
              <Text className='sheet-label'>唤醒时间</Text>
              <Picker mode='time' value={alarmTime} onChange={(event) => setAlarmTime(event.detail.value)}>
                <View className='sheet-input'>
                  <Text>{alarmTime}</Text>
                  <Text className='sheet-input-arrow'>⌄</Text>
                </View>
              </Picker>
            </View>

            <View className='sheet-field'>
              <Text className='sheet-label'>模式</Text>
              <Picker
                mode='selector'
                range={ALARM_MODES.map((mode) => mode.label)}
                value={alarmModeIndex}
                onChange={(event) => setAlarmModeIndex(Number(event.detail.value))}
              >
                <View className='sheet-input'>
                  <Text>{ALARM_MODES[alarmModeIndex].label}</Text>
                  <Text className='sheet-input-arrow'>⌄</Text>
                </View>
              </Picker>
            </View>

            <View className='sheet-save' onClick={handleAddAlarm}>
              <Text className='sheet-save-text'>确认添加</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}

export default IndexPage
