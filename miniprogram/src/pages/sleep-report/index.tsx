import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, ScrollView, Input } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading, formatDate, formatDuration } from '../../utils/util'
import type { AssistantSleepExplanation, SleepReport } from '../../types'
import Loading from '../../components/Loading'
import './index.scss'

const PRESET_QUESTIONS = [
  '我昨晚为什么睡得不好？',
  '我的呼吸率偏高说明什么？',
  '今晚应该怎么调整助眠灯？'
]

const SleepReportPage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [report, setReport] = useState<SleepReport | null>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [aiQuestion, setAiQuestion] = useState('')
  const [explaining, setExplaining] = useState(false)
  const [aiExplanation, setAiExplanation] = useState<AssistantSleepExplanation | null>(null)

  const { currentDevice } = useDeviceStore()

  useEffect(() => {
    const routeDeviceId = Taro.getCurrentInstance().router?.params?.deviceId
    const routeDate = Taro.getCurrentInstance().router?.params?.date || ''
    const fallbackDeviceId =
      currentDevice?.device_id || (currentDevice as any)?.deviceId || ''
    const nextDeviceId = routeDeviceId || fallbackDeviceId

    if (!nextDeviceId) {
      showToast('未找到设备，请先选择设备', 'error')
      Taro.switchTab({ url: '/pages/index/index' })
      return
    }

    setDeviceId(nextDeviceId)
    setSelectedDate(routeDate)
    void loadReport(nextDeviceId, routeDate || undefined)
  }, [currentDevice])

  const reportDateLabel = useMemo(() => {
    const dateValue = selectedDate || report?.date
    if (!dateValue) {
      return '今日'
    }
    const timestamp = new Date(dateValue).getTime()
    return Number.isFinite(timestamp)
      ? formatDate(timestamp, 'YYYY年MM月DD日')
      : dateValue
  }, [report?.date, selectedDate])

  const loadReport = async (nextDeviceId: string, date?: string) => {
    try {
      setLoading(true)
      showLoading('加载睡眠报告...')

      const result = await api.sleep.getSleepReport(nextDeviceId, date)
      if (result.code === 200) {
        setReport(result.data)
      } else {
        showToast(result.message || '加载睡眠报告失败', 'error')
      }
    } catch (error) {
      console.error('加载睡眠报告失败:', error)
      showToast('加载失败，请重试', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const handleExplain = async (question?: string) => {
    const nextQuestion = (question || aiQuestion).trim()
    if (!nextQuestion || !deviceId) {
      showToast('请输入要解读的问题', 'none')
      return
    }

    try {
      setExplaining(true)
      setAiQuestion(nextQuestion)
      showLoading('AI 正在解读...')

      const result = await api.assistant.explainSleepReport({
        deviceId,
        date: selectedDate || undefined,
        question: nextQuestion
      })

      if (result.code === 200) {
        setAiExplanation(result.data)
      } else {
        showToast(result.message || 'AI 解读失败', 'error')
      }
    } catch (error) {
      console.error('AI 解读失败:', error)
      showToast('AI 解读失败，请稍后再试', 'error')
    } finally {
      setExplaining(false)
      hideLoading()
    }
  }

  const getSleepScoreLevel = (score: number): string => {
    if (score >= 90) return '优秀'
    if (score >= 80) return '良好'
    if (score >= 70) return '一般'
    if (score >= 60) return '偏弱'
    return '较差'
  }

  const getSleepScoreColor = (score: number): string => {
    if (score >= 90) return '#10b981'
    if (score >= 80) return '#3b82f6'
    if (score >= 70) return '#f59e0b'
    if (score >= 60) return '#f97316'
    return '#ef4444'
  }

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  if (!report) {
    return (
      <View className='sleep-report-page'>
        <View className='empty-state'>
          <Text className='empty-icon'>暂无</Text>
          <Text className='empty-text'>暂无睡眠报告</Text>
        </View>
      </View>
    )
  }

  const structureItems = Array.isArray(report.sleep_structure) ? report.sleep_structure : []
  const totalDuration = report.sleep_duration?.total || 0

  return (
    <View className='sleep-report-page'>
      <ScrollView scrollY className='scroll-container'>
        <View className='header-section'>
          <View className='date-info'>
            <Text className='date-text'>{reportDateLabel}</Text>
          </View>

          <View className='score-section'>
            <View className='score-circle' style={{ borderColor: getSleepScoreColor(report.sleep_score) }}>
              <Text className='score-number'>{report.sleep_score}</Text>
              <Text className='score-label'>睡眠评分</Text>
            </View>
            <View className='score-level' style={{ color: getSleepScoreColor(report.sleep_score) }}>
              <Text className='level-text'>{getSleepScoreLevel(report.sleep_score)}</Text>
            </View>
          </View>
        </View>

        <View className='duration-section'>
          <View className='section-header'>
            <Text className='section-title'>睡眠时长</Text>
          </View>

          <View className='duration-grid'>
            <View className='duration-item'>
              <View className='duration-info'>
                <Text className='duration-label'>总时长</Text>
                <Text className='duration-value'>{formatDuration(report.sleep_duration.total)}</Text>
              </View>
            </View>
            <View className='duration-item'>
              <View className='duration-info'>
                <Text className='duration-label'>深睡</Text>
                <Text className='duration-value'>{formatDuration(report.sleep_duration.deep_sleep)}</Text>
              </View>
            </View>
            <View className='duration-item'>
              <View className='duration-info'>
                <Text className='duration-label'>浅睡</Text>
                <Text className='duration-value'>{formatDuration(report.sleep_duration.light_sleep)}</Text>
              </View>
            </View>
            <View className='duration-item'>
              <View className='duration-info'>
                <Text className='duration-label'>清醒</Text>
                <Text className='duration-value'>{formatDuration(report.sleep_duration.awake)}</Text>
              </View>
            </View>
          </View>
        </View>

        <View className='metrics-section'>
          <View className='section-header'>
            <Text className='section-title'>睡眠指标</Text>
          </View>

          <View className='metrics-grid'>
            <View className='metric-card'>
              <Text className='metric-label'>睡眠效率</Text>
              <Text className='metric-value'>{Number(report.sleep_efficiency || 0).toFixed(1)}%</Text>
            </View>
            <View className='metric-card'>
              <Text className='metric-label'>入睡时长</Text>
              <Text className='metric-value'>{formatDuration(report.sleep_latency || 0)}</Text>
            </View>
            <View className='metric-card'>
              <Text className='metric-label'>觉醒次数</Text>
              <Text className='metric-value'>{report.awakenings} 次</Text>
            </View>
            <View className='metric-card'>
              <Text className='metric-label'>平均心率</Text>
              <Text className='metric-value'>{report.vital_signs.avg_heart_rate} bpm</Text>
            </View>
            <View className='metric-card'>
              <Text className='metric-label'>平均呼吸率</Text>
              <Text className='metric-value'>{report.vital_signs.avg_breathing_rate} 次/分</Text>
            </View>
            <View className='metric-card'>
              <Text className='metric-label'>心率范围</Text>
              <Text className='metric-value'>
                {report.vital_signs.min_heart_rate}-{report.vital_signs.max_heart_rate} bpm
              </Text>
            </View>
          </View>
        </View>

        <View className='structure-section'>
          <View className='section-header'>
            <Text className='section-title'>睡眠结构</Text>
          </View>

          <View className='structure-chart'>
            {structureItems.map((item, index) => {
              const duration = Number((item as any).duration || (item as any).duration_seconds || 0)
              const width = totalDuration > 0 ? `${Math.max(18, (duration / totalDuration) * 100)}%` : '18%'
              const colors: Record<string, string> = {
                deep_sleep: '#10b981',
                light_sleep: '#3b82f6',
                rem_sleep: '#8b5cf6',
                awake: '#6b7280'
              }
              const labels: Record<string, string> = {
                deep_sleep: '深睡',
                light_sleep: '浅睡',
                rem_sleep: 'REM',
                awake: '清醒'
              }

              return (
                <View key={`${(item as any).state}-${index}`} className='structure-item'>
                  <View
                    className='structure-bar'
                    style={{
                      backgroundColor: colors[(item as any).state] || '#94a3b8',
                      width
                    }}
                  />
                  <Text className='structure-label'>
                    {labels[(item as any).state] || (item as any).state}
                  </Text>
                </View>
              )
            })}
          </View>
        </View>

        <View className='suggestions-section'>
          <View className='section-header'>
            <Text className='section-title'>健康建议</Text>
          </View>

          <View className='suggestions-list'>
            {report.health_suggestions.map((suggestion, index) => (
              <View key={`${suggestion}-${index}`} className='suggestion-item'>
                <Text className='suggestion-text'>{suggestion}</Text>
              </View>
            ))}
          </View>
        </View>

        <View className='ai-section'>
          <View className='section-header'>
            <Text className='section-title'>AI 睡眠解读</Text>
            <Text className='section-subtitle'>基于昨晚报告给你更自然的解释和今晚建议</Text>
          </View>

          <View className='chip-list'>
            {PRESET_QUESTIONS.map((item) => (
              <View
                key={item}
                className='question-chip'
                onClick={() => void handleExplain(item)}
              >
                <Text className='question-chip-text'>{item}</Text>
              </View>
            ))}
          </View>

          <View className='ask-card'>
            <Input
              className='ask-input'
              type='text'
              placeholder='继续问：比如“深睡少主要受什么影响？”'
              value={aiQuestion}
              onInput={(event) => setAiQuestion(event.detail.value)}
            />
            <View
              className={`ask-button ${explaining ? 'disabled' : ''}`}
              onClick={() => void handleExplain()}
            >
              <Text className='ask-button-text'>{explaining ? '解读中...' : '开始解读'}</Text>
            </View>
          </View>

          {aiExplanation ? (
            <View className='ai-result-card'>
              <Text className='ai-result-question'>问题：{aiExplanation.question}</Text>
              <Text className='ai-result-answer'>{aiExplanation.answer}</Text>

              {aiExplanation.keyFindings.length > 0 ? (
                <View className='ai-list-block'>
                  <Text className='ai-list-title'>关键发现</Text>
                  {aiExplanation.keyFindings.map((item, index) => (
                    <Text key={`${item}-${index}`} className='ai-list-item'>• {item}</Text>
                  ))}
                </View>
              ) : null}

              {aiExplanation.recommendations.length > 0 ? (
                <View className='ai-list-block'>
                  <Text className='ai-list-title'>今晚建议</Text>
                  {aiExplanation.recommendations.map((item, index) => (
                    <Text key={`${item}-${index}`} className='ai-list-item'>• {item}</Text>
                  ))}
                </View>
              ) : null}

              {aiExplanation.caution ? (
                <View className='ai-caution'>
                  <Text className='ai-caution-text'>{aiExplanation.caution}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  )
}

export default SleepReportPage
