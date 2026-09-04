import { View, Text, Button } from '@tarojs/components'
import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { 
  initializeWebSocket, 
  disconnectWebSocket, 
  reconnectWebSocket,
  getWebSocketState,
  sendDeviceCommand,
  switchDevice,
  websocketService
} from '../services/websocket.service'
import { useUserStore, useDeviceStore, useSleepDataStore, useAlarmStore, useWebSocketStore } from '../store'
import { WebSocketState } from '../utils/websocket'

/**
 * WebSocket使用示例页面
 * 
 * 这个示例展示了如何在小程序中使用WebSocket实时数据接收功能
 */
export default function WebSocketExample() {
  const [wsState, setWsState] = useState<any>(null)
  const [isInitialized, setIsInitialized] = useState(false)

  // 从store获取数据
  const userStore = useUserStore()
  const deviceStore = useDeviceStore()
  const sleepDataStore = useSleepDataStore()
  const alarmStore = useAlarmStore()
  const wsStore = useWebSocketStore()

  // 初始化WebSocket连接
  useEffect(() => {
    initWebSocket()
    
    // 定期更新连接状态
    const interval = setInterval(() => {
      const state = getWebSocketState()
      setWsState(state)
    }, 1000)

    return () => {
      clearInterval(interval)
      disconnectWebSocket()
    }
  }, [])

  /**
   * 初始化WebSocket连接
   */
  const initWebSocket = async () => {
    try {
      await initializeWebSocket()
      setIsInitialized(true)
      Taro.showToast({
        title: 'WebSocket初始化成功',
        icon: 'success'
      })
    } catch (error) {
      console.error('WebSocket初始化失败:', error)
      Taro.showToast({
        title: 'WebSocket初始化失败',
        icon: 'error'
      })
    }
  }

  /**
   * 断开WebSocket连接
   */
  const handleDisconnect = () => {
    disconnectWebSocket()
    setIsInitialized(false)
  }

  /**
   * 重新连接WebSocket
   */
  const handleReconnect = async () => {
    try {
      await reconnectWebSocket()
      setIsInitialized(true)
    } catch (error) {
      console.error('重新连接失败:', error)
    }
  }

  /**
   * 切换设备
   */
  const handleSwitchDevice = async () => {
    if (deviceStore.devices.length === 0) {
      Taro.showToast({
        title: '没有可用的设备',
        icon: 'none'
      })
      return
    }

    // 选择第一个设备
    const device = deviceStore.devices[0]
    try {
      await switchDevice(device.device_id)
      Taro.showToast({
        title: `已切换到设备: ${device.device_name}`,
        icon: 'success'
      })
    } catch (error) {
      console.error('切换设备失败:', error)
    }
  }

  /**
   * 发送设备命令
   */
  const handleSendCommand = async () => {
    const currentDevice = deviceStore.currentDevice
    if (!currentDevice) {
      Taro.showToast({
        title: '请先选择设备',
        icon: 'none'
      })
      return
    }

    try {
      // 示例：发送灯光控制命令
      await sendDeviceCommand(currentDevice.device_id, 'set_light', {
        power: true,
        brightness: 80,
        color_temp: 4000
      })
    } catch (error) {
      console.error('发送命令失败:', error)
    }
  }

  /**
   * 获取连接状态文本
   */
  const getStateText = (state: WebSocketState): string => {
    switch (state) {
      case WebSocketState.DISCONNECTED:
        return '已断开'
      case WebSocketState.CONNECTING:
        return '连接中...'
      case WebSocketState.CONNECTED:
        return '已连接'
      case WebSocketState.RECONNECTING:
        return '重连中...'
      case WebSocketState.ERROR:
        return '连接错误'
      default:
        return '未知状态'
    }
  }

  return (
    <View className='websocket-example'>
      <View className='header'>
        <Text className='title'>WebSocket实时数据示例</Text>
      </View>

      {/* 连接状态 */}
      <View className='section'>
        <Text className='section-title'>连接状态</Text>
        <View className='status-card'>
          <View className='status-item'>
            <Text className='label'>连接状态:</Text>
            <Text className={`value ${wsStore.connected ? 'connected' : 'disconnected'}`}>
              {wsStore.connected ? '已连接' : '未连接'}
            </Text>
          </View>
          <View className='status-item'>
            <Text className='label'>详细状态:</Text>
            <Text className='value'>
              {wsState ? getStateText(wsState.state) : '未知'}
            </Text>
          </View>
          {wsState?.quality && (
            <>
              <View className='status-item'>
                <Text className='label'>延迟:</Text>
                <Text className='value'>{wsState.quality.latency}ms</Text>
              </View>
              <View className='status-item'>
                <Text className='label'>消息数:</Text>
                <Text className='value'>{wsState.quality.messageCount}</Text>
              </View>
              <View className='status-item'>
                <Text className='label'>错误数:</Text>
                <Text className='value'>{wsState.quality.errorCount}</Text>
              </View>
            </>
          )}
        </View>
      </View>

      {/* 控制按钮 */}
      <View className='section'>
        <Text className='section-title'>连接控制</Text>
        <View className='button-group'>
          {!isInitialized ? (
            <Button 
              className='control-button primary'
              onClick={initWebSocket}
            >
              初始化连接
            </Button>
          ) : (
            <>
              <Button 
                className='control-button'
                onClick={handleDisconnect}
              >
                断开连接
              </Button>
              <Button 
                className='control-button'
                onClick={handleReconnect}
              >
                重新连接
              </Button>
            </>
          )}
        </View>
      </View>

      {/* 设备控制 */}
      <View className='section'>
        <Text className='section-title'>设备控制</Text>
        <View className='button-group'>
          <Button 
            className='control-button'
            onClick={handleSwitchDevice}
          >
            切换设备
          </Button>
          <Button 
            className='control-button'
            onClick={handleSendCommand}
          >
            发送命令
          </Button>
        </View>
      </View>

      {/* 实时体征数据 */}
      <View className='section'>
        <Text className='section-title'>实时体征数据</Text>
        {sleepDataStore.realtimeData ? (
          <View className='data-card'>
            <View className='data-item'>
              <Text className='label'>心率:</Text>
              <Text className='value'>
                {sleepDataStore.realtimeData.heart_rate.value} {sleepDataStore.realtimeData.heart_rate.unit}
              </Text>
            </View>
            <View className='data-item'>
              <Text className='label'>呼吸率:</Text>
              <Text className='value'>
                {sleepDataStore.realtimeData.breathing_rate.value} {sleepDataStore.realtimeData.breathing_rate.unit}
              </Text>
            </View>
            <View className='data-item'>
              <Text className='label'>体动:</Text>
              <Text className='value'>
                {sleepDataStore.realtimeData.body_movement.value} {sleepDataStore.realtimeData.body_movement.unit}
              </Text>
            </View>
            <View className='data-item'>
              <Text className='label'>睡眠状态:</Text>
              <Text className='value'>
                {sleepDataStore.realtimeData.sleep_state.state} (置信度: {sleepDataStore.realtimeData.sleep_state.confidence}%)
              </Text>
            </View>
          </View>
        ) : (
          <Text className='no-data'>暂无实时数据</Text>
        )}
      </View>

      {/* 报警信息 */}
      <View className='section'>
        <Text className='section-title'>报警信息</Text>
        <View className='alarm-summary'>
          <Text className='label'>未读报警:</Text>
          <Text className='value alarm-count'>{alarmStore.unreadCount}</Text>
        </View>
        {alarmStore.alarms.length > 0 && (
          <View className='alarm-list'>
            {alarmStore.alarms.slice(0, 5).map((alarm, index) => (
              <View key={alarm.alarm_id || index} className={`alarm-item ${alarm.level}`}>
                <Text className='alarm-type'>{alarm.type}</Text>
                <Text className='alarm-message'>{alarm.message}</Text>
                <Text className='alarm-time'>
                  {new Date(alarm.timestamp).toLocaleString()}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* 当前设备信息 */}
      <View className='section'>
        <Text className='section-title'>当前设备</Text>
        {deviceStore.currentDevice ? (
          <View className='device-card'>
            <Text className='device-name'>{deviceStore.currentDevice.device_name}</Text>
            <Text className='device-id'>ID: {deviceStore.currentDevice.device_id}</Text>
            <Text className={`device-status ${deviceStore.currentDevice.online ? 'online' : 'offline'}`}>
              {deviceStore.currentDevice.online ? '在线' : '离线'}
            </Text>
          </View>
        ) : (
          <Text className='no-data'>未选择设备</Text>
        )}
      </View>
    </View>
  )
}
