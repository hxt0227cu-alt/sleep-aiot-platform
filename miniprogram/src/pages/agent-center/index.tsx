import React, { useMemo, useState } from 'react'
import { Button, ScrollView, Text, Textarea, View } from '@tarojs/components'
import { useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { showToast } from '../../utils/util'
import type { AgentRunDetail, BusinessAgentType } from '../../types'
import './index.scss'

type AgentOption = {
  type: BusinessAgentType
  label: string
  shortLabel: string
  needsDevice: boolean
  placeholder?: string
}

const AGENTS: AgentOption[] = [
  { type: 'sleep_report', label: '每日睡眠报告', shortLabel: '报告', needsDevice: true },
  { type: 'sleep_improvement', label: '21 天改善计划', shortLabel: '计划', needsDevice: true },
  {
    type: 'voice_companion',
    label: '睡前语音陪伴',
    shortLabel: '陪伴',
    needsDevice: false,
    placeholder: '说说你今晚的感受'
  }
]

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const toResultLines = (type: BusinessAgentType, value: unknown): string[] => {
  if (!value || typeof value !== 'object') return []
  const result = value as Record<string, any>
  if (type === 'sleep_report') {
    return [
      result.title,
      Number.isFinite(result.qualityScore) ? `睡眠质量评分：${result.qualityScore}` : undefined,
      result.summary,
      ...stringList(result.observations).map(item => `观察：${item}`),
      ...stringList(result.recommendations).map(item => `建议：${item}`),
      result.disclaimer
    ].filter((item): item is string => typeof item === 'string' && item.length > 0)
  }
  if (type === 'sleep_improvement') {
    const phases = Array.isArray(result.phases) ? result.phases : []
    return [
      result.message,
      ...phases.flatMap((phase: Record<string, unknown>) => [
        `第 ${String(phase.days || '-')} 天：${String(phase.goal || '')}`,
        ...stringList(phase.actions).map(item => `行动：${item}`)
      ]),
      result.disclaimer
    ].filter((item): item is string => typeof item === 'string' && item.length > 0)
  }
  return [
    result.reply,
    result.requiresImmediateSupport ? '请立即联系身边可信任的人或当地紧急支持服务。' : undefined,
    '仅用于睡眠健康陪伴，不具备医疗参考价值。'
  ].filter((item): item is string => typeof item === 'string' && item.length > 0)
}

const AgentCenterPage: React.FC = () => {
  const { currentDevice } = useDeviceStore()
  const [selectedType, setSelectedType] = useState<BusinessAgentType>('sleep_report')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [run, setRun] = useState<AgentRunDetail | null>(null)

  const selected = useMemo(
    () => AGENTS.find(item => item.type === selectedType) || AGENTS[0],
    [selectedType]
  )
  const deviceId = currentDevice?.device_id || ''
  const resultLines = toResultLines(selectedType, run?.output?.businessResult)

  const buildInput = () => {
    if (selectedType === 'sleep_report') {
      return { device_id: deviceId, allowed_device_ids: [deviceId], user_segment: 'general' }
    }
    if (selectedType === 'sleep_improvement') {
      return { device_id: deviceId, allowed_device_ids: [deviceId], window_days: 28 }
    }
    if (selectedType === 'voice_companion') return { transcript: text.trim() }
    return { transcript: text.trim() }
  }

  const pollRun = async (runId: string) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await api.agents.getRun(runId)
      if (response.code === 200) {
        setRun(response.data)
        if (['succeeded', 'failed', 'cancelled'].includes(response.data.status)) return
      }
      await wait(750)
    }
    throw new Error('Agent execution timed out')
  }

  const handleRun = async () => {
    if (selected.needsDevice && !deviceId) {
      showToast('请先选择设备', 'error')
      return
    }
    if (selectedType === 'voice_companion' && !text.trim()) {
      showToast('请输入陪伴内容', 'error')
      return
    }

    try {
      setLoading(true)
      setRun(null)
      const response = await api.agents.createRun({
        agentType: selectedType,
        input: buildInput(),
        workflowVersion: 'business-v1'
      })
      if (![200, 202].includes(response.code)) throw new Error(response.message)
      await pollRun(response.data.runId)
    } catch (error: any) {
      showToast(error?.message || 'Agent 执行失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <View className='agent-center-page'>
      <ScrollView scrollY className='agent-scroll'>
        <View className='agent-tabs'>
          {AGENTS.map(item => (
            <Button
              key={item.type}
              className={`agent-tab ${selectedType === item.type ? 'active' : ''}`}
              onClick={() => {
                setSelectedType(item.type)
                setRun(null)
                setText('')
              }}
            >
              {item.shortLabel}
            </Button>
          ))}
        </View>

        <View className='agent-section'>
          <Text className='agent-title'>{selected.label}</Text>
          {selected.needsDevice && (
            <Text className='agent-meta'>设备：{currentDevice?.device_name || '未选择'}</Text>
          )}
          {selected.placeholder && (
            <Textarea
              className='agent-input'
              value={text}
              maxlength={2000}
              placeholder={selected.placeholder}
              onInput={event => setText(event.detail.value)}
            />
          )}
          <Button className='agent-run-button' disabled={loading} onClick={handleRun}>
            {loading ? '执行中' : '生成'}
          </Button>
        </View>

        {run && (
          <View className='agent-result'>
            <View className='result-header'>
              <Text className='result-title'>执行结果</Text>
              <Text className={`result-status ${run.status}`}>{run.status}</Text>
            </View>
            {run.errorMessage && <Text className='result-error'>{run.errorMessage}</Text>}
            {resultLines.map((line, index) => (
              <Text key={`${index}-${line}`} className='result-line' selectable>
                {line}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  )
}

export default AgentCenterPage
