import Taro from '@tarojs/taro'
import { WS_BASE_URL } from './constants'
import type { VitalSigns, Alarm } from '../types'

type MessageHandler = (data: any) => void
type ConnectionHandler = () => void
type ErrorHandler = (error: any) => void
type StateChangeHandler = (state: WebSocketState) => void

export enum WebSocketState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

interface WebSocketMessage {
  type: string
  device_id: string
  data: any
  timestamp?: number
  sequence?: number
}

interface ConnectionConfig {
  token: string
  deviceId?: string
  autoReconnect?: boolean
  maxReconnectAttempts?: number
  reconnectDelay?: number
  heartbeatInterval?: number
  heartbeatTimeout?: number
}

interface MessageQueueItem {
  message: any
  timestamp: number
  retryCount: number
}

class WebSocketClient {
  private ws: Taro.SocketTask | null = null
  private url: string = ''
  private config: ConnectionConfig | null = null
  private state: WebSocketState = WebSocketState.DISCONNECTED
  
  // 重连相关
  private reconnectAttempts: number = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private maxReconnectAttempts: number = 5
  private reconnectDelay: number = 3000
  private reconnectBackoff: number = 1.5 // 指数退避因子
  
  // 心跳相关
  private heartbeatInterval: NodeJS.Timeout | null = null
  private heartbeatTimeout: NodeJS.Timeout | null = null
  private heartbeatIntervalTime: number = 30000
  private heartbeatTimeoutTime: number = 5000
  private lastHeartbeatTime: number = 0
  private missedHeartbeats: number = 0
  private maxMissedHeartbeats: number = 3
  
  // 连接超时
  private connectTimeout: NodeJS.Timeout | null = null
  private connectTimeoutTime: number = 10000
  
  // 消息队列
  private messageQueue: MessageQueueItem[] = []
  private maxQueueSize: number = 100
  private queueFlushInterval: NodeJS.Timeout | null = null
  
  // 消息序列号
  private messageSequence: number = 0
  
  // 订阅管理
  private subscriptions: Map<string, Set<string>> = new Map() // type -> Set of deviceIds
  private messageHandlers: Map<string, Set<MessageHandler>> = new Map()
  private connectionHandlers: Set<ConnectionHandler> = new Set()
  private errorHandlers: Set<ErrorHandler> = new Set()
  private stateChangeHandlers: Set<StateChangeHandler> = new Set()
  
  // 连接质量监控
  private connectionQuality: {
    latency: number
    messageCount: number
    errorCount: number
    lastErrorTime: number
  } = {
    latency: 0,
    messageCount: 0,
    errorCount: 0,
    lastErrorTime: 0
  }
  
  private isManualClose: boolean = false
  private pendingSubscriptions: string[] = []

  constructor() {}

  /**
   * 连接WebSocket服务器
   */
  public connect(config: ConnectionConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state === WebSocketState.CONNECTED || this.state === WebSocketState.CONNECTING) {
        console.warn('WebSocket已连接或正在连接中')
        resolve()
        return
      }

      this.config = {
        autoReconnect: true,
        maxReconnectAttempts: 5,
        reconnectDelay: 3000,
        heartbeatInterval: 30000,
        heartbeatTimeout: 5000,
        ...config
      }

      this.maxReconnectAttempts = this.config.maxReconnectAttempts!
      this.reconnectDelay = this.config.reconnectDelay!
      this.heartbeatIntervalTime = this.config.heartbeatInterval!
      this.heartbeatTimeoutTime = this.config.heartbeatTimeout!
      
      this.setState(WebSocketState.CONNECTING)
      this.isManualClose = false

      const params = new URLSearchParams()
      params.append('token', this.config.token)
      if (this.config.deviceId) {
        params.append('device_id', this.config.deviceId)
      }

      this.url = `${WS_BASE_URL}?${params.toString()}`

      // 设置连接超时
      this.connectTimeout = setTimeout(() => {
        if (this.state === WebSocketState.CONNECTING) {
          console.error('WebSocket连接超时')
          this.handleConnectionError(new Error('Connection timeout'))
          reject(new Error('Connection timeout'))
        }
      }, this.connectTimeoutTime)

      try {
        this.ws = Taro.connectSocket({
          url: this.url,
          success: () => {
            console.log('WebSocket连接请求已发送')
          },
          fail: (error) => {
            console.error('WebSocket连接请求失败:', error)
            this.handleConnectionError(error)
            reject(error)
          }
        }) as unknown as Taro.SocketTask

        this.ws.onOpen(() => {
          console.log('WebSocket连接成功')
          this.clearConnectTimeout()
          this.reconnectAttempts = 0
          this.missedHeartbeats = 0
          this.setState(WebSocketState.CONNECTED)
          this.startHeartbeat()
          this.startQueueFlush()
          this.resubscribe()
          this.notifyConnectionHandlers()
          resolve()
        })

        this.ws.onMessage((message) => {
          try {
            const data = JSON.parse(message.data as string) as WebSocketMessage
            this.handleMessage(data)
          } catch (error) {
            console.error('解析WebSocket消息失败:', error)
            this.connectionQuality.errorCount++
          }
        })

        this.ws.onError((error) => {
          console.error('WebSocket错误:', error)
          this.connectionQuality.errorCount++
          this.connectionQuality.lastErrorTime = Date.now()
          this.notifyErrorHandlers(error)
          
          if (this.config?.autoReconnect) {
            this.handleReconnect()
          }
        })

        this.ws.onClose((event) => {
          console.log('WebSocket连接关闭:', event)
          this.clearConnectTimeout()
          this.stopHeartbeat()
          this.stopQueueFlush()
          
          if (!this.isManualClose && this.config?.autoReconnect) {
            this.setState(WebSocketState.RECONNECTING)
            this.handleReconnect()
          } else {
            this.setState(WebSocketState.DISCONNECTED)
          }
        })
      } catch (error) {
        console.error('创建WebSocket连接失败:', error)
        this.handleConnectionError(error)
        reject(error)
      }
    })
  }

  /**
   * 断开WebSocket连接
   */
  public disconnect(): void {
    this.isManualClose = true
    this.clearReconnectTimer()
    this.clearConnectTimeout()
    this.stopHeartbeat()
    this.stopQueueFlush()
    
    if (this.ws) {
      this.ws.close({
        code: 1000,
        reason: 'Normal closure'
      })
      this.ws = null
    }

    this.setState(WebSocketState.DISCONNECTED)
    this.messageQueue = []
    this.subscriptions.clear()
    this.messageHandlers.clear()
    this.connectionHandlers.clear()
    this.errorHandlers.clear()
    this.stateChangeHandlers.clear()
  }

  /**
   * 订阅消息类型
   */
  public subscribe(type: string, handler: MessageHandler): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set())
    }
    this.messageHandlers.get(type)!.add(handler)

    // 如果已连接，发送订阅请求
    if (this.state === WebSocketState.CONNECTED) {
      this.sendSubscription(type)
    } else {
      // 记录待订阅的消息类型
      if (!this.pendingSubscriptions.includes(type)) {
        this.pendingSubscriptions.push(type)
      }
    }

    return () => {
      const handlers = this.messageHandlers.get(type)
      if (handlers) {
        handlers.delete(handler)
        if (handlers.size === 0) {
          this.messageHandlers.delete(type)
          this.sendUnsubscription(type)
        }
      }
    }
  }

  /**
   * 订阅特定设备的数据
   */
  public subscribeDevice(deviceId: string, type: string, handler: MessageHandler): () => void {
    const subscriptionKey = `${type}:${deviceId}`
    
    if (!this.messageHandlers.has(subscriptionKey)) {
      this.messageHandlers.set(subscriptionKey, new Set())
    }
    this.messageHandlers.get(subscriptionKey)!.add(handler)

    // 记录订阅关系
    if (!this.subscriptions.has(type)) {
      this.subscriptions.set(type, new Set())
    }
    this.subscriptions.get(type)!.add(deviceId)

    // 如果已连接，发送订阅请求
    if (this.state === WebSocketState.CONNECTED) {
      this.sendSubscription(type, deviceId)
    }

    return () => {
      const handlers = this.messageHandlers.get(subscriptionKey)
      if (handlers) {
        handlers.delete(handler)
        if (handlers.size === 0) {
          this.messageHandlers.delete(subscriptionKey)
          
          // 从订阅关系中移除
          const deviceSet = this.subscriptions.get(type)
          if (deviceSet) {
            deviceSet.delete(deviceId)
            if (deviceSet.size === 0) {
              this.subscriptions.delete(type)
              this.sendUnsubscription(type)
            }
          }
        }
      }
    }
  }

  /**
   * 发送订阅请求
   */
  private sendSubscription(type: string, deviceId?: string): void {
    const message = {
      event: 'subscribe',
      data: {
        message_type: type,
        device_id: deviceId
      },
      timestamp: Date.now()
    }
    this.send(message)
  }

  /**
   * 发送取消订阅请求
   */
  private sendUnsubscription(type: string): void {
    const message = {
      event: 'unsubscribe',
      data: {
        message_type: type
      },
      timestamp: Date.now()
    }
    this.send(message)
  }

  /**
   * 重新订阅所有消息类型
   */
  private resubscribe(): void {
    // 重新订阅所有消息类型
    this.messageHandlers.forEach((handlers, key) => {
      if (!key.includes(':')) {
        this.sendSubscription(key)
      }
    })

    // 重新订阅设备特定消息
    this.subscriptions.forEach((deviceIds, type) => {
      deviceIds.forEach(deviceId => {
        this.sendSubscription(type, deviceId)
      })
    })

    // 处理待订阅的消息类型
    this.pendingSubscriptions.forEach(type => {
      this.sendSubscription(type)
    })
    this.pendingSubscriptions = []
  }

  /**
   * 注册连接事件处理器
   */
  public onConnect(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler)
    return () => {
      this.connectionHandlers.delete(handler)
    }
  }

  /**
   * 注册错误事件处理器
   */
  public onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler)
    return () => {
      this.errorHandlers.delete(handler)
    }
  }

  /**
   * 注册状态变化处理器
   */
  public onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.add(handler)
    // 立即通知当前状态
    handler(this.state)
    return () => {
      this.stateChangeHandlers.delete(handler)
    }
  }

  /**
   * 发送消息
   */
  public send(data: any): boolean {
    if (!this.ws || this.state !== WebSocketState.CONNECTED) {
      console.warn('WebSocket未连接，消息加入队列')
      this.addToQueue(data)
      return false
    }

    try {
      const message = {
        ...data,
        sequence: ++this.messageSequence,
        timestamp: Date.now()
      }
      
      this.ws.send({
        data: JSON.stringify(message),
        success: () => {
          this.connectionQuality.messageCount++
        },
        fail: (error) => {
          console.error('发送WebSocket消息失败:', error)
          this.connectionQuality.errorCount++
          this.addToQueue(data)
        }
      })
      return true
    } catch (error) {
      console.error('发送WebSocket消息异常:', error)
      this.addToQueue(data)
      return false
    }
  }

  /**
   * 添加消息到队列
   */
  private addToQueue(message: any): void {
    if (this.messageQueue.length >= this.maxQueueSize) {
      // 移除最旧的消息
      this.messageQueue.shift()
    }
    
    this.messageQueue.push({
      message,
      timestamp: Date.now(),
      retryCount: 0
    })
  }

  /**
   * 启动队列刷新
   */
  private startQueueFlush(): void {
    this.stopQueueFlush()
    
    this.queueFlushInterval = setInterval(() => {
      this.flushQueue()
    }, 1000)
  }

  /**
   * 停止队列刷新
   */
  private stopQueueFlush(): void {
    if (this.queueFlushInterval) {
      clearInterval(this.queueFlushInterval)
      this.queueFlushInterval = null
    }
  }

  /**
   * 刷新消息队列
   */
  private flushQueue(): void {
    if (this.state !== WebSocketState.CONNECTED || this.messageQueue.length === 0) {
      return
    }

    const now = Date.now()
    const maxRetryCount = 3
    const maxQueueAge = 60000 // 1分钟

    // 过滤掉过期或重试次数过多的消息
    this.messageQueue = this.messageQueue.filter(item => {
      const age = now - item.timestamp
      return age < maxQueueAge && item.retryCount < maxRetryCount
    })

    // 发送队列中的消息
    const messagesToSend = [...this.messageQueue]
    this.messageQueue = []

    messagesToSend.forEach(item => {
      const success = this.send(item.message)
      if (!success) {
        item.retryCount++
        this.messageQueue.push(item)
      }
    })
  }

  /**
   * 检查连接状态
   */
  public isConnected(): boolean {
    return this.state === WebSocketState.CONNECTED
  }

  /**
   * 获取连接状态
   */
  public getState(): WebSocketState {
    return this.state
  }

  /**
   * 获取连接质量信息
   */
  public getConnectionQuality() {
    return {
      ...this.connectionQuality,
      state: this.state,
      reconnectAttempts: this.reconnectAttempts
    }
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(message: WebSocketMessage): void {
    // 处理心跳响应
    if (message.type === 'pong' || message.type === 'heartbeat_ack') {
      this.handlePong(message)
      return
    }

    // 更新连接质量
    this.connectionQuality.messageCount++
    if (message.timestamp) {
      this.connectionQuality.latency = Date.now() - message.timestamp
    }

    // 通知所有订阅该消息类型的处理器
    const handlers = this.messageHandlers.get(message.type)
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(message.data)
        } catch (error) {
          console.error('消息处理器执行失败:', error)
        }
      })
    }

    // 通知设备特定的处理器
    if (message.device_id) {
      const deviceKey = `${message.type}:${message.device_id}`
      const deviceHandlers = this.messageHandlers.get(deviceKey)
      if (deviceHandlers) {
        deviceHandlers.forEach(handler => {
          try {
            handler(message.data)
          } catch (error) {
            console.error('设备消息处理器执行失败:', error)
          }
        })
      }
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
    }, this.heartbeatIntervalTime)
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = null
    }
  }

  /**
   * 发送心跳
   */
  private sendHeartbeat(): void {
    this.lastHeartbeatTime = Date.now()
    
    const success = this.send({
      event: 'heartbeat',
      timestamp: this.lastHeartbeatTime
    })

    if (success) {
      // 设置心跳超时
      this.heartbeatTimeout = setTimeout(() => {
        this.missedHeartbeats++
        console.warn(`心跳超时，丢失心跳次数: ${this.missedHeartbeats}`)
        
        if (this.missedHeartbeats >= this.maxMissedHeartbeats) {
          console.error('连续丢失心跳过多，断开连接')
          if (this.ws) {
            this.ws.close({
              code: 1000,
              reason: 'Heartbeat timeout'
            })
          }
        }
      }, this.heartbeatTimeoutTime)
    }
  }

  /**
   * 处理心跳响应
   */
  private handlePong(message: WebSocketMessage): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = null
    }
    
    this.missedHeartbeats = 0
    
    if (message.timestamp) {
      const latency = Date.now() - message.timestamp
      this.connectionQuality.latency = latency
      console.debug(`心跳延迟: ${latency}ms`)
    }
  }

  /**
   * 处理重连
   */
  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('达到最大重连次数，停止重连')
      this.setState(WebSocketState.ERROR)
      return
    }

    if (!this.config) {
      console.error('没有连接配置，无法重连')
      return
    }

    this.reconnectAttempts++
    // 指数退避
    const delay = Math.min(
      this.reconnectDelay * Math.pow(this.reconnectBackoff, this.reconnectAttempts - 1),
      30000 // 最大30秒
    )

    console.log(`${delay}ms后尝试第${this.reconnectAttempts}次重连...`)

    this.reconnectTimer = setTimeout(() => {
      this.connect(this.config!).catch((error) => {
        console.error('重连失败:', error)
      })
    }, delay)
  }

  /**
   * 处理连接错误
   */
  private handleConnectionError(error: any): void {
    this.setState(WebSocketState.ERROR)
    this.notifyErrorHandlers(error)
    this.clearConnectTimeout()
  }

  /**
   * 设置连接状态
   */
  private setState(state: WebSocketState): void {
    if (this.state !== state) {
      console.log(`WebSocket状态变化: ${this.state} -> ${state}`)
      this.state = state
      this.notifyStateChangeHandlers()
    }
  }

  /**
   * 清除重连定时器
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * 清除连接超时定时器
   */
  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout)
      this.connectTimeout = null
    }
  }

  /**
   * 通知连接处理器
   */
  private notifyConnectionHandlers(): void {
    this.connectionHandlers.forEach(handler => {
      try {
        handler()
      } catch (error) {
        console.error('连接处理器执行失败:', error)
      }
    })
  }

  /**
   * 通知错误处理器
   */
  private notifyErrorHandlers(error: any): void {
    this.errorHandlers.forEach(handler => {
      try {
        handler(error)
      } catch (err) {
        console.error('错误处理器执行失败:', err)
      }
    })
  }

  /**
   * 通知状态变化处理器
   */
  private notifyStateChangeHandlers(): void {
    this.stateChangeHandlers.forEach(handler => {
      try {
        handler(this.state)
      } catch (error) {
        console.error('状态变化处理器执行失败:', error)
      }
    })
  }
}

// 创建全局WebSocket客户端实例
export const wsClient = new WebSocketClient()

// 便捷订阅函数
export const subscribeVitalSigns = (handler: (data: VitalSigns) => void) => {
  return wsClient.subscribe('vital_signs', handler)
}

export const subscribeDeviceVitalSigns = (deviceId: string, handler: (data: VitalSigns) => void) => {
  return wsClient.subscribeDevice(deviceId, 'vital_signs', handler)
}

export const subscribeDeviceStatus = (handler: (data: any) => void) => {
  return wsClient.subscribe('device_status', handler)
}

export const subscribeDeviceStatusByDevice = (deviceId: string, handler: (data: any) => void) => {
  return wsClient.subscribeDevice(deviceId, 'device_status', handler)
}

export const subscribeAlarm = (handler: (data: Alarm) => void) => {
  return wsClient.subscribe('alarm', handler)
}

export const subscribeDeviceAlarm = (deviceId: string, handler: (data: Alarm) => void) => {
  return wsClient.subscribeDevice(deviceId, 'alarm', handler)
}

export const subscribeCommandResponse = (handler: (data: any) => void) => {
  return wsClient.subscribe('command_response', handler)
}

export const subscribeSleepReport = (handler: (data: any) => void) => {
  return wsClient.subscribe('sleep_report', handler)
}

export const subscribeSystemNotification = (handler: (data: any) => void) => {
  return wsClient.subscribe('system_notification', handler)
}
