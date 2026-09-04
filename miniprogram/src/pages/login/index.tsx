import React, { useState } from 'react'
import { View, Text, Input, Button, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useUserStore } from '../../store'
import { api } from '../../utils/api'
import { API_BASE_URL } from '../../utils/constants'
import { validators, validateForm } from '../../utils/validator'
import { showToast, showLoading, hideLoading } from '../../utils/util'
import './index.scss'

const LoginPage: React.FC = () => {
  const [loginType, setLoginType] = useState<'wechat' | 'phone' | 'code'>('wechat')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [loading, setLoading] = useState(false)

  const { setUserInfo, setToken } = useUserStore()

  const handleWechatLogin = async () => {
    try {
      setLoading(true)
      showLoading('登录中...')

      const { code: wxCode } = await Taro.login()

      const result = await api.auth.wechatLogin({ code: wxCode })
      
      if (result.code === 200) {
        setUserInfo(result.data.user_info)
        setToken(result.data.token)
        api.setTokens(result.data.token, result.data.refresh_token || '')
        api.setTokens(result.data.token, result.data.refresh_token || '')
        
        Taro.switchTab({
          url: '/pages/index/index'
        })
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('微信登录失败:', error)
      showToast('登录失败，请重试', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const handlePhoneLogin = async () => {
    const { valid, errors } = validateForm(
      { phone, password },
      { phone: validators.phone, password: validators.password }
    )

    if (!valid) {
      showToast(Object.values(errors)[0], 'error')
      return
    }

    try {
      setLoading(true)
      showLoading('登录中...')

      const result = await api.auth.login({ phone, password })
      
      if (result.code === 200) {
        setUserInfo(result.data.user_info)
        setToken(result.data.token)
        api.setTokens(result.data.token, result.data.refresh_token || '')
        
        Taro.switchTab({
          url: '/pages/index/index'
        })
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('登录失败:', error)
      showToast('登录失败，请重试', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const handleSendCode = async () => {
    if (!validators.phone(phone)) {
      showToast('请输入正确的手机号', 'error')
      return
    }

    try {
      showLoading('发送中...')
      
      await Taro.request({
        url: `${API_BASE_URL}/auth/send-code`,
        method: 'POST',
        data: { phone }
      })

      showToast('验证码已发送', 'success')
      
      setCountdown(60)
      const timer = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            clearInterval(timer)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    } catch (error: any) {
      console.error('发送验证码失败:', error)
      showToast('发送失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleCodeLogin = async () => {
    const { valid, errors } = validateForm(
      { phone, code },
      { phone: validators.phone }
    )

    if (!valid) {
      showToast(Object.values(errors)[0], 'error')
      return
    }

    if (code.length !== 6) {
      showToast('请输入6位验证码', 'error')
      return
    }

    try {
      setLoading(true)
      showLoading('登录中...')

      const result = await api.auth.login({ phone, password: code })
      
      if (result.code === 200) {
        setUserInfo(result.data.user_info)
        setToken(result.data.token)
        
        Taro.switchTab({
          url: '/pages/index/index'
        })
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('登录失败:', error)
      showToast('登录失败，请重试', 'error')
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  return (
    <View className='login-page'>
      <View className='login-header'>
        <Image 
          className='logo'
          src='https://via.placeholder.com/120'
          mode='aspectFit'
        />
        <Text className='title'>智能睡眠台灯</Text>
        <Text className='subtitle'>守护您的健康睡眠</Text>
      </View>

      <View className='login-tabs'>
        <View
          className={`tab ${loginType === 'wechat' ? 'active' : ''}`}
          onClick={() => setLoginType('wechat')}
        >
          <Text className='tab-icon'>💬</Text>
          <Text className='tab-text'>微信登录</Text>
        </View>
        <View
          className={`tab ${loginType === 'phone' ? 'active' : ''}`}
          onClick={() => setLoginType('phone')}
        >
          <Text className='tab-text'>账号登录</Text>
        </View>
        <View
          className={`tab ${loginType === 'code' ? 'active' : ''}`}
          onClick={() => setLoginType('code')}
        >
          <Text className='tab-text'>验证码登录</Text>
        </View>
      </View>

      <View className='login-content'>
        {loginType === 'wechat' && (
          <View className='wechat-login'>
            <Button
              disabled={loading}
              onClick={handleWechatLogin}
            >
              {loading ? '登录中...' : '微信一键登录'}
            </Button>
          </View>
        )}

        {loginType === 'phone' && (
          <View className='phone-login'>
            <View className='input-group'>
              <Input
                className='input'
                type='number'
                placeholder='请输入手机号'
                value={phone}
                onInput={(e) => setPhone(e.detail.value)}
                maxlength={11}
              />
            </View>
            <View className='input-group'>
              <Input
                className='input'
                password
                placeholder='请输入密码'
                value={password}
                onInput={(e) => setPassword(e.detail.value)}
                maxlength={20}
              />
            </View>
            <Button
              disabled={loading}
              onClick={handlePhoneLogin}
            >
              {loading ? '登录中...' : '登录'}
            </Button>
          </View>
        )}

        {loginType === 'code' && (
          <View className='code-login'>
            <View className='input-group'>
              <View className='input-row'>
                <Input
                  className='input'
                  type='number'
                  placeholder='请输入手机号'
                  value={phone}
                  onInput={(e) => setPhone(e.detail.value)}
                  maxlength={11}
                />
                <Button
                  className='code-button'
                  disabled={countdown > 0}
                  onClick={handleSendCode}
                >
                  {countdown > 0 ? `${countdown}s` : '获取验证码'}
                </Button>
              </View>
            </View>
            <View className='input-group'>
              <Input
                className='input'
                type='number'
                placeholder='请输入验证码'
                value={code}
                onInput={(e) => setCode(e.detail.value)}
                maxlength={6}
              />
            </View>
            <Button
              disabled={loading}
              onClick={handleCodeLogin}
            >
              {loading ? '登录中...' : '登录'}
            </Button>
          </View>
        )}
      </View>

      <View className='login-footer'>
        <Text className='footer-text'>登录即表示同意</Text>
        <Text className='footer-link'>《用户协议》</Text>
        <Text className='footer-text'>和</Text>
        <Text className='footer-link'>《隐私政策》</Text>
      </View>
    </View>
  )
}

export default LoginPage
