import { useEffect, useRef } from 'react'
import { useUserStore, useDeviceStore } from '../store'
import { initializeWebSocket, disconnectWebSocket, websocketService } from '../services/websocket.service'

/**
 * WebSocket Hook
 * 
 * 用于在应用中自动管理WebSocket连接
 * 
 * @param options 配置选项
 * @returns WebSocket服务实例
 */
export function useWebSocket(options: {
  autoConnect?: boolean      // 是否自动连接
  connectOnLogin?: boolean   // 登录后自动连接
  connectOnDeviceSelect?: boolean  // 选择设备后自动连接
} = {}) {
  const {
    autoConnect = true,
    connectOnLogin = true,
    connectOnDeviceSelect = true
  } = options

  const isInitialized = useRef(false)
  const userStore = useUserStore()
  const deviceStore = useDeviceStore()

  /**
   * 初始化WebSocket连接
   */
  const initWebSocket = async () => {
    if (isInitialized.current) {
      return
    }

    if (!userStore.token) {
      console.log('用户未登录，跳过WebSocket初始化')
      return
    }

    try {
      await initializeWebSocket()
      isInitialized.current = true
      console.log('WebSocket自动初始化成功')
    } catch (error) {
      console.error('WebSocket自动初始化失败:', error)
    }
  }

  /**
   * 断开WebSocket连接
   */
  const cleanup = () => {
    if (isInitialized.current) {
      disconnectWebSocket()
      isInitialized.current = false
    }
  }

  // 初始化连接
  useEffect(() => {
    if (autoConnect) {
      initWebSocket()
    }

    return () => {
      // 组件卸载时不断开连接，因为WebSocket是全局的
      // 如果需要断开，可以调用 cleanup()
    }
  }, [autoConnect])

  // 监听登录状态
  useEffect(() => {
    if (connectOnLogin && userStore.isAuthenticated && userStore.token) {
      if (!isInitialized.current) {
        initWebSocket()
      }
    } else if (!userStore.isAuthenticated) {
      // 用户登出时断开连接
      cleanup()
    }
  }, [userStore.isAuthenticated, userStore.token, connectOnLogin])

  // 监听设备选择
  useEffect(() => {
    if (connectOnDeviceSelect && deviceStore.currentDevice && isInitialized.current) {
      // 切换到新设备
      websocketService.switchDevice(deviceStore.currentDevice.device_id)
    }
  }, [deviceStore.currentDevice?.device_id, connectOnDeviceSelect])

  return {
    service: websocketService,
    isInitialized: isInitialized.current,
    initWebSocket,
    cleanup
  }
}

/**
 * 简化版WebSocket Hook
 * 
 * 只在需要时手动初始化WebSocket
 */
export function useWebSocketManual() {
  const isInitialized = useRef(false)

  const initWebSocket = async () => {
    if (isInitialized.current) {
      console.log('WebSocket已初始化')
      return
    }

    try {
      await initializeWebSocket()
      isInitialized.current = true
    } catch (error) {
      console.error('WebSocket初始化失败:', error)
      throw error
    }
  }

  const disconnect = () => {
    if (isInitialized.current) {
      disconnectWebSocket()
      isInitialized.current = false
    }
  }

  return {
    service: websocketService,
    isInitialized: isInitialized.current,
    initWebSocket,
    disconnect
  }
}
