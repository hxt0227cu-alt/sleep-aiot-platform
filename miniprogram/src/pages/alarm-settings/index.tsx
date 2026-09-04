import React, { useState, useEffect } from 'react'
import { View, Text, Switch, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading, showModal } from '../../utils/util'
import Loading from '../../components/Loading'
import './index.scss'

type RepeatDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

interface Alarm {
  alarm_id: string
  name: string
  time: string
  enabled: boolean
  repeat_days: RepeatDay[]
  light_alarm_enabled: boolean
  light_alarm_duration: number
  sound_enabled: boolean
  sound_type: string
  created_at: number
}

const AlarmSettingsPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [alarms, setAlarms] = useState<Alarm[]>([])
  const [showAlarmModal, setShowAlarmModal] = useState(false)
  const [editingAlarm, setEditingAlarm] = useState<Alarm | null>(null)
  const [alarmForm, setAlarmForm] = useState({
    name: '闹钟',
    time: '07:00',
    enabled: true,
    repeat_days: [] as RepeatDay[],
    light_alarm_enabled: true,
    light_alarm_duration: 30,
    sound_enabled: true,
    sound_type: 'default',
  })

  const { currentDevice } = useDeviceStore()

  useEffect(() => {
    if (!currentDevice) {
      showToast('请先选择设备', 'error')
      Taro.navigateBack()
      return
    }
    loadAlarms()
  }, [currentDevice])

  const loadAlarms = async () => {
    try {
      setLoading(true)
      showLoading('加载中...')

      const result = await api.alarm.getAlarmConfig(currentDevice!.device_id)
      if (result.code === 200) {
        setAlarms(result.data.alarms || [])
      }
    } catch (error: any) {
      console.error('加载闹钟失败:', error)
      showToast('加载失败，请重试', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const handleAddAlarm = () => {
    setEditingAlarm(null)
    setAlarmForm({
      name: '闹钟',
      time: '07:00',
      enabled: true,
      repeat_days: [],
      light_alarm_enabled: true,
      light_alarm_duration: 30,
      sound_enabled: true,
      sound_type: 'default',
    })
    setShowAlarmModal(true)
  }

  const handleEditAlarm = (alarm: Alarm) => {
    setEditingAlarm(alarm)
    setAlarmForm({
      name: alarm.name,
      time: alarm.time,
      enabled: alarm.enabled,
      repeat_days: alarm.repeat_days,
      light_alarm_enabled: alarm.light_alarm_enabled,
      light_alarm_duration: alarm.light_alarm_duration,
      sound_enabled: alarm.sound_enabled,
      sound_type: alarm.sound_type,
    })
    setShowAlarmModal(true)
  }

  const handleDeleteAlarm = async (alarm: Alarm) => {
    const confirmed = await showModal('删除闹钟', `确定要删除"${alarm.name}"吗？`)
    if (!confirmed) return

    try {
      showLoading('删除中...')

      const result = await api.alarm.configAlarm({
        device_id: currentDevice!.device_id,
        rules: alarms.filter(a => a.alarm_id !== alarm.alarm_id).map(a => ({
          alarm_id: a.alarm_id,
          name: a.name,
          time: a.time,
          enabled: a.enabled,
          repeat_days: a.repeat_days,
          light_alarm_enabled: a.light_alarm_enabled,
          light_alarm_duration: a.light_alarm_duration,
          sound_enabled: a.sound_enabled,
          sound_type: a.sound_type,
        })),
      })

      if (result.code === 200) {
        showToast('删除成功', 'success')
        setAlarms(prev => prev.filter(a => a.alarm_id !== alarm.alarm_id))
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('删除闹钟失败:', error)
      showToast('删除失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleToggleAlarm = async (alarm: Alarm) => {
    try {
      const updatedAlarms = alarms.map(a =>
        a.alarm_id === alarm.alarm_id ? { ...a, enabled: !a.enabled } : a
      )

      const result = await api.alarm.configAlarm({
        device_id: currentDevice!.device_id,
        rules: updatedAlarms.map(a => ({
          alarm_id: a.alarm_id,
          name: a.name,
          time: a.time,
          enabled: a.enabled,
          repeat_days: a.repeat_days,
          light_alarm_enabled: a.light_alarm_enabled,
          light_alarm_duration: a.light_alarm_duration,
          sound_enabled: a.sound_enabled,
          sound_type: a.sound_type,
        })),
      })

      if (result.code === 200) {
        setAlarms(updatedAlarms)
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('切换闹钟状态失败:', error)
      showToast('操作失败，请重试', 'error')
    }
  }

  const handleSaveAlarm = async () => {
    if (!alarmForm.name.trim()) {
      showToast('请输入闹钟名称', 'error')
      return
    }

    try {
      showLoading('保存中...')

      let updatedAlarms: any[]

      if (editingAlarm) {
        updatedAlarms = alarms.map(a =>
          a.alarm_id === editingAlarm.alarm_id
            ? { ...alarmForm, alarm_id: editingAlarm.alarm_id }
            : a
        )
      } else {
        updatedAlarms = [
          ...alarms,
          { ...alarmForm, alarm_id: `alarm_${Date.now()}` },
        ]
      }

      const result = await api.alarm.configAlarm({
        device_id: currentDevice!.device_id,
        rules: updatedAlarms.map(a => ({
          alarm_id: a.alarm_id,
          name: a.name,
          time: a.time,
          enabled: a.enabled,
          repeat_days: a.repeat_days,
          light_alarm_enabled: a.light_alarm_enabled,
          light_alarm_duration: a.light_alarm_duration,
          sound_enabled: a.sound_enabled,
          sound_type: a.sound_type,
        })),
      })

      if (result.code === 200) {
        showToast('保存成功', 'success')
        setShowAlarmModal(false)
        loadAlarms()
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('保存闹钟失败:', error)
      showToast('保存失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleRepeatDayToggle = (day: RepeatDay) => {
    const newRepeatDays = alarmForm.repeat_days.includes(day)
      ? alarmForm.repeat_days.filter(d => d !== day)
      : [...alarmForm.repeat_days, day]

    setAlarmForm(prev => ({ ...prev, repeat_days: newRepeatDays }))
  }

  const getRepeatLabel = (repeatDays: RepeatDay[]): string => {
    if (repeatDays.length === 0) return '仅一次'
    if (repeatDays.length === 7) return '每天'

    const dayLabels: Record<RepeatDay, string> = {
      mon: '一',
      tue: '二',
      wed: '三',
      thu: '四',
      fri: '五',
      sat: '六',
      sun: '日',
    }

    return `周${repeatDays.map(d => dayLabels[d]).join(' ')}`
  }

  const getDayLabel = (day: RepeatDay): string => {
    const labels: Record<RepeatDay, string> = {
      mon: '一',
      tue: '二',
      wed: '三',
      thu: '四',
      fri: '五',
      sat: '六',
      sun: '日',
    }
    return labels[day]
  }

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  return (
    <View className='alarm-settings-page'>
      <View className='header-section'>
        <Text className='page-title'>闹钟设置</Text>
        <Text className='page-subtitle'>共{alarms.length}个闹钟</Text>
      </View>

      <ScrollView scrollY className='alarm-list'>
        {alarms.length === 0 ? (
          <View className='empty-state'>
            <Text className='empty-icon'>⏰</Text>
            <Text className='empty-text'>暂无闹钟</Text>
            <View className='empty-action' onClick={handleAddAlarm}>
              <Text className='action-text'>添加闹钟</Text>
            </View>
          </View>
        ) : (
          alarms.map((alarm) => (
            <View key={alarm.alarm_id} className='alarm-item'>
              <View className='alarm-main'>
                <View className='alarm-time-section'>
                  <Text className='alarm-time'>{alarm.time}</Text>
                  <Text className='alarm-repeat'>{getRepeatLabel(alarm.repeat_days)}</Text>
                </View>

                <View className='alarm-info'>
                  <Text className='alarm-name'>{alarm.name}</Text>
                  <View className='alarm-features'>
                    {alarm.light_alarm_enabled && (
                      <View className='feature-tag'>
                        <Text className='feature-icon'>💡</Text>
                        <Text className='feature-text'>光闹钟</Text>
                      </View>
                    )}
                    {alarm.sound_enabled && (
                      <View className='feature-tag'>
                        <Text className='feature-icon'>🔔</Text>
                        <Text className='feature-text'>声音</Text>
                      </View>
                    )}
                  </View>
                </View>
              </View>

              <View className='alarm-actions'>
                <Switch
                  className='alarm-switch'
                  checked={alarm.enabled}
                  onChange={() => handleToggleAlarm(alarm)}
                />
                <View className='action-buttons'>
                  <View
                    className='action-button edit'
                    onClick={() => handleEditAlarm(alarm)}
                  >
                    <Text className='action-icon'>✏️</Text>
                  </View>
                  <View
                    className='action-button delete'
                    onClick={() => handleDeleteAlarm(alarm)}
                  >
                    <Text className='action-icon'>🗑️</Text>
                  </View>
                </View>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <View className='add-button' onClick={handleAddAlarm}>
        <Text className='add-icon'>+</Text>
      </View>

      {showAlarmModal && (
        <View className='alarm-modal' onClick={() => setShowAlarmModal(false)}>
          <View className='modal-content' onClick={(e) => e.stopPropagation()}>
            <View className='modal-header'>
              <Text className='modal-title'>
                {editingAlarm ? '编辑闹钟' : '添加闹钟'}
              </Text>
              <View className='close-button' onClick={() => setShowAlarmModal(false)}>
                <Text className='close-icon'>✕</Text>
              </View>
            </View>

            <ScrollView scrollY className='modal-body'>
              <View className='form-section'>
                <Text className='section-title'>基本信息</Text>

                <View className='form-item'>
                  <Text className='form-label'>闹钟名称</Text>
                  <input
                    className='form-input'
                    type='text'
                    placeholder='请输入闹钟名称'
                    value={alarmForm.name}
                    onChange={(e) => setAlarmForm(prev => ({ ...prev, name: e.target.value }))}
                  />
                </View>

                <View className='form-item'>
                  <Text className='form-label'>时间</Text>
                  <input
                    className='form-input'
                    type='time'
                    value={alarmForm.time}
                    onChange={(e) => setAlarmForm(prev => ({ ...prev, time: e.target.value }))}
                  />
                </View>

                <View className='form-item'>
                  <Text className='form-label'>重复</Text>
                  <View className='repeat-days'>
                    {(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as RepeatDay[]).map((day) => (
                      <View
                        key={day}
                        className={`repeat-day ${alarmForm.repeat_days.includes(day) ? 'active' : ''}`}
                        onClick={() => handleRepeatDayToggle(day)}
                      >
                        <Text className='day-label'>{getDayLabel(day)}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              </View>

              <View className='form-section'>
                <Text className='section-title'>光闹钟设置</Text>

                <View className='form-item switch-item'>
                  <View className='switch-label'>
                    <Text className='label-text'>启用光闹钟</Text>
                    <Text className='label-desc'>通过渐亮灯光唤醒</Text>
                  </View>
                  <Switch
                    checked={alarmForm.light_alarm_enabled}
                    onChange={(e) => setAlarmForm(prev => ({ ...prev, light_alarm_enabled: e.detail.value }))}
                  />
                </View>

                {alarmForm.light_alarm_enabled && (
                  <View className='form-item'>
                    <Text className='form-label'>渐亮时长（分钟）</Text>
                    <input
                      className='form-input'
                      type='number'
                      placeholder='请输入时长'
                      value={alarmForm.light_alarm_duration}
                      onChange={(e) => setAlarmForm(prev => ({ ...prev, light_alarm_duration: Number(e.target.value) }))}
                    />
                  </View>
                )}
              </View>

              <View className='form-section'>
                <Text className='section-title'>声音设置</Text>

                <View className='form-item switch-item'>
                  <View className='switch-label'>
                    <Text className='label-text'>启用声音</Text>
                    <Text className='label-desc'>闹钟响起时播放声音</Text>
                  </View>
                  <Switch
                    checked={alarmForm.sound_enabled}
                    onChange={(e) => setAlarmForm(prev => ({ ...prev, sound_enabled: e.detail.value }))}
                  />
                </View>

                {alarmForm.sound_enabled && (
                  <View className='form-item'>
                    <Text className='form-label'>铃声类型</Text>
                    <View className='sound-types'>
                      {['default', 'nature', 'music', 'custom'].map((type) => (
                        <View
                          key={type}
                          className={`sound-type ${alarmForm.sound_type === type ? 'active' : ''}`}
                          onClick={() => setAlarmForm(prev => ({ ...prev, sound_type: type }))}
                        >
                          <Text className='type-label'>
                            {type === 'default' ? '默认' : type === 'nature' ? '自然' : type === 'music' ? '音乐' : '自定义'}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            </ScrollView>

            <View className='modal-footer'>
              <View className='modal-button cancel' onClick={() => setShowAlarmModal(false)}>
                <Text>取消</Text>
              </View>
              <View className='modal-button confirm' onClick={handleSaveAlarm}>
                <Text>保存</Text>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}

export default AlarmSettingsPage
