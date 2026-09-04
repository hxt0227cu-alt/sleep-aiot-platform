# WebSocket实时数据接收功能使用说明

## 概述

本WebSocket模块提供了完整的实时数据接收功能，包括连接管理、消息订阅、实时体征数据更新、报警推送、断线重连等功能。

## 核心功能

### 1. 连接管理
- 自动连接和断线重连
- 心跳保活机制
- 连接状态监控
- 连接质量监控（延迟、消息数、错误数）

### 2. 消息订阅
- 支持全局消息订阅
- 支持设备特定消息订阅
- 自动重连后重新订阅
- 订阅管理（添加、取消）

### 3. 实时数据流
- 体征数据实时更新
- 设备状态实时更新
- 报警消息实时推送
- 命令响应实时处理

### 4. 报警处理
- 多级别报警（info、warning、critical）
- 声音提醒
- 震动提醒
- 报警弹窗

## 文件结构

```
src/
├── utils/
│   └── websocket.ts              # WebSocket客户端核心实现
├── services/
│   └── websocket.service.ts       # WebSocket服务层
├── hooks/
│   └── useWebSocket.ts            # React Hooks
├── examples/
│   └── websocket-usage-example.tsx # 使用示例
└── docs/
    └── websocket-usage.md         # 使用说明（本文件）
```

## 快速开始

### 方式一：使用Hook自动管理（推荐）

```tsx
import { useWebSocket } from '../hooks/useWebSocket'

function MyComponent() {
  const { service, isInitialized } = useWebSocket({
    autoConnect: true,              // 自动连接
    connectOnLogin: true,           // 登录后自动连接
    connectOnDeviceSelect: true     // 选择设备后自动连接
  })

  return (
    <View>
      <Text>WebSocket状态: {isInitialized ? '已连接' : '未连接'}</Text>
    </View>
  )
}
```

### 方式二：手动管理

```tsx
import { initializeWebSocket, disconnectWebSocket } from '../services/websocket.service'

function MyComponent() {
  useEffect(() => {
    // 初始化连接
    initializeWebSocket()
    
    return () => {
      // 清理连接
      disconnectWebSocket()
    }
  }, [])

  return <View>...</View>
}
```

### 方式三：在应用入口初始化

```tsx
// app.tsx
import { useEffect } from 'react'
import { useWebSocket } from './hooks/useWebSocket'

function App(props) {
  // 在应用级别初始化WebSocket
  useWebSocket({
    autoConnect: true,
    connectOnLogin: true,
    connectOnDeviceSelect: true
  })

  return props.children
}

export default App
```

## API参考

### WebSocketClient

核心WebSocket客户端类。

#### 方法

##### `connect(config: ConnectionConfig): Promise<void>`

连接WebSocket服务器。

```typescript
await wsClient.connect({
  token: 'your-token',
  deviceId: 'device-id',          // 可选
  autoReconnect: true,             // 可选，默认true
  maxReconnectAttempts: 5,          // 可选，默认5
  reconnectDelay: 3000,             // 可选，默认3000ms
  heartbeatInterval: 30000,          // 可选，默认30000ms
  heartbeatTimeout: 5000            // 可选，默认5000ms
})
```

##### `disconnect(): void`

断开WebSocket连接。

```typescript
wsClient.disconnect()
```

##### `subscribe(type: string, handler: MessageHandler): () => void`

订阅消息类型。

```typescript
const unsubscribe = wsClient.subscribe('vital_signs', (data) => {
  console.log('收到体征数据:', data)
})

// 取消订阅
unsubscribe()
```

##### `subscribeDevice(deviceId: string, type: string, handler: MessageHandler): () => void`

订阅特定设备的消息。

```typescript
const unsubscribe = wsClient.subscribeDevice('device-123', 'vital_signs', (data) => {
  console.log('收到设备123的体征数据:', data)
})

// 取消订阅
unsubscribe()
```

##### `send(data: any): boolean`

发送消息。

```typescript
wsClient.send({
  type: 'command',
  device_id: 'device-123',
  data: {
    command: 'set_light',
    params: { power: true, brightness: 80 }
  }
})
```

##### `isConnected(): boolean`

检查连接状态。

```typescript
if (wsClient.isConnected()) {
  console.log('WebSocket已连接')
}
```

##### `getState(): WebSocketState`

获取连接状态。

```typescript
const state = wsClient.getState()
// state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
```

##### `getConnectionQuality(): object`

获取连接质量信息。

```typescript
const quality = wsClient.getConnectionQuality()
console.log(quality)
// {
//   latency: 50,           // 延迟(ms)
//   messageCount: 100,     // 消息数
//   errorCount: 0,         // 错误数
//   lastErrorTime: 0,      // 最后错误时间
//   state: 'connected',    // 连接状态
//   reconnectAttempts: 0   // 重连次数
// }
```

##### `onConnect(handler: ConnectionHandler): () => void`

注册连接成功事件处理器。

```typescript
const unsubscribe = wsClient.onConnect(() => {
  console.log('WebSocket连接成功')
})
```

##### `onError(handler: ErrorHandler): () => void`

注册错误事件处理器。

```typescript
const unsubscribe = wsClient.onError((error) => {
  console.error('WebSocket错误:', error)
})
```

##### `onStateChange(handler: StateChangeHandler): () => void`

注册状态变化事件处理器。

```typescript
const unsubscribe = wsClient.onStateChange((state) => {
  console.log('状态变化:', state)
})
```

### WebSocketService

WebSocket服务层，提供高级功能。

#### 方法

##### `initialize(): Promise<void>`

初始化WebSocket服务。

```typescript
await websocketService.initialize()
```

##### `disconnect(): void`

断开WebSocket服务。

```typescript
websocketService.disconnect()
```

##### `reconnect(): Promise<void>`

重新连接。

```typescript
await websocketService.reconnect()
```

##### `switchDevice(deviceId: string): Promise<void>`

切换设备。

```typescript
await websocketService.switchDevice('device-123')
```

##### `sendDeviceCommand(deviceId: string, command: string, params: any): Promise<any>`

发送设备命令。

```typescript
await websocketService.sendDeviceCommand('device-123', 'set_light', {
  power: true,
  brightness: 80,
  color_temp: 4000
})
```

##### `getConnectionState(): object`

获取连接状态。

```typescript
const state = websocketService.getConnectionState()
```

##### `isReady(): boolean`

检查服务是否就绪。

```typescript
if (websocketService.isReady()) {
  console.log('WebSocket服务已就绪')
}
```

### 便捷函数

#### `initializeWebSocket()`

初始化WebSocket连接。

```typescript
import { initializeWebSocket } from '../services/websocket.service'

await initializeWebSocket()
```

#### `disconnectWebSocket()`

断开WebSocket连接。

```typescript
import { disconnectWebSocket } from '../services/websocket.service'

disconnectWebSocket()
```

#### `reconnectWebSocket()`

重新连接。

```typescript
import { reconnectWebSocket } from '../services/websocket.service'

await reconnectWebSocket()
```

#### `getWebSocketState()`

获取连接状态。

```typescript
import { getWebSocketState } from '../services/websocket.service'

const state = getWebSocketState()
```

#### `sendDeviceCommand(deviceId, command, params)`

发送设备命令。

```typescript
import { sendDeviceCommand } from '../services/websocket.service'

await sendDeviceCommand('device-123', 'set_light', {
  power: true,
  brightness: 80
})
```

#### `switchDevice(deviceId)`

切换设备。

```typescript
import { switchDevice } from '../services/websocket.service'

await switchDevice('device-123')
```

### 消息订阅函数

#### `subscribeVitalSigns(handler)`

订阅体征数据。

```typescript
import { subscribeVitalSigns } from '../utils/websocket'

const unsubscribe = subscribeVitalSigns((data) => {
  console.log('心率:', data.heart_rate.value)
  console.log('呼吸率:', data.breathing_rate.value)
})
```

#### `subscribeDeviceVitalSigns(deviceId, handler)`

订阅特定设备的体征数据。

```typescript
import { subscribeDeviceVitalSigns } from '../utils/websocket'

const unsubscribe = subscribeDeviceVitalSigns('device-123', (data) => {
  console.log('设备123的体征数据:', data)
})
```

#### `subscribeAlarm(handler)`

订阅报警消息。

```typescript
import { subscribeAlarm } from '../utils/websocket'

const unsubscribe = subscribeAlarm((alarm) => {
  console.log('报警类型:', alarm.type)
  console.log('报警级别:', alarm.level)
  console.log('报警消息:', alarm.message)
})
```

#### `subscribeDeviceAlarm(deviceId, handler)`

订阅特定设备的报警消息。

```typescript
import { subscribeDeviceAlarm } from '../utils/websocket'

const unsubscribe = subscribeDeviceAlarm('device-123', (alarm) => {
  console.log('设备123的报警:', alarm)
})
```

## 数据流

### 体征数据流

```
设备 → 后端MQTT → 后端WebSocket → 小程序WebSocket → Store → UI组件
```

### 报警数据流

```
设备 → 后端MQTT → 后端报警服务 → 后端WebSocket → 小程序WebSocket → Store → UI组件
```

### 命令数据流

```
UI组件 → 小程序WebSocket → 后端WebSocket → 后端MQTT → 设备
```

## Store集成

WebSocket服务自动与以下Store集成：

### useSleepDataStore

实时体征数据存储。

```typescript
import { useSleepDataStore } from '../store'

function MyComponent() {
  const realtimeData = useSleepDataStore(state => state.realtimeData)
  
  return (
    <View>
      {realtimeData && (
        <>
          <Text>心率: {realtimeData.heart_rate.value}</Text>
          <Text>呼吸率: {realtimeData.breathing_rate.value}</Text>
        </>
      )}
    </View>
  )
}
```

### useAlarmStore

报警数据存储。

```typescript
import { useAlarmStore } from '../store'

function MyComponent() {
  const alarms = useAlarmStore(state => state.alarms)
  const unreadCount = useAlarmStore(state => state.unreadCount)
  
  return (
    <View>
      <Text>未读报警: {unreadCount}</Text>
      {alarms.map(alarm => (
        <Text key={alarm.alarm_id}>{alarm.message}</Text>
      ))}
    </View>
  )
}
```

### useDeviceStore

设备状态存储。

```typescript
import { useDeviceStore } from '../store'

function MyComponent() {
  const currentDevice = useDeviceStore(state => state.currentDevice)
  const deviceStatus = useDeviceStore(state => state.deviceStatus)
  
  return (
    <View>
      {currentDevice && (
        <Text>当前设备: {currentDevice.device_name}</Text>
      )}
    </View>
  )
}
```

### useWebSocketStore

WebSocket连接状态存储。

```typescript
import { useWebSocketStore } from '../store'

function MyComponent() {
  const connected = useWebSocketStore(state => state.connected)
  const connecting = useWebSocketStore(state => state.connecting)
  
  return (
    <View>
      <Text>连接状态: {connected ? '已连接' : connecting ? '连接中' : '未连接'}</Text>
    </View>
  )
}
```

## 最佳实践

### 1. 在应用入口初始化

在`app.tsx`中使用`useWebSocket` Hook进行全局初始化。

### 2. 使用Store获取数据

通过Store获取实时数据，而不是直接订阅消息。

### 3. 处理连接错误

监听WebSocket错误事件，提供友好的错误提示。

### 4. 监控连接质量

定期检查连接质量，及时发现网络问题。

### 5. 合理使用设备订阅

只在需要时订阅特定设备的数据，避免不必要的流量消耗。

### 6. 及时取消订阅

组件卸载时及时取消订阅，避免内存泄漏。

## 故障排查

### 连接失败

1. 检查网络连接
2. 检查token是否有效
3. 检查WebSocket服务器地址
4. 查看控制台错误信息

### 数据不更新

1. 检查WebSocket连接状态
2. 检查是否正确订阅消息
3. 检查Store是否正确更新
4. 查看网络请求

### 重连失败

1. 检查重连次数限制
2. 检查重连延迟配置
3. 检查网络稳定性
4. 查看重连日志

## 注意事项

1. WebSocket连接是全局的，不要在多个组件中重复初始化
2. 订阅函数返回取消订阅的函数，记得在组件卸载时调用
3. 心跳超时会自动断开连接，这是正常行为
4. 重连使用指数退避策略，避免频繁重连
5. 消息队列有大小限制，过期消息会被丢弃
6. 连接质量监控有助于发现网络问题

## 示例代码

完整的使用示例请参考：
- [websocket-usage-example.tsx](../examples/websocket-usage-example.tsx)
