import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { api } from '../../../utils/api'
import { showToast, showLoading, hideLoading, formatDate } from '../../../utils/util'
import AlarmModal from '../../../components/AlarmModal'
import Loading from '../../../components/Loading'
import './index.scss'

const AlarmDetailPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [alarm, setAlarm] = useState<any>(null)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    const alarmId = Taro.getCurrentInstance().router?.params?.alarmId
    if (alarmId) {
      loadAlarmDetail(alarmId)
    }
  }, [])

  const loadAlarmDetail = async (alarmId: string) => {
    try {
      setLoading(true)
      showLoading('加载中...')

      const result = await api.alarm.getAlarmDetail(alarmId)
      if (result.code === 200) {
        setAlarm(result.data)
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('加载报警详情失败:', error)
      showToast('加载失败，请重试', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const handleMarkAsRead = async () => {
    if (!alarm) return

    try {
      showLoading('处理中...')

      const result = await api.alarm.handleAlarm(alarm.alarm_id)
      if (result.code === 200) {
        setAlarm({ ...alarm, status: 'handled' })
        showToast('已标记为已处理', 'success')
        setShowModal(false)
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('标记报警失败:', error)
      showToast('操作失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleDeleteAlarm = async () => {
    if (!alarm) return

    try {
      const confirmed = await Taro.showModal({
        title: '删除报警',
        content: '确定要删除这个报警吗？',
        confirmText: '删除',
        cancelText: '取消'
      })

      if (confirmed.confirm) {
        showLoading('删除中...')

        const result = await api.alarm.handleAlarm(alarm.alarm_id)
        if (result.code === 200) {
          showToast('删除成功', 'success')
          Taro.navigateBack()
        } else {
          showToast(result.message, 'error')
        }
      }
    } catch (error: any) {
      console.error('删除报警失败:', error)
      showToast('删除失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  if (!alarm) {
    return (
      <View className='alarm-detail-page'>
        <View className='empty-state'>
          <Text className='empty-icon'>🔔</Text>
          <Text className='empty-text'>报警不存在</Text>
        </View>
      </View>
    )
  }

  return (
    <View className='alarm-detail-page'>
      <ScrollView scrollY className='scroll-container'>
        <View className='header-section'>
          <View className='back-button' onClick={() => Taro.navigateBack()}>
            <Text className='back-icon'>←</Text>
          </View>
          <View className='page-title'>
            <Text className='title-text'>报警详情</Text>
          </View>
        </View>

        <View className='content-section'>
          <View className='alarm-card'>
            <View className='alarm-header'>
              <View className={`alarm-level ${alarm.level}`}>
                <Text className='level-text'>
                  {alarm.level === 'critical' ? '严重' : alarm.level === 'warning' ? '警告' : '信息'}
                </Text>
              </View>
              <Text className='alarm-time'>
                {formatDate(alarm.timestamp, 'MM-DD HH:mm:ss')}
              </Text>
            </View>
          </View>

          <View className='alarm-info'>
            <View className='info-row'>
              <Text className='info-label'>报警类型</Text>
              <Text className='info-value'>{alarm.type}</Text>
            </View>
            
            <View className='info-row'>
              <Text className='info-label'>报警消息</Text>
              <Text className='info-value'>{alarm.message}</Text>
            </View>
            
            {alarm.value !== undefined && (
              <View className='info-row'>
                <Text className='info-label'>当前值</Text>
                <Text className='info-value'>{alarm.value}</Text>
              </View>
            )}
            
            {alarm.threshold !== undefined && (
              <View className='info-row'>
                <Text className='info-label'>阈值</Text>
                <Text className='info-value'>{alarm.threshold}</Text>
              </View>
            )}
            
            <View className='info-row'>
              <Text className='info-label'>状态</Text>
              <Text className={`info-value ${alarm.status}`}>
                {alarm.status === 'pending' ? '未处理' : '已处理'}
              </Text>
            </View>
          </View>

          <View className='alarm-actions'>
            {alarm.status === 'pending' && (
              <View className='action-button primary' onClick={handleMarkAsRead}>
                <Text className='action-text'>标记已读</Text>
              </View>
            )}
            
            <View className='action-button danger' onClick={handleDeleteAlarm}>
              <Text className='action-text'>删除</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      {showModal && (
        <AlarmModal
          visible={showModal}
          alarm={alarm}
          onConfirm={() => handleMarkAsRead()}
          onCancel={() => setShowModal(false)}
        />
      )}
    </View>
  )
}

export default AlarmDetailPage
