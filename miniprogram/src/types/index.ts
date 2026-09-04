export interface ApiResponse<T = any> {
  code: number
  message: string
  data: T
  timestamp: number
}

export interface UserInfo {
  user_id: string
  nickname: string
  avatar: string
  phone: string
  wechat_openid?: string
}

export interface DeviceInfo {
  device_id: string
  device_name: string
  device_type: string
  online: boolean
  last_seen: number
  firmware_version: string
  location?: string
  hardware_info?: {
    chip_id: string
    mac_address: string
    psram_size: string
  }
  network_info?: {
    wifi_ssid: string
    signal_strength: number
    ip_address: string
  }
  status?: {
    light: {
      on?: boolean
      power: boolean
      brightness: number
      color_temp: number
    }
    anion: {
      power: boolean
    }
    voice: {
      enabled: boolean
      wakeup_word: string
    }
    light_alarms?: LightAlarm[]
  }
  light_state?: {
    on?: boolean
    power?: boolean
    brightness?: number
    color_temp?: number
    scene?: string
  }
  binding_status?: 'pending' | 'bound' | 'unbound'
  binding_code?: string
}

export interface DeviceBindRequest {
  device_id?: string
  deviceId?: string
  binding_code?: string
  bindingCode?: string
}

export interface DeviceBindResponse {
  device_id: string
  device_name: string
  binding_status: string
}

export interface OTAUpdateInfo {
  latest_version: string
  current_version: string
  update_type: 'incremental' | 'full'
  file_size: number
  release_notes: string
  force_update: boolean
}

export interface VitalSigns {
  heart_rate: {
    value: number
    unit: string
    status: string
  }
  breathing_rate: {
    value: number
    unit: string
    status: string
  }
  body_movement: {
    value: number
    unit: string
    status: string
  }
  sleep_state: {
    state: string
    confidence: number
  }
}

export interface SleepReport {
  device_id: string
  date: string
  sleep_score: number
  sleep_duration: {
    total: number
    deep_sleep: number
    light_sleep: number
    rem_sleep: number
    awake: number
  }
  sleep_efficiency: number
  sleep_latency: number
  awakenings: number
  sleep_structure: Array<{
    state: string
    start_time: string
    end_time: string
    duration: number
  }>
  vital_signs: {
    avg_heart_rate: number
    min_heart_rate: number
    max_heart_rate: number
    avg_breathing_rate: number
    min_breathing_rate: number
    max_breathing_rate: number
  }
  health_suggestions: string[]
}

export interface Alarm {
  alarm_id: string
  device_id: string
  type: string
  level: string
  message: string
  value?: number
  threshold?: number
  timestamp: number
  status: string
  handled_by?: string
  handled_at?: number
}

export interface WhiteNoise {
  id: string
  name: string
  category: string
  duration: number
  url: string
  cover: string
}

export interface Contact {
  contact_id: string
  name: string
  phone: string
  relationship: string
}

export interface LightAlarm {
  alarm_id: string
  device_id?: string
  time: string
  mode?: string
  enabled: boolean
  target_brightness: number
  brightness_target?: number
  target_color_temp: number
  color_temp_target?: number
  ramp_minutes?: number
  rampMinutes?: number
  repeat_days?: number[]
  fade_duration?: number
  label?: string
  type?: 'normal' | 'light' | string
}

export interface LightScene {
  id: string
  name: string
  brightness: number
  colorTemp: number
  icon: string
  description: string
}

export interface AssistantSleepExplanation {
  deviceId: string
  reportDate: string
  question: string
  answer: string
  keyFindings: string[]
  recommendations: string[]
  caution: string
}

export interface AssistantScheduledAction {
  id: string
  actionType: string
  command: string
  params: Record<string, any>
  executeAt: number
  status: string
  summary: string
}

export interface AssistantDeviceImmediateResult {
  command: string
  params: Record<string, any>
  summary: string
  result: Record<string, any>
}

export interface AssistantDeviceControlResponse {
  requestId: string
  deviceId: string
  text: string
  source: 'voice' | 'text'
  toolCall: {
    name: string
    arguments: Record<string, any>
  }
  summary: string[]
  immediateResults: AssistantDeviceImmediateResult[]
  scheduledActions: AssistantScheduledAction[]
}

export interface KnowledgeAnswerSource {
  title: string
  path: string
  section: string
}

export interface AssistantKnowledgeAnswer {
  answer: string
  sources: KnowledgeAnswerSource[]
  matchedTopics: string[]
  deviceId?: string | null
}

export type BusinessAgentType =
  | 'sleep_report'
  | 'sleep_improvement'
  | 'voice_companion'

export interface AgentRunSummary {
  runId: string
  status: string
  tenantId?: string
  queuedAt?: string
}

export interface AgentRunDetail {
  id: string
  status: string
  agentType: BusinessAgentType
  output?: {
    businessResult?: Record<string, any>
    evidence?: string
  }
  errorMessage?: string
}
