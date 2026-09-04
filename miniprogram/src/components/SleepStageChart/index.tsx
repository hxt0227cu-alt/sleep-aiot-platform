import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Canvas } from '@tarojs/components'
import Taro from '@tarojs/taro'
import * as echarts from 'echarts-for-weixin'
import './index.scss'

export interface SleepStageData {
  state: 'deep_sleep' | 'light_sleep' | 'rem_sleep' | 'awake'
  start_time: number
  end_time: number
  duration: number
}

export interface SleepStageChartProps {
  data: SleepStageData[]
  height?: number
  showTooltip?: boolean
  onStageClick?: (stage: SleepStageData) => void
}

const SleepStageChart: React.FC<SleepStageChartProps> = ({
  data,
  height = 200,
  showTooltip = true,
  onStageClick
}) => {
  const chartInstanceRef = useRef<any>(null)
  const [chartId] = useState(() => `sleep-stage-chart-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)

  useEffect(() => {
    if (!data || data.length === 0) return

    const timer = setTimeout(() => {
      initChart()
    }, 100)

    return () => {
      clearTimeout(timer)
      if (chartInstanceRef.current) {
        chartInstanceRef.current.dispose()
        chartInstanceRef.current = null
      }
    }
  }, [data])

  const initChart = () => {
    try {
      const query = Taro.createSelectorQuery()
      query.select(`#${chartId}`)
        .fields({ node: true, size: true })
        .exec((res) => {
          if (res && res[0] && res[0].node) {
            const canvasNode = res[0].node
            const canvasContext = canvasNode.getContext('2d')

            const chartInstance = echarts.init(canvasContext, null, {
              width: res[0].width,
              height: res[0].height,
              renderer: 'canvas'
            })

            chartInstanceRef.current = chartInstance

            const option = getChartOption()
            chartInstance.setOption(option)

            // 添加点击事件
            if (onStageClick) {
              chartInstance.on('click', (params: any) => {
                if (params.dataIndex >= 0 && params.dataIndex < data.length) {
                  onStageClick(data[params.dataIndex])
                }
              })
            }
          } else {
            console.warn('Canvas node not found')
          }
        })
    } catch (error) {
      console.error('Sleep stage chart initialization error:', error)
    }
  }

  const getChartOption = () => {
    const stageColors: Record<string, string> = {
      deep_sleep: '#10b981',
      light_sleep: '#3b82f6',
      rem_sleep: '#8b5cf6',
      awake: '#6b7280'
    }

    const stageLabels: Record<string, string> = {
      deep_sleep: '深睡',
      light_sleep: '浅睡',
      rem_sleep: '快速眼动',
      awake: '清醒'
    }

    const totalDuration = data.reduce((sum, item) => sum + item.duration, 0)

    // 准备数据
    const xAxisData = data.map((item, index) => index)
    const seriesData = data.map((item, index) => ({
      value: item.duration,
      name: stageLabels[item.state],
      itemStyle: {
        color: stageColors[item.state]
      },
      // 自定义数据属性
      state: item.state,
      startTime: item.start_time,
      endTime: item.end_time,
      duration: item.duration
    }))

    return {
      backgroundColor: 'transparent',
      tooltip: {
        show: showTooltip,
        trigger: 'item',
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        borderColor: '#333',
        borderWidth: 1,
        textStyle: {
          color: '#fff',
          fontSize: 12
        },
        formatter: (params: any) => {
          if (params.data) {
            const { state, startTime, endTime, duration } = params.data
            return `
              <div style="padding: 8px;">
                <div style="margin-bottom: 4px; font-weight: bold;">${stageLabels[state]}</div>
                <div style="margin-bottom: 4px;">时长: ${formatDuration(duration)}</div>
                <div style="margin-bottom: 4px;">开始: ${formatTime(startTime)}</div>
                <div>结束: ${formatTime(endTime)}</div>
              </div>
            `
          }
          return ''
        }
      },
      grid: {
        left: '5%',
        right: '5%',
        bottom: '15%',
        top: '10%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        data: xAxisData,
        show: false
      },
      yAxis: {
        type: 'value',
        show: false
      },
      series: [
        {
          type: 'bar',
          barWidth: '90%',
          data: seriesData,
          label: {
            show: true,
            position: 'inside',
            formatter: (params: any) => {
              const percentage = (params.value / totalDuration * 100).toFixed(1)
              return `${percentage}%`
            },
            color: '#fff',
            fontSize: 10,
            fontWeight: 'bold'
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: 'rgba(0, 0, 0, 0.5)'
            }
          }
        }
      ],
      // 添加图例
      legend: {
        show: true,
        orient: 'horizontal',
        bottom: 0,
        itemGap: 15,
        textStyle: {
          color: '#6b7280',
          fontSize: 11
        },
        data: Object.keys(stageLabels).map(key => ({
          name: stageLabels[key],
          itemStyle: {
            color: stageColors[key]
          }
        }))
      }
    }
  }

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  }

  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)

    if (hours > 0) {
      return `${hours}h ${minutes}m`
    } else {
      return `${minutes}m`
    }
  }

  // 计算各阶段统计信息
  const getStageStats = () => {
    const stats: Record<string, { count: number; totalDuration: number }> = {
      deep_sleep: { count: 0, totalDuration: 0 },
      light_sleep: { count: 0, totalDuration: 0 },
      rem_sleep: { count: 0, totalDuration: 0 },
      awake: { count: 0, totalDuration: 0 }
    }

    data.forEach(item => {
      if (stats[item.state]) {
        stats[item.state].count += 1
        stats[item.state].totalDuration += item.duration
      }
    })

    return stats
  }

  const stageStats = getStageStats()
  const totalDuration = data.reduce((sum, item) => sum + item.duration, 0)

  return (
    <View className='sleep-stage-chart'>
      <View className='chart-container'>
        <Canvas
          id={chartId}
          canvasId={chartId}
          style={{ width: '100%', height: `${height}px` }}
        />
      </View>

      <View className='stage-stats'>
        <View className='stat-item'>
          <View className='stat-indicator' style={{ backgroundColor: '#10b981' }} />
          <View className='stat-info'>
            <Text className='stat-label'>深睡</Text>
            <Text className='stat-value'>{formatDuration(stageStats.deep_sleep.totalDuration)}</Text>
            <Text className='stat-percent'>
              {totalDuration > 0 ? `${(stageStats.deep_sleep.totalDuration / totalDuration * 100).toFixed(1)}%` : '0%'}
            </Text>
          </View>
        </View>

        <View className='stat-item'>
          <View className='stat-indicator' style={{ backgroundColor: '#3b82f6' }} />
          <View className='stat-info'>
            <Text className='stat-label'>浅睡</Text>
            <Text className='stat-value'>{formatDuration(stageStats.light_sleep.totalDuration)}</Text>
            <Text className='stat-percent'>
              {totalDuration > 0 ? `${(stageStats.light_sleep.totalDuration / totalDuration * 100).toFixed(1)}%` : '0%'}
            </Text>
          </View>
        </View>

        <View className='stat-item'>
          <View className='stat-indicator' style={{ backgroundColor: '#8b5cf6' }} />
          <View className='stat-info'>
            <Text className='stat-label'>快速眼动</Text>
            <Text className='stat-value'>{formatDuration(stageStats.rem_sleep.totalDuration)}</Text>
            <Text className='stat-percent'>
              {totalDuration > 0 ? `${(stageStats.rem_sleep.totalDuration / totalDuration * 100).toFixed(1)}%` : '0%'}
            </Text>
          </View>
        </View>

        <View className='stat-item'>
          <View className='stat-indicator' style={{ backgroundColor: '#6b7280' }} />
          <View className='stat-info'>
            <Text className='stat-label'>清醒</Text>
            <Text className='stat-value'>{formatDuration(stageStats.awake.totalDuration)}</Text>
            <Text className='stat-percent'>
              {totalDuration > 0 ? `${(stageStats.awake.totalDuration / totalDuration * 100).toFixed(1)}%` : '0%'}
            </Text>
          </View>
        </View>
      </View>
    </View>
  )
}

export default SleepStageChart
