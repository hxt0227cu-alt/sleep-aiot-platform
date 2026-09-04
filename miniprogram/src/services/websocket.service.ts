import Taro from '@tarojs/taro'
import { wsClient, WebSocketState, subscribeVitalSigns, subscribeDeviceVitalSigns, subscribeAlarm, subscribeDeviceAlarm, subscribeDeviceStatus, subscribeCommandResponse, subscribeSleepReport, subscribeSystemNotification } from '../utils/websocket'
import { useUserStore, useDeviceStore, useSleepDataStore, useAlarmStore, useWebSocketStore } from '../store'
import { api } from '../utils/api'
import type { VitalSigns, Alarm } from '../types'

class WebSocketService {
  private unsubscribeFunctions: Array<() => void> = []
  private isInitialized: boolean = false
  private currentDeviceId: string | null = null

  /**
   * 初始化WebSocket连接
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log('WebSocket服务已初始化')
      return
    }

    const userStore = useUserStore.getState()
    const deviceStore = useDeviceStore.getState()

    if (!userStore.token) {
      console.warn('用户未登录，无法初始化WebSocket')
      return
    }

    try {
      // 更新连接状态
      useWebSocketStore.getState().setConnecting(true)

      // 连接WebSocket
      await wsClient.connect({
        token: userStore.token,
        deviceId: deviceStore.currentDevice?.device_id,
        autoReconnect: true,
        maxReconnectAttempts: 5,
        reconnectDelay: 3000,
        heartbeatInterval: 30000,
        heartbeatTimeout: 5000
      })

      // 注册事件处理器
      this.registerEventHandlers()

      // 订阅消息
      this.subscribeMessages()

      this.isInitialized = true
      console.log('WebSocket服务初始化成功')
    } catch (error) {
      console.error('WebSocket服务初始化失败:', error)
      useWebSocketStore.getState().setConnecting(false)
      throw error
    }
  }

  /**
   * 注册事件处理器
   */
  private registerEventHandlers(): void {
    // 连接成功事件
    const unsubscribeConnect = wsClient.onConnect(() => {
      console.log('WebSocket连接成功')
      useWebSocketStore.getState().setConnected(true)
      useWebSocketStore.getState().setConnecting(false)
      
      // 显示连接成功提示
      Taro.showToast({
        title: '实时数据连接成功',
        icon: 'success',
        duration: 2000
      })
    })

    // 错误事件
    const unsubscribeError = wsClient.onError((error) => {
      console.error('WebSocket错误:', error)
      useWebSocketStore.getState().setConnected(false)
      
      // 显示错误提示
      Taro.showToast({
        title: '连接错误，正在重连...',
        icon: 'none',
        duration: 3000
      })
    })

    // 状态变化事件
    const unsubscribeStateChange = wsClient.onStateChange((state) => {
      console.log('WebSocket状态变化:', state)
      
      if (state === WebSocketState.CONNECTED) {
        useWebSocketStore.getState().setConnected(true)
        useWebSocketStore.getState().setConnecting(false)
      } else if (state === WebSocketState.CONNECTING || state === WebSocketState.RECONNECTING) {
        useWebSocketStore.getState().setConnecting(true)
      } else {
        useWebSocketStore.getState().setConnected(false)
        useWebSocketStore.getState().setConnecting(false)
      }
    })

    this.unsubscribeFunctions.push(unsubscribeConnect, unsubscribeError, unsubscribeStateChange)
  }

  /**
   * 订阅消息
   */
  private subscribeMessages(): void {
    // 订阅体征数据
    const unsubscribeVitalSigns = subscribeVitalSigns((data: VitalSigns) => {
      console.log('收到体征数据:', data)
      useSleepDataStore.getState().setRealtimeData(data)
    })

    // 订阅报警消息
    const unsubscribeAlarm = subscribeAlarm((data: Alarm) => {
      console.log('收到报警消息:', data)
      this.handleAlarm(data)
    })

    // 订阅设备状态
    const unsubscribeDeviceStatus = subscribeDeviceStatus((data: any) => {
      console.log('收到设备状态:', data)
      if (data.device_id) {
        useDeviceStore.getState().updateDeviceStatus(data.device_id, data)
      }
    })

    // 订阅命令响应
    const unsubscribeCommandResponse = subscribeCommandResponse((data: any) => {
      console.log('收到命令响应:', data)
      this.handleCommandResponse(data)
    })

    // 订阅睡眠报告
    const unsubscribeSleepReport = subscribeSleepReport((data: any) => {
      console.log('收到睡眠报告:', data)
      useSleepDataStore.getState().setSleepReport(data)
    })

    // 订阅系统通知
    const unsubscribeSystemNotification = subscribeSystemNotification((data: any) => {
      console.log('收到系统通知:', data)
      this.handleSystemNotification(data)
    })

    this.unsubscribeFunctions.push(
      unsubscribeVitalSigns,
      unsubscribeAlarm,
      unsubscribeDeviceStatus,
      unsubscribeCommandResponse,
      unsubscribeSleepReport,
      unsubscribeSystemNotification
    )
  }

  /**
   * 订阅特定设备的体征数据
   */
  public subscribeDeviceVitalSigns(deviceId: string): () => void {
    const unsubscribe = subscribeDeviceVitalSigns(deviceId, (data: VitalSigns) => {
      console.log(`收到设备 ${deviceId} 的体征数据:`, data)
      useSleepDataStore.getState().setRealtimeData(data)
    })

    this.unsubscribeFunctions.push(unsubscribe)
    return unsubscribe
  }

  /**
   * 订阅特定设备的报警消息
   */
  public subscribeDeviceAlarm(deviceId: string): () => void {
    const unsubscribe = subscribeDeviceAlarm(deviceId, (data: Alarm) => {
      console.log(`收到设备 ${deviceId} 的报警消息:`, data)
      this.handleAlarm(data)
    })

    this.unsubscribeFunctions.push(unsubscribe)
    return unsubscribe
  }

  /**
   * 处理报警消息
   */
  private handleAlarm(alarm: Alarm): void {
    // 添加到报警列表
    useAlarmStore.getState().addAlarm(alarm)

    // 根据报警级别显示不同的提示
    let title = '新报警'
    let icon: 'success' | 'error' | 'loading' | 'none' = 'none'
    let duration = 3000

    switch (alarm.level) {
      case 'critical':
        title = '严重报警！'
        icon = 'error'
        duration = 5000
        break
      case 'warning':
        title = '警告'
        icon = 'none'
        duration = 4000
        break
      case 'info':
        title = '提示'
        icon = 'success'
        duration = 3000
        break
    }

    // 显示报警提示
    Taro.showToast({
      title: `${title}: ${alarm.message}`,
      icon,
      duration
    })

    // 播放提示音（仅严重报警）
    if (alarm.level === 'critical') {
      this.playAlarmSound()
    }

    // 震动提醒（仅严重和警告级别）
    if (alarm.level === 'critical' || alarm.level === 'warning') {
      Taro.vibrateShort({
        type: alarm.level === 'critical' ? 'heavy' : 'medium'
      })
    }
  }

  /**
   * 处理命令响应
   */
  private handleCommandResponse(response: any): void {
    const { command, success, message, data } = response

    if (success) {
      Taro.showToast({
        title: message || '命令执行成功',
        icon: 'success',
        duration: 2000
      })
    } else {
      Taro.showToast({
        title: message || '命令执行失败',
        icon: 'error',
        duration: 3000
      })
    }
  }

  /**
   * 处理系统通知
   */
  private handleSystemNotification(notification: any): void {
    const { type, title, message } = notification

    switch (type) {
      case 'maintenance':
        Taro.showModal({
          title: title || '系统维护通知',
          content: message || '系统即将进行维护，请保存您的工作',
          showCancel: false,
          confirmText: '我知道了'
        })
        break
      case 'update':
        Taro.showModal({
          title: title || '版本更新',
          content: message || '发现新版本，建议更新到最新版本',
          confirmText: '立即更新',
          cancelText: '稍后',
          success: (res) => {
            if (res.confirm) {
              // 触发应用更新
              Taro.getUpdateManager().onUpdateReady(() => {
                Taro.getUpdateManager().applyUpdate()
              })
            }
          }
        })
        break
      default:
        Taro.showToast({
          title: title || '系统通知',
          icon: 'none',
          duration: 3000
        })
    }
  }

  /**
   * 播放报警提示音
   */
  private playAlarmSound(): void {
    try {
      const innerAudioContext = Taro.createInnerAudioContext()
      innerAudioContext.src = '/assets/sounds/alarm.mp3'
      innerAudioContext.loop = false
      innerAudioContext.play()
      
      // 3秒后停止播放
      setTimeout(() => {
        innerAudioContext.stop()
        innerAudioContext.destroy()
      }, 3000)
    } catch (error) {
      console.error('播放报警音失败:', error)
    }
  }

  /**
   * 切换设备
   */
  public async switchDevice(deviceId: string): Promise<void> {
    if (this.currentDeviceId === deviceId) {
      console.log('已经是当前设备，无需切换')
      return
    }

    // 取消之前的设备订阅
    if (this.currentDeviceId) {
      // 这里可以添加取消订阅的逻辑
    }

    // 订阅新设备的数据
    this.subscribeDeviceVitalSigns(deviceId)
    this.subscribeDeviceAlarm(deviceId)

    this.currentDeviceId = deviceId
    console.log(`已切换到设备: ${deviceId}`)
  }

  /**
   * 发送设备命令
   */
  public sendDeviceCommand(deviceId: string, command: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        // 通过WebSocket发送命令
        const success = wsClient.send({
          type: 'command',
          device_id: deviceId,
          data: {
            command,
            params
          },
          timestamp: Date.now()
        })

        if (success) {
          // 同时通过API发送命令（作为备份）
          api.device.sendCommand(deviceId, command, params)
            .then(resolve)
            .catch(reject)
        } else {
          // WebSocket发送失败，使用API
          api.device.sendCommand(deviceId, command, params)
            .then(resolve)
            .catch(reject)
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * 获取连接状态
   */
  public getConnectionState(): {
    connected: boolean
    connecting: boolean
    state: WebSocketState
    quality: any
  } {
    const wsStore = useWebSocketStore.getState()
    return {
      connected: wsStore.connected,
      connecting: wsStore.connecting,
      state: wsClient.getState(),
      quality: wsClient.getConnectionQuality()
    }
  }

  /**
   * 断开连接
   */
  public disconnect(): void {
    // 取消所有订阅
    this.unsubscribeFunctions.forEach(unsubscribe => {
      try {
        unsubscribe()
      } catch (error) {
        console.error('取消订阅失败:', error)
      }
    })
    this.unsubscribeFunctions = []

    // 断开WebSocket连接
    wsClient.disconnect()

    // 更新状态
    useWebSocketStore.getState().setConnected(false)
    useWebSocketStore.getState().setConnecting(false)

    this.isInitialized = false
    this.currentDeviceId = null

    console.log('WebSocket服务已断开')
  }

  /**
   * 重新连接
   */
  public async reconnect(): Promise<void> {
    this.disconnect()
    await this.initialize()
  }

  /**
   * 检查是否已初始化
   */
  public isReady(): boolean {
    return this.isInitialized && wsClient.isConnected()
  }
}

// 创建全局WebSocket服务实例
export const websocketService = new WebSocketService()

// 导出便捷函数
export const initializeWebSocket = () => websocketService.initialize()
export const disconnectWebSocket = () => websocketService.disconnect()
export const reconnectWebSocket = () => websocketService.reconnect()
export const getWebSocketState = () => websocketService.getConnectionState()
export const sendDeviceCommand = (deviceId: string, command: string, params: any) => 
  websocketService.sendDeviceCommand(deviceId, command, params)
export const switchDevice = (deviceId: string) => websocketService.switchDevice(deviceId)
