import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, ScrollView, Picker, Slider, Switch } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading } from '../../utils/util'
import Loading from '../../components/Loading'
import type { LightAlarm } from '../../types'
import './index.scss'

const MODE_OPTIONS = [
  { label: '柔和唤醒', brightness: 50, colorTemp: 3000 },
  { label: '强力唤醒', brightness: 100, colorTemp: 5200 },
  { label: '助眠模式', brightness: 15, colorTemp: 2700 }
] as const

const DEFAULT_FORM = {
  time: '07:00',
  mode: MODE_OPTIONS[0].label,
  enabled: true,
  target_brightness: MODE_OPTIONS[0].brightness,
  target_color_temp: MODE_OPTIONS[0].colorTemp,
  ramp_minutes: 20
}

const normalizeAlarm = (alarm: any): LightAlarm => ({
  alarm_id: alarm?.alarm_id || alarm?.alarmId || alarm?.id || '',
  device_id: alarm?.device_id || alarm?.deviceId || '',
  time: alarm?.time || DEFAULT_FORM.time,
  mode: alarm?.mode || DEFAULT_FORM.mode,
  enabled: Boolean(alarm?.enabled ?? true),
  target_brightness: Number(alarm?.target_brightness ?? alarm?.brightness_target ?? DEFAULT_FORM.target_brightness),
  target_color_temp: Number(alarm?.target_color_temp ?? alarm?.color_temp_target ?? DEFAULT_FORM.target_color_temp),
  ramp_minutes: Number(alarm?.ramp_minutes ?? alarm?.rampMinutes ?? DEFAULT_FORM.ramp_minutes)
})

const LightAlarmPage: React.FC = () => {
  const { currentDevice } = useDeviceStore()
  const [loading, setLoading] = useState(true)
  const [alarms, setAlarms] = useState<LightAlarm[]>([])
  const [showModal, setShowModal] = useState(false)
  const [editingAlarm, setEditingAlarm] = useState<LightAlarm | null>(null)
  const [form, setForm] = useState<LightAlarm>({ alarm_id: '', ...DEFAULT_FORM })

  const deviceId = useMemo(
    () => currentDevice?.device_id || (currentDevice as any)?.deviceId || '',
    [currentDevice]
  )

  useEffect(() => {
    if (!deviceId) {
      Taro.switchTab({ url: '/pages/index/index' })
      return
    }
    loadAlarms()
  }, [deviceId])

  const loadAlarms = async () => {
    if (!deviceId) return

    try {
      setLoading(true)
      showLoading('加载中...')
      const result = await api.device.getLightAlarms(deviceId)
      if (result.code === 200) {
        setAlarms((result.data || []).map((alarm: any) => normalizeAlarm(alarm)))
      }
    } catch (error) {
      console.error('load light alarms failed', error)
      showToast('加载失败，请重试', 'error')
    } finally {
      hideLoading()
      setLoading(false)
    }
  }

  const resetForm = () => {
    setEditingAlarm(null)
    setForm({ alarm_id: '', ...DEFAULT_FORM })
  }

  const openCreate = () => {
    resetForm()
    setShowModal(true)
  }

  const openEdit = (alarm: LightAlarm) => {
    setEditingAlarm(alarm)
    setForm(normalizeAlarm(alarm))
    setShowModal(true)
  }

  const closeModal = () => {
    setShowModal(false)
    resetForm()
  }

  const handleModeChange = (mode: string) => {
    const preset = MODE_OPTIONS.find((item) => item.label === mode)
    setForm((prev) => ({
      ...prev,
      mode,
      target_brightness: preset?.brightness ?? prev.target_brightness,
      target_color_temp: preset?.colorTemp ?? prev.target_color_temp
    }))
  }

  const handleSave = async () => {
    if (!deviceId) return

    try {
      showLoading(editingAlarm ? '保存中...' : '创建中...')

      const payload = {
        time: form.time,
        mode: form.mode,
        enabled: form.enabled,
        brightness_target: form.target_brightness,
        color_temp_target: form.target_color_temp,
        ramp_minutes: form.ramp_minutes
      }

      const result = editingAlarm
        ? await api.device.updateLightAlarm(deviceId, editingAlarm.alarm_id, payload)
        : await api.device.createLightAlarm(deviceId, payload)

      if (result.code === 200 || result.code === 201) {
        showToast(editingAlarm ? '修改成功' : '添加成功', 'success')
        closeModal()
        await loadAlarms()
      } else {
        showToast(result.message || '保存失败', 'error')
      }
    } catch (error) {
      console.error('save light alarm failed', error)
      showToast('保存失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleDelete = async (alarm: LightAlarm) => {
    if (!deviceId) return

    const confirmed = await Taro.showModal({
      title: '删除光闹钟',
      content: `确定删除 ${alarm.time} 的光闹钟吗？`,
      confirmText: '删除',
      cancelText: '取消'
    })

    if (!confirmed.confirm) return

    try {
      showLoading('删除中...')
      const result = await api.device.deleteLightAlarm(deviceId, alarm.alarm_id)
      if (result.code === 200) {
        showToast('删除成功', 'success')
        await loadAlarms()
      } else {
        showToast(result.message || '删除失败', 'error')
      }
    } catch (error) {
      console.error('delete light alarm failed', error)
      showToast('删除失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleToggle = async (alarm: LightAlarm) => {
    if (!deviceId) return

    try {
      const nextEnabled = !alarm.enabled
      const result = await api.device.updateLightAlarmEnabled(
        deviceId,
        alarm.alarm_id,
        nextEnabled
      )

      if (result.code === 200) {
        setAlarms((prev) =>
          prev.map((item) =>
            item.alarm_id === alarm.alarm_id ? { ...item, enabled: nextEnabled } : item
          )
        )
      } else {
        showToast(result.message || '操作失败', 'error')
      }
    } catch (error) {
      console.error('toggle light alarm failed', error)
      showToast('操作失败，请重试', 'error')
    }
  }

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  return (
    <View className='light-alarm-page'>
      <ScrollView scrollY className='scroll-container'>
        <View className='header-section'>
          <View className='title-section'>
            <Text className='page-title'>光闹钟</Text>
            <Text className='page-subtitle'>通过设备本地计划执行渐亮唤醒</Text>
          </View>

          <View className='add-button' onClick={openCreate}>
            <Text className='add-icon'>+</Text>
            <Text className='add-text'>添加闹钟</Text>
          </View>
        </View>

        {alarms.length === 0 ? (
          <View className='empty-state'>
            <Text className='empty-icon'>铃</Text>
            <Text className='empty-text'>还没有光闹钟</Text>
            <View className='empty-action' onClick={openCreate}>
              <Text className='action-text'>去添加</Text>
            </View>
          </View>
        ) : (
          <View className='alarms-list'>
            {alarms.map((alarm) => (
              <View key={alarm.alarm_id} className='alarm-card'>
                <View className='alarm-header'>
                  <View className='alarm-time'>
                    <Text className='time-text'>{alarm.time}</Text>
                    <Text className='info-value'>{alarm.mode}</Text>
                  </View>
                  <View className={`alarm-status ${alarm.enabled ? 'enabled' : 'disabled'}`}>
                    <Text className='status-text'>{alarm.enabled ? '已启用' : '已停用'}</Text>
                  </View>
                </View>

                <View className='alarm-info'>
                  <View className='info-item'>
                    <Text className='info-label'>渐亮时长</Text>
                    <Text className='info-value'>{alarm.ramp_minutes} 分钟</Text>
                  </View>
                  <View className='info-item'>
                    <Text className='info-label'>目标亮度</Text>
                    <Text className='info-value'>{alarm.target_brightness}%</Text>
                  </View>
                  <View className='info-item'>
                    <Text className='info-label'>目标色温</Text>
                    <Text className='info-value'>{alarm.target_color_temp}K</Text>
                  </View>
                </View>

                <View className='alarm-actions'>
                  <View className='action-button toggle' onClick={() => handleToggle(alarm)}>
                    <Text className='button-text'>{alarm.enabled ? '停用' : '启用'}</Text>
                  </View>
                  <View className='action-button edit' onClick={() => openEdit(alarm)}>
                    <Text className='button-text'>编辑</Text>
                  </View>
                  <View className='action-button delete' onClick={() => handleDelete(alarm)}>
                    <Text className='button-text'>删除</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {showModal && (
        <View className='alarm-modal' onClick={closeModal}>
          <View className='modal-content' onClick={(e) => e.stopPropagation()}>
            <View className='modal-header'>
              <Text className='modal-title'>{editingAlarm ? '编辑光闹钟' : '添加光闹钟'}</Text>
              <View className='close-button' onClick={closeModal}>
                <Text className='close-icon'>×</Text>
              </View>
            </View>

            <View className='modal-body'>
              <View className='form-group'>
                <Text className='form-label'>闹钟时间</Text>
                <Picker mode='time' value={form.time} onChange={(e) => setForm((prev) => ({ ...prev, time: e.detail.value }))}>
                  <View className='picker-trigger'>
                    <Text className='picker-text'>{form.time}</Text>
                  </View>
                </Picker>
              </View>

              <View className='form-group'>
                <Text className='form-label'>唤醒模式</Text>
                <View className='duration-options'>
                  {MODE_OPTIONS.map((option) => (
                    <View
                      key={option.label}
                      className={`duration-item ${form.mode === option.label ? 'selected' : ''}`}
                      onClick={() => handleModeChange(option.label)}
                    >
                      <Text className='duration-text'>{option.label}</Text>
                    </View>
                  ))}
                </View>
              </View>

              <View className='form-group'>
                <Text className='form-label'>渐亮时长</Text>
                <View className='duration-options'>
                  {[10, 15, 20, 30].map((duration) => (
                    <View
                      key={duration}
                      className={`duration-item ${form.ramp_minutes === duration ? 'selected' : ''}`}
                      onClick={() => setForm((prev) => ({ ...prev, ramp_minutes: duration }))}
                    >
                      <Text className='duration-text'>{duration} 分钟</Text>
                    </View>
                  ))}
                </View>
              </View>

              <View className='form-group'>
                <Text className='form-label'>目标亮度</Text>
                <View className='slider-card'>
                  <View className='card-header'>
                    <Text className='label'>亮度</Text>
                    <Text className='value'>{form.target_brightness}%</Text>
                  </View>
                  <Slider
                    value={form.target_brightness}
                    min={0}
                    max={100}
                    step={1}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, target_brightness: Number(e.detail.value) }))
                    }
                  />
                </View>
              </View>

              <View className='form-group'>
                <Text className='form-label'>目标色温</Text>
                <View className='slider-card'>
                  <View className='card-header'>
                    <Text className='label'>色温</Text>
                    <Text className='value'>{form.target_color_temp}K</Text>
                  </View>
                  <Slider
                    value={form.target_color_temp}
                    min={2700}
                    max={6500}
                    step={100}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, target_color_temp: Number(e.detail.value) }))
                    }
                  />
                </View>
              </View>

              <View className='form-group'>
                <View className='toggle-switch'>
                  <Switch
                    checked={form.enabled}
                    onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.detail.value }))}
                  />
                  <Text className='switch-label'>启用闹钟</Text>
                </View>
              </View>
            </View>

            <View className='modal-footer'>
              <View className='modal-button cancel' onClick={closeModal}>
                <Text>取消</Text>
              </View>
              <View className='modal-button confirm' onClick={handleSave}>
                <Text>保存</Text>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}

export default LightAlarmPage
