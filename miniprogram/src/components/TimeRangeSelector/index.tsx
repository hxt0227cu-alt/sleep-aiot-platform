import React from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

export type TimeRange = 'today' | 'week' | 'month' | 'custom'

export interface TimeRangeSelectorProps {
  value: TimeRange
  onChange: (range: TimeRange) => void
  customRange?: { start: Date; end: Date }
  onCustomRangeChange?: (range: { start: Date; end: Date }) => void
  showCustom?: boolean
}

const TimeRangeSelector: React.FC<TimeRangeSelectorProps> = ({
  value,
  onChange,
  customRange,
  onCustomRangeChange,
  showCustom = false
}) => {
  const ranges = [
    { key: 'today' as TimeRange, label: '今日' },
    { key: 'week' as TimeRange, label: '本周' },
    { key: 'month' as TimeRange, label: '本月' }
  ]

  if (showCustom) {
    ranges.push({ key: 'custom' as TimeRange, label: '自定义' })
  }

  const handleRangeClick = (range: TimeRange) => {
    if (range === 'custom') {
      showCustomDatePicker()
    } else {
      onChange(range)
    }
  }

  const showCustomDatePicker = () => {
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth()
    const currentDay = now.getDate()

    Taro.showModal({
      title: '选择日期范围',
      content: '请选择开始和结束日期',
      confirmText: '确定',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          // 显示开始日期选择器
          Taro.showModal({
            title: '选择开始日期',
            content: '请选择开始日期',
            confirmText: '选择',
            cancelText: '取消',
            success: (startRes) => {
              if (startRes.confirm) {
                // 这里应该使用日期选择器，但Taro的日期选择器API有限
                // 实际项目中可以使用第三方日期选择器组件
                onChange('custom')
              }
            }
          })
        }
      }
    })
  }

  const getRangeLabel = (): string => {
    switch (value) {
      case 'today':
        return '今日'
      case 'week':
        return '本周'
      case 'month':
        return '本月'
      case 'custom':
        if (customRange) {
          const startStr = `${customRange.start.getMonth() + 1}/${customRange.start.getDate()}`
          const endStr = `${customRange.end.getMonth() + 1}/${customRange.end.getDate()}`
          return `${startStr} - ${endStr}`
        }
        return '自定义'
      default:
        return '今日'
    }
  }

  return (
    <View className='time-range-selector'>
      <View className='selector-container'>
        {ranges.map((range) => (
          <View
            key={range.key}
            className={`range-item ${value === range.key ? 'active' : ''}`}
            onClick={() => handleRangeClick(range.key)}
          >
            <Text className='range-text'>{range.label}</Text>
          </View>
        ))}
      </View>

      {value === 'custom' && customRange && (
        <View className='custom-range-info'>
          <Text className='range-info-text'>
            {getRangeLabel()}
          </Text>
        </View>
      )}
    </View>
  )
}

export default TimeRangeSelector
