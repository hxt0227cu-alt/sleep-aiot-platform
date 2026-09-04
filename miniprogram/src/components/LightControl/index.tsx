import React, { useState } from 'react'
import { View, Text, Slider } from '@tarojs/components'
import { formatBrightness, formatColorTemp } from '../../utils/formatter'
import './index.scss'

interface LightControlProps {
  brightness: number
  colorTemp: number
  power: boolean
  onBrightnessChange: (value: number) => void
  onColorTempChange: (value: number) => void
  onPowerToggle: () => void
}

const LightControl: React.FC<LightControlProps> = ({
  brightness,
  colorTemp,
  power,
  onBrightnessChange,
  onColorTempChange,
  onPowerToggle
}) => {
  const [localBrightness, setLocalBrightness] = useState(brightness)
  const [localColorTemp, setLocalColorTemp] = useState(colorTemp)

  const handleBrightnessChange = (event: any) => {
    const value = Number(event.detail.value)
    setLocalBrightness(value)
    onBrightnessChange(value)
  }

  const handleColorTempChange = (event: any) => {
    const value = Number(event.detail.value)
    setLocalColorTemp(value)
    onColorTempChange(value)
  }

  return (
    <View className='light-control'>
      <View className='power-section'>
        <View
          className={`power-button ${power ? 'on' : 'off'}`}
          onClick={onPowerToggle}
        >
          <Text className='power-icon'>{power ? '💡' : '🌙'}</Text>
          <Text className='power-text'>{power ? '已开启' : '已关闭'}</Text>
        </View>
      </View>

      {power && (
        <View className='controls-section'>
          <View className='control-item'>
            <View className='control-header'>
              <Text className='control-label'>亮度</Text>
              <Text className='control-value'>{formatBrightness(localBrightness)}</Text>
            </View>
            <Slider
              className='brightness-slider'
              value={localBrightness}
              min={0}
              max={100}
              step={1}
              activeColor='#f59e0b'
              backgroundColor='rgba(255,255,255,0.2)'
              blockColor='#f59e0b'
              blockSize={20}
              showValue={false}
              onChange={handleBrightnessChange}
            />
          </View>

          <View className='control-item'>
            <View className='control-header'>
              <Text className='control-label'>色温</Text>
              <Text className='control-value'>{formatColorTemp(localColorTemp)}</Text>
            </View>
            <Slider
              className='color-temp-slider'
              value={localColorTemp}
              min={2700}
              max={6500}
              step={100}
              activeColor='#f59e0b'
              backgroundColor='rgba(255,255,255,0.2)'
              blockColor='#f59e0b'
              blockSize={20}
              showValue={false}
              onChange={handleColorTempChange}
            />
          </View>
        </View>
      )}
    </View>
  )
}

export default LightControl
