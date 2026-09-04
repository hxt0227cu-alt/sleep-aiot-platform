# 智能睡眠监测台灯小程序

## 项目概述

基于 Taro 3.6.23 + React + TypeScript 开发的智能睡眠监测台灯小程序。

## 技术栈

- **框架**: Taro 3.6.23 + React 18
- **语言**: TypeScript
- **状态管理**: Zustand
- **样式**: Sass
- **UI风格**: 玻璃拟态2.0

## 项目结构

为避免手工目录树随页面增删而失真，只维护稳定入口：

| 路径 | 作用 |
| --- | --- |
| `src/app.tsx`、`src/app.config.ts` | 应用入口与页面注册，页面清单以 `app.config.ts` 为准 |
| `src/pages/` | 登录、首页、设备、历史、睡眠报告、灯光、光闹钟、语音、Agent 中心等页面 |
| `src/components/` | 可复用业务与状态组件 |
| `src/services/` | WebSocket 等客户端服务 |
| `src/utils/api.ts` | 当前 HTTP API 集成层 |
| `src/store/`、`src/types/` | 状态与共享类型 |
| `src/styles/` | 样式变量与混入 |
| `tests/` | 当前补充的本地自动化测试 |

新增或移除页面时必须同步 `src/app.config.ts`；不要把 README 中的手工列表当作路由事实来源。

## 已完成功能

### 1. 基础架构 ✅
- [x] Taro + React 框架搭建
- [x] TypeScript 类型系统
- [x] Sass 样式系统
- [x] 玻璃拟态UI风格实现

### 2. 工具函数 ✅
- [x] 常量定义（API地址、错误码、配置参数）
- [x] 日期时间处理
- [x] 数据格式化
- [x] 存储操作封装
- [x] 防抖、节流函数
- [x] 表单验证
- [x] Toast、Loading、Modal 封装

### 3. API集成层 ✅
- [x] 请求拦截器（添加Token）
- [x] 响应拦截器（统一错误处理）
- [x] Token自动刷新
- [x] 请求重试机制
- [x] 用户认证API（register, login, wechatLogin, refreshToken, logout）
- [x] 设备管理API（register, bind, unbind, getDevices, getDeviceDetail, sendCommand）
- [x] 睡眠监测API（getRealtimeData, getHistoryData, getSleepReport, getSleepTrend）
- [x] 报警管理API（getAlarms, getAlarmDetail, configAlarm, getAlarmConfig, handleAlarm）
- [x] 语音服务API（getWhiteNoiseList, recognizeVoice, textToSpeech）
- [x] 用户管理API（getUserProfile, updateUserProfile, manageContacts, getContacts, deleteContact）
- [x] OTA升级API（checkUpdate, reportProgress）

### 4. WebSocket实时通信 ✅
- [x] 连接管理（连接、断开、重连）
- [x] 消息订阅
- [x] 消息处理
- [x] 心跳检测
- [x] 错误处理
- [x] 支持消息类型：device_status, vital_signs, alarm, command_response

### 5. 状态管理 ✅
- [x] 用户状态（用户信息、Token、登录状态）
- [x] 设备状态（设备列表、当前设备、设备状态）
- [x] 睡眠数据状态（实时数据、历史数据）
- [x] 报警状态（报警列表、未读数量）
- [x] WebSocket状态（连接状态）

### 6. 可复用组件 ✅
- [x] VitalSignsCard - 体征卡片组件
- [x] LightControl - 灯光控制组件
- [x] Loading - 加载组件

### 7. 登录页面 ✅
- [x] 微信一键登录
- [x] 手机号+密码登录
- [x] 手机号+验证码登录
- [x] 验证码倒计时
- [x] 表单验证
- [x] 错误提示
- [x] 登录状态保持

### 8. 首页 ✅
- [x] 用户信息展示
- [x] 设备在线状态显示
- [x] 实时体征数据展示（心率、呼吸率、体动、睡眠状态）
- [x] 灯光控制（开关、亮度、色温）
- [x] 负离子控制
- [x] 快捷操作入口
- [x] 报警弹窗提示
- [x] WebSocket实时数据更新

## 待开发功能

### 1. 历史数据页面 (pages/history/)
- [ ] 心率趋势图表（ECharts）
- [ ] 呼吸率趋势图表（ECharts）
- [ ] 睡眠状态图表（深睡/浅睡/清醒）
- [ ] 时间范围选择（今日/本周/本月）
- [ ] 数据平均值显示
- [ ] 极值标注
- [ ] 图表交互（缩放、查看详情）

### 2. 睡眠报告页面 (pages/sleep-report/)
- [ ] 睡眠质量评分显示
- [ ] 睡眠时长统计（深睡、浅睡、清醒）
- [ ] 睡眠效率显示
- [ ] 入睡时长显示
- [ ] 翻身次数显示
- [ ] 睡眠结构图表
- [ ] 健康建议展示

### 3. 个人中心页面 (pages/profile/)
- [ ] 用户信息展示（头像、昵称、手机号）
- [ ] 设备绑定管理
- [ ] 紧急联系人管理
- [ ] 关于我们
- [ ] 帮助与反馈
- [ ] 退出登录

### 4. 设备详情页面 (pages/device/)
- [ ] 设备基本信息展示
- [ ] 网络状态显示
- [ ] 固件版本信息
- [ ] 设备在线状态
- [ ] 设备控制（灯光、负离子、语音）
- [ ] OTA升级入口

### 5. 报警记录页面 (pages/alarm/)
- [ ] 报警列表展示
- [ ] 报警详情查看
- [ ] 报警筛选（按级别、类型、时间）
- [ ] 报警标记已处理
- [ ] 报警配置入口
- [ ] 未读报警提示

### 6. 光闹钟设置页面 (pages/light-alarm/)
- [ ] 添加/编辑光闹钟
- [ ] 时间设置
- [ ] 重复周期设置
- [ ] 渐变时长选择（10/20/30分钟）
- [ ] 目标亮度和色温设置
- [ ] 光闹钟启用/禁用

### 7. 语音控制页面 (pages/voice/)
- [ ] 语音指令帮助
- [ ] 语音识别结果展示
- [ ] 语音合成播放
- [ ] 唤醒词设置
- [ ] 语音控制开关

### 8. 更多组件
- [ ] SleepChart - 睡眠曲线图表组件
- [ ] VoicePlayer - 白噪音播放器组件
- [ ] AlarmModal - 报警弹窗组件
- [ ] DeviceCard - 设备卡片组件
- [ ] EmptyState - 空状态组件

## 开发指南

### 安装依赖

```bash
npm install
```

### 开发模式运行

```bash
npm run dev:weapp
```

### 生产构建

```bash
npm run build:weapp
```

## API配置

修改 `src/utils/constants.ts` 中的 API_BASE_URL 和 WS_BASE_URL 为实际的服务器地址：

```typescript
export const API_BASE_URL = 'https://<your-domain>/api'
export const WS_BASE_URL = 'wss://your-api.com/ws'
```

## 注意事项

1. **API地址配置**: 需要修改 `constants.ts` 中的API地址为实际服务器地址
2. **微信登录**: 需要在微信公众平台配置小程序信息
3. **TabBar图标**: 需要准备对应的图标文件
4. **ECharts集成**: 历史数据页面需要安装 `echarts-for-taro`
5. **状态持久化**: Zustand 使用了 persist 中间件，数据会自动保存到本地存储

## 后续开发建议

1. **优先级顺序**:
   - 高优先级：历史数据页面、个人中心页面、设备详情页面
   - 中优先级：报警记录页面、睡眠报告页面
   - 低优先级：光闹钟设置页面、语音控制页面

2. **组件复用**:
   - 创建更多可复用组件（DeviceCard、EmptyState等）
   - 提取公共逻辑到自定义Hooks

3. **性能优化**:
   - 使用 React.memo 优化组件渲染
   - 使用 useMemo 和 useCallback 优化计算和回调
   - 实现虚拟滚动（长列表）

4. **错误处理**:
   - 添加全局错误边界
   - 完善错误提示和日志记录

5. **测试**:
   - 添加单元测试
   - 添加端到端测试

## 参考文档

- [产品需求文档](../../01-产品需求文档PRD.md)
- [API设计文档](../../backend/docs/API_Design.md)
- [项目架构规划](../../00-项目架构规划.md)
- [R60ABD1通信协议](../../02-R60ABD1通信协议.md)

## License

MIT
