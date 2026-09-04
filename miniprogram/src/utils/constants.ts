export const API_BASE_URL = 'https://taiyizhi.com/api'
export const WS_BASE_URL = 'wss://taiyizhi.com/ws'

export const STORAGE_KEYS = {
  TOKEN: 'token',
  REFRESH_TOKEN: 'refresh_token',
  USER_INFO: 'user_info',
  DEVICE_ID: 'device_id',
  SETTINGS: 'settings'
}

export const ERROR_CODES = {
  SUCCESS: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  DEVICE_NOT_BOUND: 1001,
  DEVICE_OFFLINE: 1002,
  COMMAND_FAILED: 1003,
  QUERY_TIMEOUT: 1004
}

export const SLEEP_STATES = {
  AWAKE: 'awake',
  LIGHT_SLEEP: 'light_sleep',
  DEEP_SLEEP: 'deep_sleep',
  REM_SLEEP: 'rem_sleep'
}

export const ALARM_LEVELS = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
}

export const ALARM_TYPES = {
  HEART_RATE_HIGH: 'heart_rate_high',
  HEART_RATE_LOW: 'heart_rate_low',
  BREATHING_RATE_HIGH: 'breathing_rate_high',
  BREATHING_RATE_LOW: 'breathing_rate_low',
  NO_MOVEMENT: 'no_movement',
  DEVICE_OFFLINE: 'device_offline'
}

export const WHITE_NOISE_CATEGORIES = {
  NATURE: 'nature',
  MECHANICAL: 'mechanical',
  MUSIC: 'music'
}

export const FADE_DURATIONS = [10, 20, 30]

export const REPEAT_DAYS = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 0 }
]
