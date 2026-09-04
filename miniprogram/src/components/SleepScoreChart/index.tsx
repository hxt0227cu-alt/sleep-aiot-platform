import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Canvas } from '@tarojs/components'
import Taro from '@tarojs/taro'
import * as echarts from 'echarts-for-weixin'
import './index.scss'

export interface SleepScoreData {
  score: number
  dimensions: {
    sleep_duration: number
    sleep_efficiency: number
    deep_sleep_ratio: number
    sleep_latency: number
    awakenings: number
    heart_rate_stability: number
  }
  trends?: {
    dates: string[]
    scores: number[]
  }
}

export interface SleepScoreChartProps {
  data: SleepScoreData
  chartType?: 'radar' | 'gauge' | 'trend'
  height?: number
  showDetails?: boolean
}

const SleepScoreChart: React.FC<SleepScoreChartProps> = ({
  data,
  chartType = 'radar',
  height = 300,
  showDetails = true
}) => {
  const chartInstanceRef = useRef<any>(null)
  const [chartId] = useState(() => `sleep-score-chart-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)

  useEffect(() => {
    if (!data) return

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
  }, [data, chartType])

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
          } else {
            console.warn('Canvas node not found')
          }
        })
    } catch (error) {
      console.error('Sleep score chart initialization error:', error)
    }
  }

  const getChartOption = () => {
    switch (chartType) {
      case 'radar':
        return getRadarOption()
      case 'gauge':
        return getGaugeOption()
      case 'trend':
        return getTrendOption()
      default:
        return getRadarOption()
    }
  }

  const getRadarOption = () => {
    const { dimensions } = data

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        borderColor: '#333',
        borderWidth: 1,
        textStyle: {
          color: '#fff',
          fontSize: 12
        }
      },
      radar: {
        indicator: [
          { name: '睡眠时长', max: 100 },
          { name: '睡眠效率', max: 100 },
          { name: '深睡比例', max: 100 },
          { name: '入睡速度', max: 100 },
          { name: '睡眠连续性', max: 100 },
          { name: '心率稳定性', max: 100 }
        ],
        radius: '65%',
        center: ['50%', '50%'],
        axisName: {
          color: '#6b7280',
          fontSize: 11,
          fontWeight: 'bold'
        },
        splitArea: {
          show: true,
          areaStyle: {
            color: ['rgba(243, 244, 246, 0.1)', 'rgba(243, 244, 246, 0.2)']
          }
        },
        splitLine: {
          lineStyle: {
            color: '#e5e7eb'
          }
        },
        axisLine: {
          lineStyle: {
            color: '#e5e7eb'
          }
        }
      },
      series: [
        {
          type: 'radar',
          data: [
            {
              value: [
                dimensions.sleep_duration,
                dimensions.sleep_efficiency,
                dimensions.deep_sleep_ratio,
                dimensions.sleep_latency,
                dimensions.awakenings,
                dimensions.heart_rate_stability
              ],
              name: '睡眠质量',
              itemStyle: {
                color: '#3b82f6'
              },
              areaStyle: {
                color: {
                  type: 'linear',
                  x: 0,
                  y: 0,
                  x2: 0,
                  y2: 1,
                  colorStops: [
                    { offset: 0, color: 'rgba(59, 130, 246, 0.3)' },
                    { offset: 1, color: 'rgba(59, 130, 246, 0.1)' }
                  ]
                }
              },
              lineStyle: {
                width: 2,
                color: '#3b82f6'
              }
            }
          ]
        }
      ]
    }
  }

  const getGaugeOption = () => {
    const { score } = data
    const color = getScoreColor(score)

    return {
      backgroundColor: 'transparent',
      series: [
        {
          type: 'gauge',
          startAngle: 180,
          endAngle: 0,
          min: 0,
          max: 100,
          splitNumber: 10,
          itemStyle: {
            color: color,
            shadowColor: color,
            shadowBlur: 10
          },
          progress: {
            show: true,
            roundCap: true,
            width: 12
          },
          pointer: {
            show: false
          },
          axisLine: {
            roundCap: true,
            lineStyle: {
              width: 12,
              color: [
                [0.6, '#ef4444'],
                [0.7, '#f97316'],
                [0.8, '#f59e0b'],
                [0.9, '#3b82f6'],
                [1, '#10b981']
              ]
            }
          },
          axisTick: {
            show: false
          },
          splitLine: {
            show: false
          },
          axisLabel: {
            show: false
          },
          title: {
            show: true,
            offsetCenter: [0, '30%'],
            fontSize: 14,
            color: '#6b7280',
            fontWeight: 'bold'
          },
          detail: {
            valueAnimation: true,
            fontSize: 48,
            color: color,
            fontWeight: 'bold',
            offsetCenter: [0, '-10%'],
            formatter: '{value}'
          },
          data: [
            {
              value: score,
              name: '睡眠评分'
            }
          ]
        }
      ]
    }
  }

  const getTrendOption = () => {
    if (!data.trends || data.trends.dates.length === 0) {
      return getGaugeOption()
    }

    const { dates, scores } = data.trends

    return {
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
            return `
              <div style="padding: 8px;">
                <div style="margin-bottom: 4px; font-weight: bold;">${param.name}</div>
                <div>评分: ${param.value}</div>
              </div>
            `
          }
          return ''
        }
      },
      grid: {
        left: '10%',
        right: '5%',
        bottom: '15%',
        top: '10%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: {
          lineStyle: {
            color: '#e5e7eb'
          }
        },
        axisLabel: {
          color: '#6b7280',
          fontSize: 10
        },
        axisTick: {
          show: false
        }
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
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
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          showSymbol: true,
          data: scores,
          itemStyle: {
            color: '#3b82f6'
          },
          lineStyle: {
            width: 3,
            color: '#3b82f6'
          },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(59, 130, 246, 0.3)' },
                { offset: 1, color: 'rgba(59, 130, 246, 0.05)' }
              ]
            }
          },
          markPoint: {
            data: [
              {
                type: 'max',
                name: '最高',
                itemStyle: {
                  color: '#10b981'
                }
              },
              {
                type: 'min',
                name: '最低',
                itemStyle: {
                  color: '#ef4444'
                }
              }
            ]
          }
        }
      ]
    }
  }

  const getScoreColor = (score: number): string => {
    if (score >= 90) return '#10b981'
    if (score >= 80) return '#3b82f6'
    if (score >= 70) return '#f59e0b'
    if (score >= 60) return '#f97316'
    return '#ef4444'
  }

  const getScoreLevel = (score: number): string => {
    if (score >= 90) return '优秀'
    if (score >= 80) return '良好'
    if (score >= 70) return '一般'
    if (score >= 60) return '较差'
    return '很差'
  }

  const getScoreSuggestions = (score: number): string[] => {
    if (score >= 90) {
      return [
        '您的睡眠质量非常优秀，请继续保持良好的睡眠习惯',
        '规律的作息时间和舒适的睡眠环境是关键'
      ]
    } else if (score >= 80) {
      return [
        '您的睡眠质量良好，可以适当优化睡眠环境',
        '建议保持规律的作息时间'
      ]
    } else if (score >= 70) {
      return [
        '您的睡眠质量一般，建议改善睡眠习惯',
        '尝试在睡前放松身心，避免使用电子设备'
      ]
    } else if (score >= 60) {
      return [
        '您的睡眠质量较差，需要重视睡眠问题',
        '建议咨询医生，检查是否有睡眠障碍'
      ]
    } else {
      return [
        '您的睡眠质量很差，强烈建议寻求专业帮助',
        '可能存在严重的睡眠问题，请及时就医'
      ]
    }
  }

  return (
    <View className='sleep-score-chart'>
      <View className='chart-container'>
        <Canvas
          id={chartId}
          canvasId={chartId}
          style={{ width: '100%', height: `${height}px` }}
        />
      </View>

      {showDetails && (
        <View className='score-details'>
          <View className='score-summary'>
            <View
              className='score-circle'
              style={{ borderColor: getScoreColor(data.score) }}
            >
              <Text className='score-number'>{data.score}</Text>
              <Text className='score-label'>睡眠评分</Text>
            </View>
            <View
              className='score-level'
              style={{ color: getScoreColor(data.score) }}
            >
              <Text className='level-text'>{getScoreLevel(data.score)}</Text>
            </View>
          </View>

          <View className='dimension-details'>
            <Text className='details-title'>睡眠维度分析</Text>
            <View className='dimension-list'>
              <View className='dimension-item'>
                <Text className='dimension-label'>睡眠时长</Text>
                <View className='dimension-bar'>
                  <View
                    className='dimension-fill'
                    style={{
                      width: `${data.dimensions.sleep_duration}%`,
                      backgroundColor: getScoreColor(data.dimensions.sleep_duration)
                    }}
                  />
                </View>
                <Text className='dimension-value'>{data.dimensions.sleep_duration}</Text>
              </View>

              <View className='dimension-item'>
                <Text className='dimension-label'>睡眠效率</Text>
                <View className='dimension-bar'>
                  <View
                    className='dimension-fill'
                    style={{
                      width: `${data.dimensions.sleep_efficiency}%`,
                      backgroundColor: getScoreColor(data.dimensions.sleep_efficiency)
                    }}
                  />
                </View>
                <Text className='dimension-value'>{data.dimensions.sleep_efficiency}%</Text>
              </View>

              <View className='dimension-item'>
                <Text className='dimension-label'>深睡比例</Text>
                <View className='dimension-bar'>
                  <View
                    className='dimension-fill'
                    style={{
                      width: `${data.dimensions.deep_sleep_ratio}%`,
                      backgroundColor: getScoreColor(data.dimensions.deep_sleep_ratio)
                    }}
                  />
                </View>
                <Text className='dimension-value'>{data.dimensions.deep_sleep_ratio}%</Text>
              </View>

              <View className='dimension-item'>
                <Text className='dimension-label'>入睡速度</Text>
                <View className='dimension-bar'>
                  <View
                    className='dimension-fill'
                    style={{
                      width: `${data.dimensions.sleep_latency}%`,
                      backgroundColor: getScoreColor(data.dimensions.sleep_latency)
                    }}
                  />
                </View>
                <Text className='dimension-value'>{data.dimensions.sleep_latency}</Text>
              </View>

              <View className='dimension-item'>
                <Text className='dimension-label'>睡眠连续性</Text>
                <View className='dimension-bar'>
                  <View
                    className='dimension-fill'
                    style={{
                      width: `${data.dimensions.awakenings}%`,
                      backgroundColor: getScoreColor(data.dimensions.awakenings)
                    }}
                  />
                </View>
                <Text className='dimension-value'>{data.dimensions.awakenings}</Text>
              </View>

              <View className='dimension-item'>
                <Text className='dimension-label'>心率稳定性</Text>
                <View className='dimension-bar'>
                  <View
                    className='dimension-fill'
                    style={{
                      width: `${data.dimensions.heart_rate_stability}%`,
                      backgroundColor: getScoreColor(data.dimensions.heart_rate_stability)
                    }}
                  />
                </View>
                <Text className='dimension-value'>{data.dimensions.heart_rate_stability}</Text>
              </View>
            </View>
          </View>

          <View className='suggestions'>
            <Text className='suggestions-title'>改善建议</Text>
            {getScoreSuggestions(data.score).map((suggestion, index) => (
              <View key={index} className='suggestion-item'>
                <Text className='suggestion-text'>{suggestion}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  )
}

export default SleepScoreChart
