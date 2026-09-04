import React, { useState, useEffect } from 'react'
import { View, Text, ScrollView, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useUserStore, useDeviceStore } from '../../store'
import { api } from '../../utils/api'
import { API_BASE_URL } from '../../utils/constants'
import { showToast, showLoading, hideLoading, showModal } from '../../utils/util'
import Loading from '../../components/Loading'
import './index.scss'

const ProfilePage: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [showContactModal, setShowContactModal] = useState(false)
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactRelation, setContactRelation] = useState('')

  const { userInfo, isAuthenticated, logout } = useUserStore()
  const { devices, currentDevice } = useDeviceStore()

  useEffect(() => {
    if (!isAuthenticated) {
      Taro.redirectTo({ url: '/pages/login/index' })
      return
    }
    loadUserData()
  }, [])

  const loadUserData = async () => {
    try {
      setLoading(true)
      showLoading('加载中...')

      const result = await api.user.getUserProfile()
      if (result.code === 200) {
        useUserStore.getState().setUserInfo(result.data)
      }
    } catch (error: any) {
      console.error('加载用户信息失败:', error)
    } finally {
      setLoading(false)
      hideLoading()
    }
  }

  const handleLogout = async () => {
    const confirmed = await showModal('退出登录', '确定要退出登录吗？')
    if (confirmed) {
      try {
        await api.logout()
        useUserStore.getState().logout()
        Taro.reLaunch({ url: '/pages/login/index' })
      } catch (error: any) {
        console.error('退出登录失败:', error)
        showToast('退出失败，请重试', 'error')
      }
    }
  }

  const handleAddContact = async () => {
    if (!contactName || !contactPhone || !contactRelation) {
      showToast('请填写完整信息', 'error')
      return
    }

    try {
      showLoading('添加中...')
      
      const result = await api.user.manageContacts({
        name: contactName,
        phone: contactPhone,
        relationship: contactRelation
      })

      if (result.code === 200) {
        showToast('添加成功', 'success')
        setShowContactModal(false)
        setContactName('')
        setContactPhone('')
        setContactRelation('')
      } else {
        showToast(result.message, 'error')
      }
    } catch (error: any) {
      console.error('添加联系人失败:', error)
      showToast('添加失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleChooseAvatar = () => {
    Taro.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera']
    }).then((res) => {
      if (res.tempFilePaths && res.tempFilePaths.length > 0) {
        uploadAvatar(res.tempFilePaths[0])
      }
    })
  }

  const uploadAvatar = async (filePath: string) => {
    try {
      showLoading('上传中...')
      
      Taro.uploadFile({
        url: `${API_BASE_URL}/users/avatar`,
        filePath,
        name: 'avatar',
        header: {
          'Authorization': `Bearer ${api.getToken()}`
        }
      }).then((uploadRes) => {
        if (uploadRes.statusCode === 200) {
          const data = JSON.parse(uploadRes.data)
          useUserStore.getState().setUserInfo({
            ...userInfo,
            avatar: data.avatar
          })
          showToast('头像更新成功', 'success')
        }
      })
    } catch (error: any) {
      console.error('上传头像失败:', error)
      showToast('上传失败，请重试', 'error')
    } finally {
      hideLoading()
    }
  }

  const handleNavigateTo = (url: string) => {
    Taro.navigateTo({ url })
  }

  if (loading) {
    return <Loading text='加载中...' size='large' />
  }

  return (
    <View className='profile-page'>
      <ScrollView scrollY className='scroll-container'>
        <View className='user-section'>
          <View className='avatar-section' onClick={handleChooseAvatar}>
            <Image
              className='avatar'
              src={userInfo?.avatar || 'https://via.placeholder.com/120'}
              mode='aspectFill'
            />
            <View className='avatar-edit'>
              <Text className='edit-icon'>📷</Text>
            </View>
          </View>
          
          <View className='user-info'>
            <View className='info-item'>
              <Text className='info-label'>昵称</Text>
              <Text className='info-value'>{userInfo?.nickname || '未设置'}</Text>
            </View>
            <View className='info-item'>
              <Text className='info-label'>手机号</Text>
              <Text className='info-value'>{userInfo?.phone || '未绑定'}</Text>
            </View>
            <View className='info-item'>
              <Text className='info-label'>用户ID</Text>
              <Text className='info-value'>{userInfo?.user_id || ''}</Text>
            </View>
          </View>
        </View>

        <View className='device-section'>
          <View className='section-header'>
            <Text className='section-title'>我的设备</Text>
            <Text className='section-count'>{devices.length}台</Text>
          </View>
          
          {devices.length === 0 ? (
            <View className='empty-state'>
              <Text className='empty-icon'>📱</Text>
              <Text className='empty-text'>暂无设备</Text>
              <View className='empty-action' onClick={() => handleNavigateTo('/pages/device/index')}>
                <Text className='action-text'>去添加设备</Text>
              </View>
            </View>
          ) : (
            <View className='device-list'>
              {devices.map((device) => (
                <View
                  key={device.device_id}
                  className={`device-item ${currentDevice?.device_id === device.device_id ? 'active' : ''}`}
                  onClick={() => handleNavigateTo(`/pages/device/index?deviceId=${device.device_id}`)}
                >
                  <View className='device-icon'>
                    <Text className='icon'>💡</Text>
                  </View>
                  <View className='device-info'>
                    <Text className='device-name'>{device.device_name}</Text>
                    <Text className={`device-status ${device.online ? 'online' : 'offline'}`}>
                      {device.online ? '在线' : '离线'}
                    </Text>
                  </View>
                  {currentDevice?.device_id === device.device_id && (
                    <View className='current-badge'>
                      <Text className='badge-text'>当前</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>

        <View className='menu-section'>
          <View className='menu-item' onClick={() => setShowContactModal(true)}>
            <View className='menu-icon'>
              <Text className='icon'>👥</Text>
            </View>
            <Text className='menu-text'>紧急联系人</Text>
            <Text className='menu-arrow'>›</Text>
          </View>
          
          <View className='menu-item' onClick={() => handleNavigateTo('/pages/alarm/index')}>
            <View className='menu-icon'>
              <Text className='icon'>🔔</Text>
            </View>
            <Text className='menu-text'>报警记录</Text>
            <Text className='menu-arrow'>›</Text>
          </View>
          
          <View className='menu-item' onClick={() => handleNavigateTo('/pages/voice/index')}>
            <View className='menu-icon'>
              <Text className='icon'>🎤</Text>
            </View>
            <Text className='menu-text'>语音设置</Text>
            <Text className='menu-arrow'>›</Text>
          </View>

          <View className='menu-item' onClick={() => handleNavigateTo('/pages/agent-center/index')}>
            <View className='menu-icon'>
              <Text className='icon'>AI</Text>
            </View>
            <Text className='menu-text'>睡眠 Agent 中心</Text>
            <Text className='menu-arrow'>›</Text>
          </View>
          
          <View className='menu-item' onClick={() => handleNavigateTo('/pages/light-alarm/index')}>
            <View className='menu-icon'>
              <Text className='icon'>⏰</Text>
            </View>
            <Text className='menu-text'>光闹钟</Text>
            <Text className='menu-arrow'>›</Text>
          </View>
        </View>

        <View className='settings-section'>
          <View className='section-title'>
            <Text className='title-text'>设置</Text>
          </View>
          
          <View className='menu-item'>
            <View className='menu-icon'>
              <Text className='icon'>⚙️</Text>
            </View>
            <Text className='menu-text'>关于我们</Text>
            <Text className='menu-arrow'>›</Text>
          </View>
          
          <View className='menu-item'>
            <View className='menu-icon'>
              <Text className='icon'>❓</Text>
            </View>
            <Text className='menu-text'>帮助与反馈</Text>
            <Text className='menu-arrow'>›</Text>
          </View>
          
          <View className='menu-item logout' onClick={handleLogout}>
            <View className='menu-icon'>
              <Text className='icon'>🚪</Text>
            </View>
            <Text className='menu-text'>退出登录</Text>
          </View>
        </View>
      </ScrollView>

      {showContactModal && (
        <View className='contact-modal' onClick={() => setShowContactModal(false)}>
          <View className='modal-content' onClick={(e) => e.stopPropagation()}>
            <View className='modal-header'>
              <Text className='modal-title'>添加紧急联系人</Text>
              <View className='close-button' onClick={() => setShowContactModal(false)}>
                <Text className='close-icon'>✕</Text>
              </View>
                       </View>
            
            <View className='modal-body'>
              <View className='input-group'>
                <Text className='input-label'>姓名</Text>
                <input
                  className='input'
                  type='text'
                  placeholder='请输入姓名'
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                />
              </View>
              
              <View className='input-group'>
                <Text className='input-label'>手机号</Text>
                <input
                  className='input'
                  type='tel'
                  placeholder='请输入手机号'
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                />
              </View>
              
              <View className='input-group'>
                <Text className='input-label'>关系</Text>
                <input
                  className='input'
                  type='text'
                  placeholder='请输入关系'
                  value={contactRelation}
                  onChange={(e) => setContactRelation(e.target.value)}
                />
              </View>
            </View>
            
            <View className='modal-footer'>
              <View className='modal-button cancel' onClick={() => setShowContactModal(false)}>
                <Text>取消</Text>
              </View>
              <View className='modal-button confirm' onClick={handleAddContact}>
                <Text>确定</Text>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}

export default ProfilePage
