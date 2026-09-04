import Taro from '@tarojs/taro'
import { API_BASE_URL, STORAGE_KEYS, ERROR_CODES } from './constants'
import { storage, showToast } from './util'
import type {
  ApiResponse,
  UserInfo,
  DeviceInfo,
  VitalSigns,
  SleepReport,
  Alarm,
  WhiteNoise,
  Contact,
  LightAlarm,
  DeviceBindRequest,
  DeviceBindResponse,
  OTAUpdateInfo,
  AssistantSleepExplanation,
  AssistantDeviceControlResponse,
  AssistantKnowledgeAnswer,
  AgentRunSummary,
  AgentRunDetail,
  BusinessAgentType
} from '../types'

interface RequestConfig {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  data?: any
  header?: Record<string, string>
  needAuth?: boolean
  retry?: number
}

class ApiClient {
  private token: string | null = null
  private refreshToken: string | null = null
  private isRefreshing: boolean = false
  private refreshSubscribers: Array<(token: string) => void> = []

  constructor() {
    this.initTokens()
  }

  private async initTokens() {
    this.token = await storage.get<string>(STORAGE_KEYS.TOKEN)
    this.refreshToken = await storage.get<string>(STORAGE_KEYS.REFRESH_TOKEN)
  }

  private async request<T = any>(config: RequestConfig): Promise<ApiResponse<T>> {
    const {
      url,
      method = 'GET',
      data,
      header = {},
      needAuth = true,
      retry = 3
    } = config

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...header
    }

    if (needAuth && !this.token) {
      this.token = await storage.get<string>(STORAGE_KEYS.TOKEN)
    }

    if (needAuth && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    try {
      const response = await Taro.request({
        url: `${API_BASE_URL}${url}`,
        method,
        data,
        header: headers,
        timeout: 10000
      })

      const result = this.normalizeResponse<T>(response.data, url, response.statusCode)

      if (result.code === ERROR_CODES.UNAUTHORIZED && needAuth) {
        return this.handleUnauthorized<T>(config)
      }

      return result
    } catch (error: any) {
      console.error('API请求失败:', error)
      
      if (retry > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        return this.request({ ...config, retry: retry - 1 })
      }

      throw error
    }
  }

  private normalizeResponse<T = any>(raw: any, url: string, httpStatus: number): ApiResponse<T> {
    const code = raw?.code ?? raw?.statusCode ?? httpStatus
    let data = raw?.data ?? raw
    const isDeviceCollection = url === '/devices'
    const isSingleDeviceRoute = /^\/devices\/[^/]+(?:\/status)?$/.test(url)

    if (data?.accessToken) {
      data = {
        ...data,
        token: data.accessToken,
        refresh_token: data.refreshToken,
        expires_in: data.expiresIn,
        user_info: this.normalizeUser(data.user)
      }
    }

    if (isDeviceCollection && Array.isArray(data)) {
      data = { devices: data.map((device) => this.normalizeDevice(device)) }
    } else if (isSingleDeviceRoute && data && typeof data === 'object') {
      data = this.normalizeDevice(data)
    } else if (url.includes('/light-alarms') && Array.isArray(data)) {
      data = data.map((alarm) => this.normalizeLightAlarm(alarm))
    } else if (url.includes('/light-alarms') && data && typeof data === 'object') {
      data = this.normalizeLightAlarm(data)
    }

    if (url.includes('/sleep/') && url.endsWith('/realtime') && data && typeof data === 'object') {
      data = this.normalizeVitalSigns(data)
    }

    return {
      code,
      message: raw?.message || (code >= 200 && code < 300 ? 'Success' : 'Request failed'),
      data,
      timestamp: typeof raw?.timestamp === 'number' ? raw.timestamp : Date.parse(raw?.timestamp || '') || Date.now()
    } as ApiResponse<T>
  }

  private normalizeUser(user: any): UserInfo {
    return {
      user_id: user?.user_id || user?.id || '',
      nickname: user?.nickname || '',
      avatar: user?.avatar || user?.avatarUrl || '',
      phone: user?.phone || '',
      wechat_openid: user?.wechat_openid || user?.wechatOpenid
    }
  }

  private normalizeDevice(device: any): DeviceInfo {
    const light = device?.status?.light || device?.light_state || device?.lightState
    const lightAlarms = Array.isArray(device?.status?.light_alarms)
      ? device.status.light_alarms.map((alarm: any) => this.normalizeLightAlarm(alarm))
      : undefined
    return {
      ...device,
      device_id: device?.device_id || device?.deviceId || '',
      device_name: device?.device_name || device?.deviceName || '',
      device_type: device?.device_type || device?.deviceType || '',
      last_seen: device?.last_seen || device?.lastSeen || 0,
      firmware_version: device?.firmware_version || device?.firmwareVersion || '',
      light_state: light || device?.light_state || device?.lightState,
      status: {
        ...(device?.status || {}),
        ...(lightAlarms ? { light_alarms: lightAlarms } : {}),
        light: light
          ? {
              power: Boolean(light.power ?? light.on),
              brightness: Number(light.brightness ?? 0),
              color_temp: Number(light.color_temp ?? light.colorTemp ?? 4000)
            }
          : device?.status?.light
      }
    }
  }

  private normalizeLightAlarm(alarm: any): LightAlarm {
    return {
      ...alarm,
      alarm_id: alarm?.alarm_id || alarm?.alarmId || alarm?.id || '',
      device_id: alarm?.device_id || alarm?.deviceId || '',
      brightness_target: Number(alarm?.brightness_target ?? alarm?.brightnessTarget ?? 0),
      color_temp_target: Number(alarm?.color_temp_target ?? alarm?.colorTempTarget ?? 4000),
      ramp_minutes: Number(alarm?.ramp_minutes ?? alarm?.rampMinutes ?? 15),
      enabled: Boolean(alarm?.enabled ?? true),
      mode: alarm?.mode || '柔和唤醒',
      time: alarm?.time || '07:00'
    }
  }

  private normalizeVitalSigns(data: any): any {
    const heartRate = data.heartRate ?? data.heart_rate?.value ?? data.heart_rate ?? 0
    const breathingRate = data.breathingRate ?? data.breathing_rate?.value ?? data.breathing_rate ?? 0
    const bodyMovement = data.bodyMovement ?? data.body_movement?.value ?? data.body_movement ?? 0
    const sleepState = data.sleepState ?? data.sleep_state?.state ?? data.sleep_state ?? 'unknown'

    return {
      ...data,
      heart_rate: { value: Number(heartRate), unit: 'bpm', status: data.heart_rate?.status || 'normal' },
      breathing_rate: { value: Number(breathingRate), unit: 'times/min', status: data.breathing_rate?.status || 'normal' },
      body_movement: { value: Number(bodyMovement), unit: 'level', status: data.body_movement?.status || 'normal' },
      sleep_state: { state: String(sleepState), confidence: data.confidence || data.sleep_state?.confidence || 0 }
    }
  }

  private async handleUnauthorized<T>(config: RequestConfig): Promise<ApiResponse<T>> {
    if (this.isRefreshing) {
      return new Promise((resolve) => {
        this.refreshSubscribers.push((token) => {
          resolve(this.request<T>(config))
        })
      })
    }

    this.isRefreshing = true
    try {
      const newToken = await this.refreshAccessToken()
      this.token = newToken
      await storage.set(STORAGE_KEYS.TOKEN, newToken)
      
      this.refreshSubscribers.forEach(callback => callback(newToken))
      this.refreshSubscribers = []
      
      return this.request<T>(config)
    } catch (error) {
      await this.logout()
      throw error
    } finally {
      this.isRefreshing = false
    }
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available')
    }

    const response = await Taro.request({
      url: `${API_BASE_URL}/auth/refresh`,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.refreshToken}`
      }
    })

    const result = response.data as ApiResponse<{ token: string; refresh_token: string }>
    
    if (result.code === ERROR_CODES.SUCCESS) {
      this.refreshToken = result.data.refresh_token
      await storage.set(STORAGE_KEYS.REFRESH_TOKEN, result.data.refresh_token)
      return result.data.token
    }

    throw new Error('Token refresh failed')
  }

  public async logout() {
    try {
      await this.request({ url: '/auth/logout', method: 'POST', needAuth: false })
    } catch (error) {
      console.error('登出失败:', error)
    } finally {
      this.token = null
      this.refreshToken = null
      await storage.remove(STORAGE_KEYS.TOKEN)
      await storage.remove(STORAGE_KEYS.REFRESH_TOKEN)
      await storage.remove(STORAGE_KEYS.USER_INFO)
      Taro.reLaunch({ url: '/pages/login/index' })
    }
  }

  public setTokens(token: string, refreshToken: string) {
    this.token = token
    this.refreshToken = refreshToken
    storage.set(STORAGE_KEYS.TOKEN, token)
    storage.set(STORAGE_KEYS.REFRESH_TOKEN, refreshToken)
  }

  public getToken(): string | null {
    return this.token
  }

  public isAuthenticated(): boolean {
    return !!this.token
  }

  public auth = {
    register: (data: { phone: string; password: string; nickname: string; wechat_openid?: string }) => {
      return this.request<{ user_id: string; token: string; refresh_token?: string; expires_in: number }>({
        url: '/auth/register',
        method: 'POST',
        data,
        needAuth: false
      })
    },

    login: (data: { phone: string; password: string }) => {
      return this.request<{ user_id: string; token: string; refresh_token?: string; expires_in: number; user_info: UserInfo }>({
        url: '/auth/login',
        method: 'POST',
        data,
        needAuth: false
      })
    },

    wechatLogin: (data: { code: string; encrypted_data?: string; iv?: string }) => {
      return this.request<{ user_id: string; token: string; refresh_token?: string; expires_in: number; user_info: UserInfo }>({
        url: '/auth/wechat-login',
        method: 'POST',
        data,
        needAuth: false
      })
    },

    refreshToken: () => {
      return this.refreshAccessToken()
    }
  }

  public device = {
    register: (data: { device_id: string; device_name: string; device_type: string; firmware_version: string; mac_address: string }) => {
      return this.request<{ device_id: string; device_secret: string; mqtt_config: any }>({
        url: '/devices/register',
        method: 'POST',
        data,
        needAuth: false
      })
    },

    bind: (data: DeviceBindRequest) => {
      return this.request<DeviceBindResponse>({
        url: '/devices/bind',
        method: 'POST',
        data
      })
    },

    createProvisioningToken: () => {
      return this.request<{ bindToken: string; bind_token: string; expiresIn: number; expires_in: number }>({
        url: '/devices/provisioning-token',
        method: 'POST'
      })
    },

    completeProvisioning: (data: { bindToken?: string; bind_token?: string; deviceId?: string; device_id?: string }) => {
      return this.request<DeviceBindResponse>({
        url: '/devices/provisioning-complete',
        method: 'POST',
        data
      })
    },

    unbind: (deviceId: string) => {
      return this.request<any>({
        url: `/devices/${deviceId}/unbind`,
        method: 'DELETE'
      })
    },

    getDevices: () => {
      return this.request<{ devices: DeviceInfo[] }>({
        url: '/devices',
        method: 'GET'
      })
    },

    getDeviceDetail: (deviceId: string) => {
      return this.request<DeviceInfo>({
        url: `/devices/${deviceId}`,
        method: 'GET'
      })
    },

    getDeviceStatus: (deviceId: string) => {
      return this.request<DeviceInfo>({
        url: `/devices/${deviceId}/status`,
        method: 'GET'
      })
    },

    sendCommand: (deviceId: string, command: string, params: any, timeout: number = 5000) => {
      return this.request<any>({
        url: `/devices/${deviceId}/command`,
        method: 'POST',
        data: { command, params, timeout }
      })
    },

    getLightAlarms: (deviceId: string) => {
      return this.request<LightAlarm[]>({
        url: `/devices/${deviceId}/light-alarms`,
        method: 'GET'
      })
    },

    createLightAlarm: (deviceId: string, data: Partial<LightAlarm>) => {
      return this.request<LightAlarm>({
        url: `/devices/${deviceId}/light-alarms`,
        method: 'POST',
        data
      })
    },

    updateLightAlarm: (deviceId: string, alarmId: string, data: Partial<LightAlarm>) => {
      return this.request<LightAlarm>({
        url: `/devices/${deviceId}/light-alarms/${alarmId}`,
        method: 'PUT',
        data
      })
    },

    updateLightAlarmEnabled: (deviceId: string, alarmId: string, enabled: boolean) => {
      return this.request<LightAlarm>({
        url: `/devices/${deviceId}/light-alarms/${alarmId}/enabled`,
        method: 'PUT',
        data: { enabled }
      })
    },

    deleteLightAlarm: (deviceId: string, alarmId: string) => {
      return this.request<any>({
        url: `/devices/${deviceId}/light-alarms/${alarmId}`,
        method: 'DELETE'
      })
    }
  }

  public sleep = {
    getRealtimeData: (deviceId: string) => {
      return this.request<VitalSigns>({
        url: `/sleep/${deviceId}/realtime`,
        method: 'GET'
      })
    },

    getHistoryData: (deviceId: string, params: { start_time: number; end_time: number; interval?: number; metrics?: string }) => {
      return this.request<any>({
        url: `/sleep/${deviceId}/history`,
        method: 'GET',
        data: params
      })
    },

    getSleepReport: (deviceId: string, date?: string) => {
      return this.request<SleepReport>({
        url: `/sleep/${deviceId}/report`,
        method: 'GET',
        data: date ? { date } : undefined
      })
    },

    getSleepTrend: (deviceId: string, params: { days?: number; metric?: string }) => {
      return this.request<any>({
        url: `/sleep/${deviceId}/trend`,
        method: 'GET',
        data: params
      })
    }
  }

  public alarm = {
    getAlarms: (params?: { device_id?: string; start_time?: number; end_time?: number; level?: string; page?: number; page_size?: number }) => {
      return this.request<{ total: number; page: number; page_size: number; alarms: Alarm[] }>({
        url: '/alarms',
        method: 'GET',
        data: params
      })
    },

    getAlarmDetail: (alarmId: string) => {
      return this.request<Alarm>({
        url: `/alarms/${alarmId}`,
        method: 'GET'
      })
    },

    configAlarm: (data: { device_id: string; rules: any[] }) => {
      return this.request<any>({
        url: '/alarms/config',
        method: 'POST',
        data
      })
    },

    getAlarmConfig: (deviceId: string) => {
      return this.request<any>({
        url: `/alarms/config/${deviceId}`,
        method: 'GET'
      })
    },

    handleAlarm: (alarmId: string, note?: string) => {
      return this.request<any>({
        url: `/alarms/${alarmId}/handle`,
        method: 'PUT',
        data: note ? { note } : undefined
      })
    }
  }

  public voice = {
    getWhiteNoiseList: () => {
      return this.request<{ sounds: WhiteNoise[] }>({
        url: '/voice/white-noise',
        method: 'GET'
      })
    },

    recognizeVoice: (data: { device_id: string; audio_data: string; recognition_mode?: string; format?: string; sample_rate?: number }) => {
      return this.request<any>({
        url: '/voice/recognize',
        method: 'POST',
        data
      })
    },

    textToSpeech: (data: { text: string; voice?: string; speed?: number }) => {
      return this.request<{ audio_url: string; duration: number }>({
        url: '/voice/tts',
        method: 'POST',
        data
      })
    }
  }

  public assistant = {
    explainSleepReport: (data: { deviceId: string; date?: string; question: string }) => {
      return this.request<AssistantSleepExplanation>({
        url: '/assistant/sleep-report/explain',
        method: 'POST',
        data
      })
    },

    controlDevice: (data: { deviceId: string; text: string; source?: 'voice' | 'text' }) => {
      return this.request<AssistantDeviceControlResponse>({
        url: '/assistant/device-control',
        method: 'POST',
        data
      })
    },

    askKnowledge: (data: { question: string; deviceId?: string }) => {
      return this.request<AssistantKnowledgeAnswer>({
        url: '/assistant/knowledge/ask',
        method: 'POST',
        data
      })
    }
  }

  public agents = {
    createRun: (data: {
      agentType: BusinessAgentType
      input: Record<string, unknown>
      workflowVersion?: string
    }) => {
      return this.request<AgentRunSummary>({
        url: '/agents/runs',
        method: 'POST',
        data
      })
    },

    getRun: (runId: string) => {
      return this.request<AgentRunDetail>({
        url: `/agents/runs/${encodeURIComponent(runId)}`,
        method: 'GET',
        retry: 0
      })
    }
  }

  public user = {
    getUserProfile: () => {
      return this.request<UserInfo>({
        url: '/users/profile',
        method: 'GET'
      })
    },

    updateUserProfile: (data: { nickname?: string; avatar?: string }) => {
      return this.request<UserInfo>({
        url: '/users/profile',
        method: 'PUT',
        data
      })
    },

    manageContacts: (data: { name: string; phone: string; relationship: string }) => {
      return this.request<Contact>({
        url: '/users/contacts',
        method: 'POST',
        data
      })
    },

    getContacts: () => {
      return this.request<{ contacts: Contact[] }>({
        url: '/users/contacts',
        method: 'GET'
      })
    },

    deleteContact: (contactId: string) => {
      return this.request<any>({
        url: `/users/contacts/${contactId}`,
        method: 'DELETE'
      })
    }
  }

  public ota = {
    checkUpdate: (deviceId: string) => {
      return this.request<OTAUpdateInfo>({
        url: `/ota/check/${deviceId}`,
        method: 'GET'
      })
    },

    reportProgress: (data: { device_id: string; version: string; progress: number; status: string }) => {
      return this.request<any>({
        url: '/ota/progress',
        method: 'POST',
        data
      })
    }
  }
}

export const api = new ApiClient()
