import React, { useEffect, useRef, useState } from 'react'
import { View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import * as echarts from 'echarts-for-weixin'
import './index.scss'

export interface ChartDataPoint {
  timestamp: number
  value: number
  label?: string
}

export interface SleepChartProps {
  data: ChartDataPoint[]
  type: 'heart_rate' | 'breathing_rate' | 'body_movement' | 'sleep_state'
  title: string
  color?: string
  height?: number
  showZoom?: boolean
  showDataZoom?: boolean
  onChartClick?: (params: any) => void
  customOption?: any
}

const SleepChart: React.FC<SleepChartProps> = ({
  data,
  type,
  title,
  color = '#f59e0b',
  height = 300,
  showZoom = true,
  showDataZoom = false,
  onChartClick,
  customOption
}) => {
  const chartRef = useRef<any>(null)
  const chartInstanceRef = useRef<any>(null)
  const [chartId] = useState(() => `chart-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)

  useEffect(() => {
    if (!data || data.length === 0) return

    // 延迟初始化，确保DOM已渲染
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
  }, [data, type, color, showDataZoom])

  const initChart = () => {
    try {
      const canvasId = chartId
      const canvasNode = document.getElementById(canvasId) as any

      if (!canvasNode) {
        console.warn('Canvas node not found')
        return
      }

      const chartInstance = echarts.init(canvasNode, null, {
        width: canvasNode.width,
        height: canvasNode.height,
        renderer: 'canvas'
      })

      chartInstanceRef.current = chartInstance

      const option = getChartOption(type, color)
      chartInstance.setOption(option)

      // 添加点击事件
      if (onChartClick) {
        chartInstance.on('click', (params: any) => {
          onChartClick(params)
        })
      }
    } catch (error) {
      console.error('Chart initialization error:', error)
    }
  }

  const getChartOption = (chartType: string, chartColor: string) => {
    const colors: Record<string, string> = {
      heart_rate: '#ef4444',
      breathing_rate: '#10b981',
      body_movement: '#8b5cf6',
      sleep_state: '#6366f1'
    }

    const labels: Record<string, string> = {
      heart_rate: '心率 (bpm)',
      breathing_rate: '呼吸率 (次/分)',
      body_movement: '体动强度',
      sleep_state: '睡眠状态'
    }

    const xAxisData = data.map(item => formatDate(item.timestamp, 'HH:mm'))
    const seriesData = data.map(item => item.value)

    const baseOption: any = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        borderColor: '#333',
        borderWidth: 1,
        textStyle: {
          color: '#fff',
          fontSize: 12
        },
        formatter: (params: any) => {
          if (params && params.length > 0) {
            const param = params[0]
            const dataIndex = param.dataIndex
            const dataPoint = data[dataIndex]
            return `
              <div style="padding: 8px;">
                <div style="margin-bottom: 4px; font-weight: bold;">${formatDate(dataPoint.timestamp, 'HH:mm:ss')}</div>
                <div style="display: flex; align-items: center;">
                  <span style="display: inline-block; width: 8px; height: 8px; background: ${colors[chartType]}; border-radius: 50%; margin-right: 8px;"></span>
                  <span>${labels[chartType]}: ${param.value}</span>
                </div>
              </div>
            `
          }
          return ''
        }
      },
      grid: {
        left: '10%',
        right: '5%',
        bottom: showDataZoom ? '20%' : '10%',
        top: '15%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: xAxisData,
        axisLine: {
          lineStyle: {
            color: '#e5e7eb'
          }
        },
        axisLabel: {
          color: '#6b7280',
          fontSize: 10,
          interval: Math.ceil(xAxisData.length / 6)
        },
        axisTick: {
          show: false
        }
      },
      yAxis: {
        type: 'value',
        boundaryGap: false,
        axisLine: {
          show: false
        },
        axisLabel: {
          color: '#6b7280',
          fontSize: 10
        },
        splitLine: {
          lineStyle: {
            color: '#e5e7eb',
            type: 'dashed'
          }
        }
      },
      series: [
        {
          name: title,
          type: 'line',
          smooth: true,
          symbol: 'circle' as const,
          symbolSize: 4,
          showSymbol: false,
          hoverAnimation: true,
          data: seriesData,
          itemStyle: {
            color: colors[chartType]
          },
          lineStyle: {
            width: 2,
            color: colors[chartType]
          },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: hexToRgba(colors[chartType], 0.3) },
                { offset: 1, color: hexToRgba(colors[chartType], 0.05) }
              ]
            }
          },
          markPoint: {
            data: getMarkPoints(seriesData, colors[chartType])
          }
        }
      ]
    }

    // 添加数据缩放组件
    if (showDataZoom && data.length > 20) {
      baseOption.dataZoom = [
        {
          type: 'inside',
          start: 0,
          end: 100,
          zoomLock: false
        },
        {
          type: 'slider',
          start: 0,
          end: 100,
          height: 20,
          bottom: 5,
          borderColor: 'transparent',
          backgroundColor: '#f3f4f6',
          fillerColor: hexToRgba(colors[chartType], 0.2),
          handleStyle: {
            color: colors[chartType]
          },
          textStyle: {
            color: '#6b7280'
          }
        }
      ]
    }

    // 合并自定义配置
    return customOption ? { ...baseOption, ...customOption } : baseOption
  }

  // eslint-disable-next-line @typescript-eslint/no-shadow -- intentional: local helper params
  const getMarkPoints = (data: number[], color: string) => {
    if (data.length === 0) return []

    const max = Math.max(...data)
    const min = Math.min(...data)
    const maxIndex = data.indexOf(max)
    const minIndex = data.indexOf(min)

    return [
      {
        name: '最高',
        value: max,
        xAxis: maxIndex,
        yAxis: max,
        itemStyle: {
          color: color
        },
        label: {
          show: true,
          position: 'top',
          formatter: '{c}',
          fontSize: 10
        }
      },
      {
        name: '最低',
        value: min,
        xAxis: minIndex,
        yAxis: min,
        itemStyle: {
          color: color
        },
        label: {
          show: true,
          position: 'bottom',
          formatter: '{c}',
          fontSize: 10
        }
      }
    ]
  }

  const formatDate = (timestamp: number, format: string = 'HH:mm'): string => {
    const date = new Date(timestamp)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return format === 'HH:mm' ? `${hours}:${minutes}` : `${hours}:${minutes}:${String(date.getSeconds()).padStart(2, '0')}`
  }

  const hexToRgba = (hex: string, alpha: number): string => {
    const normalized = hex.replace('#', '')
    const value = normalized.length === 3
      ? normalized.split('').map(char => char + char).join('')
      : normalized
    const r = parseInt(value.slice(0, 2), 16)
    const g = parseInt(value.slice(2, 4), 16)
    const b = parseInt(value.slice(4, 6), 16)

    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  return (
    <View className='sleep-chart'>
      <View
        ref={chartRef}
        style={{ width: '100%', height: '300px' }}
      />
    </View>
  )
}

export default SleepChart
