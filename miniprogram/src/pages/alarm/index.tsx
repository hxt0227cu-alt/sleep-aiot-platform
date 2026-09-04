import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useAlarmStore } from '../../store'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading, formatDate, formatAlarmLevel, formatAlarmType, formatAlarmLevelColor } from '../../utils/util'
import Loading from '../../components/Loading'
import './index.scss'

type FilterLevel = 'all' | 'critical' | 'warning' | 'info'

const AlarmPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [filterLevel, setFilterLevel] = useState<FilterLevel>('all')
  const [alarms, setAlarms] = useState<any[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)

  const { unreadCount } = useAlarmStore()

  useEffect(() => {
    loadAlarms()
  }, [filterLevel, page])

  const loadAlarms = async () => {
    try {
      setLoading(true)
      showLoading('加载中...')

      const result = await api.alarm.getAlarms({
        level: filterLevel === 'all' ? undefined : filterLevel,
        page,
        page_size: 20
      })

      if (result.code === 200) {
        setAlarms(result.data.alarms)
        setTotal(result.data.total)
        setHasMore(result.data.alarms.length >= 20)
        useAlarmStore.getState().setAlarms(result.data.alarms)
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('加载报警记录失败:', error)
      showToast('加载失败，请重试', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const handleFilterChange = (level: FilterLevel) => {
    setFilterLevel(level)
    setPage(1)
  }

  const handleLoadMore = () => {
    if (hasMore) {
      setPage(prev => prev + 1)
    }
  }

  const handleAlarmClick = (alarm: any) => {
    Taro.navigateTo({
      url: `/pages/alarm/detail/index?alarmId=${alarm.alarm_id}`
    })
  }

  const handleMarkAsRead = async (alarmId: string) => {
    try {
      showLoading('处理中...')
      
      const result = await api.alarm.handleAlarm(alarmId)
      if (result.code === 200) {
        useAlarmStore.getState().markAsRead(alarmId)
        showToast('已标记为已处理', 'success')
        
        setAlarms(prev => prev.map(a =>
          a.alarm_id === alarmId ? { ...a, status: 'handled' } : a
        ))
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

  const getFilterLabel = (level: FilterLevel): string => {
    const labels: Record<FilterLevel, string> = {
      all: '全部',
      critical: '严重',
      warning: '警告',
      info: '信息'
    }
    return labels[level]
  }

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  return (
    <View className='alarm-page'>
      <View className='header-section'>
        <View className='title-section'>
          <Text className='page-title'>报警记录</Text>
          <Text className='page-subtitle'>共{total}条报警，{unreadCount > 0 && ` ${unreadCount}条未读`}</Text>
        </View>
        
        <View className='filter-section'>
          {['all', 'critical', 'warning', 'info'].map((level) => (
            <View
              key={level}
              className={`filter-item ${filterLevel === level ? 'active' : ''}`}
              onClick={() => handleFilterChange(level as FilterLevel)}
            >
              <Text className='filter-text'>{getFilterLabel(level as FilterLevel)}</Text>
            </View>
          ))}
        </View>
      </View>

      <ScrollView scrollY className='scroll-container' onScrollToLower={() => {
        if (!hasMore && alarms.length >= 20) {
          handleLoadMore()
        }
      }}
      >
        {alarms.length === 0 ? (
          <View className='empty-state'>
            <Text className='empty-icon'>🔔</Text>
            <Text className='empty-text'>暂无报警记录</Text>
          </View>
        ) : (
          alarms.map((alarm) => (
            <View key={alarm.alarm_id} className='alarm-item'>
              <View className='alarm-header'>
                <View className={`alarm-level ${alarm.level}`}>
                  <Text className='level-text'>{formatAlarmLevel(alarm.level)}</Text>
                </View>
                <Text className='alarm-time'>
                  {formatDate(alarm.timestamp, 'MM-DD HH:mm')}
                </Text>
                <View className='alarm-status'>
                  <Text className={`status-text ${alarm.status}`}>
                    {alarm.status === 'pending' ? '未处理' : '已处理'}
                  </Text>
                </View>
              </View>
              
              <View className='alarm-content'>
                <View className='alarm-type'>
                  <Text className='type-label'>类型</Text>
                  <Text className='type-value'>{formatAlarmType(alarm.type)}</Text>
                </View>
                <View className='alarm-message'>
                  <Text className='message-text'>{alarm.message}</Text>
                </View>
                {alarm.value !== undefined && (
                  <View className='alarm-value'>
                    <Text className='value-label'>数值</Text>
                    <Text className='value-number'>{alarm.value}</Text>
                    <Text className='value-unit'>{alarm.unit || ''}</Text>
                  </View>
                )}
                {alarm.threshold !== undefined && (
                  <View className='alarm-threshold'>
                    <Text className='threshold-label'>阈值</Text>
                    <Text className='threshold-number'>{alarm.threshold}</Text>
                  </View>
                )}
              </View>
              
              <View className='alarm-actions'>
                <View
                  className={`action-button ${alarm.status === 'pending' ? '' : 'disabled'}`}
                  onClick={() => handleMarkAsRead(alarm.alarm_id)}
                >
                  <Text className='action-text'>标记已读</Text>
                </View>
                <View
                  className='action-button'
                  onClick={() => handleAlarmClick(alarm)}
                >
                  <Text className='action-text'>查看详情</Text>
                </View>
              </View>
            </View>
          ))
        )}
        
        {hasMore && (
          <View className='load-more'>
            <Text className='load-more-text'>加载更多</Text>
          </View>
        )}
      </ScrollView>
    </View>
  )
}

export default AlarmPage
