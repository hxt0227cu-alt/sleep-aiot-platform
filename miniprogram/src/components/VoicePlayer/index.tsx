import React, { useState, useRef, useEffect } from 'react'
import { View, Text, Slider } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

interface VoicePlayerProps {
  soundUrl: string
  title: string
  duration: number
  onPlayEnd?: () => void
}

const VoicePlayer: React.FC<VoicePlayerProps> = ({ soundUrl, title, duration, onPlayEnd }) => {
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const audioRef = useRef<any>(null)

  useEffect(() => {
    // 初始化音频实例
    if (!audioRef.current) {
      audioRef.current = Taro.createInnerAudioContext()
      audioRef.current.src = soundUrl
      
      audioRef.current.onTimeUpdate(() => {
        setCurrentTime(audioRef.current.currentTime)
      })
      
      audioRef.current.onEnded(() => {
        setIsPlaying(false)
        setCurrentTime(0)
        onPlayEnd?.()
      })
      
      audioRef.current.onError((err) => {
        console.error('音频播放错误:', err)
        setIsPlaying(false)
      })
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.stop()
        audioRef.current.destroy()
        audioRef.current = null
      }
      setIsPlaying(false)
      setCurrentTime(0)
    }
  }, [soundUrl])

  const handlePlay = () => {
    if (audioRef.current) {
      audioRef.current.play()
      setIsPlaying(true)
    }
  }

  const handlePause = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      setIsPlaying(false)
    }
  }

  const handleStop = () => {
    if (audioRef.current) {
      audioRef.current.stop()
      setIsPlaying(false)
      setCurrentTime(0)
    }
  }

  const handleSeek = (event: any) => {
    const value = Number(event.detail.value)
    if (audioRef.current) {
      audioRef.current.seek(value)
      setCurrentTime(value)
    }
  }

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <View className='voice-player'>
      <View className='player-header'>
        <Text className='player-title'>{title}</Text>
        <Text className='player-time'>{formatTime(currentTime)} / {formatTime(duration)}</Text>
      </View>
      
      <View className='player-controls'>
        <View className='control-button' onClick={isPlaying ? handlePause : handlePlay}>
          <Text className='control-icon'>{isPlaying ? '⏸' : '▶️'}</Text>
        </View>
        <View className='control-button' onClick={handleStop}>
          <Text className='control-icon'>⏹</Text>
        </View>
      </View>
      
      <Slider
        className='progress-slider'
        value={currentTime}
        min={0}
        max={duration}
        step={1}
        activeColor='#f59e0b'
        backgroundColor='rgba(255,255,255,0.1)'
        onChange={handleSeek}
      />
    </View>
  )
}

export default VoicePlayer
