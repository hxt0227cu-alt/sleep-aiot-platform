import React, { useEffect, useState } from 'react'
import { View, Text, ScrollView, Image, Input } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { showToast, showLoading, hideLoading, formatDate } from '../../utils/util'
import type {
  AssistantSleepExplanation,
  AssistantDeviceControlResponse,
  AssistantKnowledgeAnswer,
  WhiteNoise
} from '../../types'
import Loading from '../../components/Loading'
import './index.scss'

const CONTROL_EXAMPLES = [
  '把灯光调暗一点，播放白噪音，30 分钟后关闭',
  '把助眠灯调成暖一点，亮度 25%',
  '停止白噪音，关掉灯光'
]

const KNOWLEDGE_EXAMPLES = [
  '深睡少怎么办？',
  '设备怎么重新配网？',
  '白噪音什么时候开比较好？'
]

const DEVICE_SUPPORTED_SOUNDS = ['rain', 'wind', 'bird', 'thunder']
const SLEEP_REPORT_PATTERNS = ['昨天', '昨晚', '睡眠报告', '睡得怎么样', '睡眠怎么样']

const resolveDeviceId = (device: any) => device?.device_id || device?.deviceId || ''

const VoicePage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [voiceEnabled, setVoiceEnabled] = useState(true)
  const [wakeupWord, setWakeupWord] = useState('小台灯')
  const [recognizedText, setRecognizedText] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [whiteNoiseList, setWhiteNoiseList] = useState<WhiteNoise[]>([])
  const [currentNoise, setCurrentNoise] = useState<WhiteNoise | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [controlText, setControlText] = useState('')
  const [controlLoading, setControlLoading] = useState(false)
  const [controlResult, setControlResult] = useState<AssistantDeviceControlResponse | null>(null)
  const [sleepExplanation, setSleepExplanation] = useState<AssistantSleepExplanation | null>(null)
  const [knowledgeQuestion, setKnowledgeQuestion] = useState('')
  const [knowledgeLoading, setKnowledgeLoading] = useState(false)
  const [knowledgeAnswer, setKnowledgeAnswer] = useState<AssistantKnowledgeAnswer | null>(null)

  const { currentDevice } = useDeviceStore()
  const deviceId = resolveDeviceId(currentDevice)

  useEffect(() => {
    if (!deviceId) {
      Taro.switchTab({ url: '/pages/index/index' })
      return
    }

    void loadVoiceSettings()
    void loadWhiteNoiseList()
  }, [deviceId])

  const loadVoiceSettings = async () => {
    if (!deviceId) return

    try {
      setLoading(true)
      showLoading('加载语音设置...')
      const result = await api.device.getDeviceDetail(deviceId)

      if (result.code === 200 && result.data.status?.voice) {
        setVoiceEnabled(Boolean(result.data.status.voice.enabled))
        setWakeupWord(result.data.status.voice.wakeup_word || '小台灯')
      }
    } catch (error) {
      console.error('加载语音设置失败:', error)
      showToast('加载语音设置失败', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const loadWhiteNoiseList = async () => {
    try {
      const result = await api.voice.getWhiteNoiseList()
      if (result.code === 200) {
        setWhiteNoiseList(result.data.sounds)
      }
    } catch (error) {
      console.error('加载白噪音列表失败:', error)
    }
  }

  const handleToggleVoice = async () => {
    if (!deviceId) return

    try {
      showLoading('更新中...')
      const result = await api.device.sendCommand(deviceId, 'voice_control', {
        enabled: !voiceEnabled
      })

      if (result.code === 200) {
        setVoiceEnabled(!voiceEnabled)
        showToast(!voiceEnabled ? '语音已开启' : '语音已关闭', 'success')
      } else {
        showToast(result.message || '更新失败', 'error')
      }
    } catch (error) {
      console.error('切换语音失败:', error)
      showToast('操作失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleUpdateWakeupWord = async () => {
    if (!deviceId) return

    try {
      showLoading('更新中...')
      const result = await api.device.sendCommand(deviceId, 'voice_control', {
        enabled: voiceEnabled,
        wakeup_word: wakeupWord
      })

      if (result.code === 200) {
        showToast('唤醒词已更新', 'success')
      } else {
        showToast(result.message || '更新失败', 'error')
      }
    } catch (error) {
      console.error('更新唤醒词失败:', error)
      showToast('更新失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleStartRecording = () => {
    try {
      setIsRecording(true)
      setRecognizedText('')
      const recorderManager = Taro.getRecorderManager()

      recorderManager.onStop((res) => {
        setIsRecording(false)
        if (res.tempFilePath) {
          void handleVoiceRecognition(res.tempFilePath)
        }
      })

      recorderManager.onError((error) => {
        console.error('录音失败:', error)
        setIsRecording(false)
        showToast('录音失败，请重试', 'error')
      })

      recorderManager.start({
        format: 'mp3',
        duration: 6000
      })
    } catch (error) {
      console.error('开始录音失败:', error)
      setIsRecording(false)
      showToast('无法开始录音', 'error')
    }
  }

  const handleStopRecording = () => {
    try {
      const recorderManager = Taro.getRecorderManager()
      recorderManager.stop()
    } catch (error) {
      console.error('停止录音失败:', error)
    }
  }

  const handleVoiceRecognition = async (audioPath: string) => {
    if (!deviceId) return

    try {
      showLoading('正在识别...')
      const audioData = await new Promise<string>((resolve, reject) => {
        Taro.getFileSystemManager().readFile({
          filePath: audioPath,
          encoding: 'base64',
          success: (res) => resolve(`data:audio/mp3;base64,${res.data}`),
          fail: reject
        })
      })
      const result = await api.voice.recognizeVoice({
        device_id: deviceId,
        audio_data: audioData,
        recognition_mode: 'cloud',
        format: 'mp3',
        sample_rate: 16000
      })

      if (result.code !== 200) {
        showToast(result.message || '识别失败', 'error')
        return
      }

      const nextText = (result.data.text || '').trim()
      setRecognizedText(nextText)

      if (!nextText) {
        showToast('没有识别到有效文本', 'none')
        return
      }

      await routeRecognizedText(nextText, 'voice')
    } catch (error) {
      console.error('语音识别失败:', error)
      showToast('语音识别失败，请稍后再试', 'error')
    } finally {
      hideLoading()
    }
  }

  const isSleepReportQuestion = (text: string) => {
    return SLEEP_REPORT_PATTERNS.some((pattern) => text.includes(pattern))
  }

  const resolveSleepReportDate = (text: string) => {
    if (text.includes('昨天') || text.includes('昨晚')) {
      return formatDate(Date.now() - 24 * 60 * 60 * 1000, 'YYYY-MM-DD')
    }
    return formatDate(Date.now(), 'YYYY-MM-DD')
  }

  const submitSleepReportQuestion = async (question: string) => {
    if (!deviceId) return

    try {
      setControlLoading(true)
      showLoading('正在获取睡眠报告...')
      const result = await api.assistant.explainSleepReport({
        deviceId,
        date: resolveSleepReportDate(question),
        question
      })

      if (result.code === 200) {
        setSleepExplanation(result.data)
        setControlResult(null)
        showToast('已生成睡眠报告', 'success')
      } else {
        showToast(result.message || '获取睡眠报告失败', 'error')
      }
    } catch (error) {
      console.error('获取睡眠报告失败:', error)
      showToast('获取睡眠报告失败，请稍后重试', 'error')
    } finally {
      setControlLoading(false)
      hideLoading()
    }
  }

  const routeRecognizedText = async (text: string, source: 'voice' | 'text') => {
    if (isSleepReportQuestion(text)) {
      await submitSleepReportQuestion(text)
      return
    }

    await submitDeviceControl(text, source)
  }

  const submitDeviceControl = async (text: string, source: 'voice' | 'text') => {
    if (!deviceId) return
    const nextText = text.trim()
    if (!nextText) {
      showToast('请输入控制内容', 'none')
      return
    }

    if (isSleepReportQuestion(nextText)) {
      await submitSleepReportQuestion(nextText)
      return
    }

    try {
      setControlLoading(true)
      showLoading('正在执行控制...')
      const result = await api.assistant.controlDevice({
        deviceId,
        text: nextText,
        source
      })

      if (result.code === 200) {
        setControlResult(result.data)
        setSleepExplanation(null)
        if (source === 'text') {
          setControlText(nextText)
        }
        showToast('控制指令已执行', 'success')
      } else {
        showToast(result.message || '控制失败', 'error')
      }
    } catch (error) {
      console.error('设备控制失败:', error)
      showToast('控制失败，请稍后再试', 'error')
    } finally {
      setControlLoading(false)
      hideLoading()
    }
  }

  const submitKnowledgeQuestion = async (question?: string) => {
    const nextQuestion = (question || knowledgeQuestion).trim()
    if (!nextQuestion) {
      showToast('请输入知识问题', 'none')
      return
    }

    try {
      setKnowledgeLoading(true)
      setKnowledgeQuestion(nextQuestion)
      showLoading('正在检索知识库...')
      const result = await api.assistant.askKnowledge({
        question: nextQuestion,
        deviceId
      })

      if (result.code === 200) {
        setKnowledgeAnswer(result.data)
      } else {
        showToast(result.message || '问答失败', 'error')
      }
    } catch (error) {
      console.error('知识问答失败:', error)
      showToast('知识问答失败，请稍后再试', 'error')
    } finally {
      setKnowledgeLoading(false)
      hideLoading()
    }
  }

  const handlePlayNoise = async (noise: WhiteNoise) => {
    if (!deviceId) return

    const sound = DEVICE_SUPPORTED_SOUNDS.includes(noise.id) ? noise.id : 'rain'

    try {
      const result = await api.device.sendCommand(
        deviceId,
        'audio_control',
        {
          action: 'play',
          sound,
          volume: 80,
          source: 'app'
        },
        8000
      )

      if (result.code === 200) {
        setCurrentNoise(noise)
        setIsPlaying(true)
      } else {
        showToast(result.message || '播放失败', 'error')
      }
    } catch (error) {
      console.error('播放白噪音失败:', error)
      showToast('播放失败，请重试', 'error')
    }
  }

  const handleStopNoise = async () => {
    if (!deviceId) return

    try {
      await api.device.sendCommand(
        deviceId,
        'audio_control',
        {
          action: 'stop',
          source: 'app'
        },
        8000
      )
      setCurrentNoise(null)
      setIsPlaying(false)
    } catch (error) {
      console.error('停止白噪音失败:', error)
    }
  }

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  return (
    <View className='voice-page'>
      <ScrollView scrollY className='scroll-container'>
        <View className='header-section'>
          <View className='title-section'>
            <Text className='page-title'>AI 助眠控制</Text>
            <Text className='page-subtitle'>语音识别、设备控制、睡眠知识问答都集中在这里</Text>
          </View>

          <View className='voice-status'>
            <View className={`status-indicator ${voiceEnabled ? 'enabled' : 'disabled'}`} />
            <Text className='status-text'>{voiceEnabled ? '语音已开启' : '语音已关闭'}</Text>
          </View>
        </View>

        <View className='settings-section'>
          <View className='section-header'>
            <Text className='section-title'>语音设置</Text>
          </View>

          <View className='setting-card'>
            <View className='setting-item'>
              <View className='setting-info'>
                <Text className='setting-label'>语音开关</Text>
                <Text className='setting-desc'>开启或关闭设备侧语音能力</Text>
              </View>
              <View className='toggle-switch'>
                <View
                  className={`switch-track ${voiceEnabled ? 'on' : 'off'}`}
                  onClick={handleToggleVoice}
                >
                  <View className={`switch-thumb ${voiceEnabled ? 'on' : 'off'}`} />
                </View>
              </View>
            </View>

            <View className='setting-item'>
              <View className='setting-info'>
                <Text className='setting-label'>唤醒词</Text>
                <Text className='setting-desc'>同步到设备当前语音配置</Text>
              </View>
              <View className='wakeup-word-input'>
                <Input
                  className='input-field'
                  type='text'
                  value={wakeupWord}
                  onInput={(event) => setWakeupWord(event.detail.value)}
                  placeholder='请输入唤醒词'
                />
                <View className='save-button' onClick={handleUpdateWakeupWord}>
                  <Text className='button-text'>保存</Text>
                </View>
              </View>
            </View>

            {sleepExplanation && (
              <View className='assistant-result-card'>
                <Text className='assistant-result-title'>睡眠报告</Text>
                <Text className='assistant-result-answer'>{sleepExplanation.answer}</Text>
                {sleepExplanation.keyFindings.map((item, index) => (
                  <Text key={`${item}-${index}`} className='assistant-result-line'>
                    {item}
                  </Text>
                ))}
                {sleepExplanation.recommendations.length > 0 && (
                  <Text className='assistant-result-line'>{'建议：' + sleepExplanation.recommendations.join('；')}</Text>
                )}
                {!!sleepExplanation.caution && (
                  <Text className='assistant-result-line'>{'提示：' + sleepExplanation.caution}</Text>
                )}
              </View>
            )}
          </View>
        </View>

        <View className='commands-section'>
          <View className='section-header'>
            <Text className='section-title'>自然语言控制示例</Text>
          </View>

          <View className='commands-grid single-column'>
            {CONTROL_EXAMPLES.map((item) => (
              <View key={item} className='command-card' onClick={() => setControlText(item)}>
                <View className='command-info'>
                  <Text className='command-text'>{item}</Text>
                  <Text className='command-desc'>点击可直接填入下方控制框</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        <View className='recognition-section'>
          <View className='section-header'>
            <Text className='section-title'>语音识别控制</Text>
          </View>

          <View className='recognition-card'>
            <View className='recognition-result'>
              <Text className='result-label'>识别文本</Text>
              <Text className='result-text'>{recognizedText || '录音后会自动识别并执行控制'}</Text>
            </View>

            <View className='recognition-actions'>
              <View
                className={`action-button ${isRecording ? 'recording' : ''}`}
                onClick={isRecording ? handleStopRecording : handleStartRecording}
              >
                <Text className='button-text'>{isRecording ? '停止录音' : '开始录音'}</Text>
              </View>
            </View>
          </View>
        </View>

        <View className='assistant-section'>
          <View className='section-header'>
            <Text className='section-title'>文本控制</Text>
            <Text className='section-note'>后端会通过 Function Calling 生成结构化控制动作</Text>
          </View>

          <View className='assistant-card'>
            <Input
              className='assistant-input'
              type='text'
              value={controlText}
              placeholder='例如：把灯光调暗一点，播放白噪音，30 分钟后关闭'
              onInput={(event) => setControlText(event.detail.value)}
            />
            <View
              className={`assistant-button ${controlLoading ? 'disabled' : ''}`}
              onClick={() => void submitDeviceControl(controlText, 'text')}
            >
              <Text className='assistant-button-text'>{controlLoading ? '执行中...' : '执行控制'}</Text>
            </View>
          </View>

          {controlResult ? (
            <View className='assistant-result-card'>
              <Text className='assistant-result-title'>结构化动作</Text>
              <Text className='assistant-result-line'>工具：{controlResult.toolCall.name}</Text>
              <Text className='assistant-result-line'>摘要：{controlResult.summary.join('；')}</Text>

              {controlResult.immediateResults.map((item, index) => (
                <Text key={`${item.command}-${index}`} className='assistant-result-line'>
                  立即执行：{item.summary}
                </Text>
              ))}

              {controlResult.scheduledActions.length > 0 ? (
                <View className='scheduled-list'>
                  <Text className='assistant-result-title'>延时任务</Text>
                  {controlResult.scheduledActions.map((item) => (
                    <Text key={item.id} className='assistant-result-line'>
                      {item.summary}，执行时间 {formatDate(item.executeAt, 'MM-DD HH:mm')}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        <View className='assistant-section'>
          <View className='section-header'>
            <Text className='section-title'>睡眠知识问答</Text>
            <Text className='section-note'>先检索说明书和 FAQ，再给出自然语言回答</Text>
          </View>

          <View className='chip-list'>
            {KNOWLEDGE_EXAMPLES.map((item) => (
              <View key={item} className='question-chip' onClick={() => void submitKnowledgeQuestion(item)}>
                <Text className='question-chip-text'>{item}</Text>
              </View>
            ))}
          </View>

          <View className='assistant-card'>
            <Input
              className='assistant-input'
              type='text'
              value={knowledgeQuestion}
              placeholder='继续问：设备怎么重新配网？'
              onInput={(event) => setKnowledgeQuestion(event.detail.value)}
            />
            <View
              className={`assistant-button ${knowledgeLoading ? 'disabled' : ''}`}
              onClick={() => void submitKnowledgeQuestion()}
            >
              <Text className='assistant-button-text'>{knowledgeLoading ? '检索中...' : '开始问答'}</Text>
            </View>
          </View>

          {knowledgeAnswer ? (
            <View className='assistant-result-card'>
              <Text className='assistant-result-title'>回答</Text>
              <Text className='assistant-result-answer'>{knowledgeAnswer.answer}</Text>

              {knowledgeAnswer.matchedTopics.length > 0 ? (
                <View className='matched-topics'>
                  {knowledgeAnswer.matchedTopics.map((item) => (
                    <View key={item} className='topic-badge'>
                      <Text className='topic-badge-text'>{item}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {knowledgeAnswer.sources.length > 0 ? (
                <View className='source-list'>
                  <Text className='assistant-result-title'>来源</Text>
                  {knowledgeAnswer.sources.map((item, index) => (
                    <Text key={`${item.path}-${index}`} className='assistant-result-line'>
                      {item.title} / {item.section}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        <View className='white-noise-section'>
          <View className='section-header'>
            <Text className='section-title'>白噪音快捷播放</Text>
          </View>

          <View className='noise-grid'>
            {whiteNoiseList.map((noise) => (
              <View key={noise.id} className='noise-card'>
                <View className='noise-cover'>
                  <Image
                    className='cover-image'
                    src={noise.cover || 'https://via.placeholder.com/80'}
                    mode='aspectFill'
                  />
                </View>
                <View className='noise-info'>
                  <Text className='noise-name'>{noise.name}</Text>
                  <Text className='noise-category'>{noise.category}</Text>
                  <Text className='noise-duration'>{noise.duration} 秒</Text>
                </View>
                <View
                  className={`noise-action ${currentNoise?.id === noise.id && isPlaying ? 'playing' : ''}`}
                  onClick={() =>
                    currentNoise?.id === noise.id && isPlaying
                      ? void handleStopNoise()
                      : void handlePlayNoise(noise)
                  }
                >
                  <Text className='button-text'>
                    {currentNoise?.id === noise.id && isPlaying ? '停止' : '播放'}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  )
}

export default VoicePage
