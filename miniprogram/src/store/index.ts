import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { UserInfo, DeviceInfo, VitalSigns, Alarm } from '../types'
import { storage } from '../utils/util'
import { STORAGE_KEYS } from '../utils/constants'

interface UserState {
  userInfo: UserInfo | null
  token: string | null
  isAuthenticated: boolean
  setUserInfo: (userInfo: UserInfo) => void
  setToken: (token: string) => void
  logout: () => void
}

export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      userInfo: null,
      token: null,
      isAuthenticated: false,

      setUserInfo: (userInfo) => {
        set({ userInfo, isAuthenticated: true })
        storage.set(STORAGE_KEYS.USER_INFO, userInfo)
      },

      setToken: (token) => {
        set({ token, isAuthenticated: !!token })
        storage.set(STORAGE_KEYS.TOKEN, token)
      },

      logout: () => {
        set({ userInfo: null, token: null, isAuthenticated: false })
        storage.remove(STORAGE_KEYS.USER_INFO)
        storage.remove(STORAGE_KEYS.TOKEN)
        storage.remove(STORAGE_KEYS.REFRESH_TOKEN)
      }
    }),
    {
      name: 'user-storage',
      storage: createJSONStorage(() => ({
        getItem: async (name) => {
          const value = await storage.get<string>(name)
          return value || null
        },
        setItem: async (name, value) => {
          await storage.set(name, value)
        },
        removeItem: async (name) => {
          await storage.remove(name)
        }
      }))
    }
  )
)

interface DeviceState {
  devices: DeviceInfo[]
  currentDevice: DeviceInfo | null
  deviceStatus: Record<string, any>
  bindingStatus: Record<string, 'pending' | 'bound' | 'unbound'>
  setDevices: (devices: DeviceInfo[]) => void
  setCurrentDevice: (device: DeviceInfo | null) => void
  updateDeviceStatus: (deviceId: string, status: any) => void
  addDevice: (device: DeviceInfo) => void
  removeDevice: (deviceId: string) => void
  updateBindingStatus: (deviceId: string, status: 'pending' | 'bound' | 'unbound') => void
  getBindingStatus: (deviceId: string) => 'pending' | 'bound' | 'unbound' | undefined
}

export const useDeviceStore = create<DeviceState>()(
  persist(
    (set, get) => ({
      devices: [],
      currentDevice: null,
      deviceStatus: {},
      bindingStatus: {},

      setDevices: (devices) => set({ devices }),

      setCurrentDevice: (device) => {
        set({ currentDevice: device })
        if (device) {
          storage.set(STORAGE_KEYS.DEVICE_ID, device.device_id)
        } else {
          storage.remove(STORAGE_KEYS.DEVICE_ID)
        }
      },

      updateDeviceStatus: (deviceId, status) => {
        set((state) => ({
          deviceStatus: {
            ...state.deviceStatus,
            [deviceId]: status
          }
        }))
      },

      addDevice: (device) => {
        set((state) => ({
          devices: [...state.devices, device]
        }))
      },

      removeDevice: (deviceId) => {
        set((state) => ({
          devices: state.devices.filter(d => d.device_id !== deviceId),
          currentDevice: state.currentDevice?.device_id === deviceId ? null : state.currentDevice
        }))
      },

      updateBindingStatus: (deviceId, status) => {
        set((state) => ({
          bindingStatus: {
            ...state.bindingStatus,
            [deviceId]: status
          }
        }))
      },

      getBindingStatus: (deviceId) => {
        return get().bindingStatus[deviceId]
      }
    }),
    {
      name: 'device-storage',
      storage: createJSONStorage(() => ({
        getItem: async (name) => {
          const value = await storage.get<string>(name)
          return value || null
        },
        setItem: async (name, value) => {
          await storage.set(name, value)
        },
        removeItem: async (name) => {
          await storage.remove(name)
        }
      }))
    }
  )
)

interface SleepDataState {
  realtimeData: VitalSigns | null
  historyData: any
  sleepReport: any
  setRealtimeData: (data: VitalSigns) => void
  setHistoryData: (data: any) => void
  setSleepReport: (report: any) => void
  clearRealtimeData: () => void
}

export const useSleepDataStore = create<SleepDataState>((set) => ({
  realtimeData: null,
  historyData: null,
  sleepReport: null,

  setRealtimeData: (data) => set({ realtimeData: data }),

  setHistoryData: (data) => set({ historyData: data }),

  setSleepReport: (report) => set({ sleepReport: report }),

  clearRealtimeData: () => set({ realtimeData: null })
}))

interface AlarmState {
  alarms: Alarm[]
  unreadCount: number
  setAlarms: (alarms: Alarm[]) => void
  addAlarm: (alarm: Alarm) => void
  markAsRead: (alarmId: string) => void
  clearAlarms: () => void
}

export const useAlarmStore = create<AlarmState>((set) => ({
  alarms: [],
  unreadCount: 0,

  setAlarms: (alarms) => {
    const unreadCount = alarms.filter(a => a.status === 'pending').length
    set({ alarms, unreadCount })
  },

  addAlarm: (alarm) => {
    set((state) => ({
      alarms: [alarm, ...state.alarms],
      unreadCount: state.unreadCount + 1
    }))
  },

  markAsRead: (alarmId) => {
    set((state) => ({
      alarms: state.alarms.map(a =>
        a.alarm_id === alarmId ? { ...a, status: 'handled' } : a
      ),
      unreadCount: Math.max(0, state.unreadCount - 1)
    }))
  },

  clearAlarms: () => set({ alarms: [], unreadCount: 0 })
}))

interface WebSocketState {
  connected: boolean
  connecting: boolean
  setConnected: (connected: boolean) => void
  setConnecting: (connecting: boolean) => void
}

export const useWebSocketStore = create<WebSocketState>((set) => ({
  connected: false,
  connecting: false,

  setConnected: (connected) => set({ connected }),

  setConnecting: (connecting) => set({ connecting })
}))
