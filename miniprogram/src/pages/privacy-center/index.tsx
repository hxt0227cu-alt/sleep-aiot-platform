import { useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, Switch, Button } from '@tarojs/components';
import './index.scss';

/**
 * 隐私中心页面
 *
 * 功能：
 *   - 展示隐私政策和数据收集说明
 *   - 管理数据收集授权（可撤回授权）
 *   - 数据导出和删除功能
 *   - 第三方信息共享清单
 */
export default function PrivacyCenter() {
  // 授权状态
  const [permissions, setPermissions] = useState({
    healthData: true,        // 健康数据收集
    locationData: false,     // 位置信息
    cameraAccess: false,     // 相机访问
    analyticsData: true,     // 数据分析
    personalizedAds: false,  // 个性化广告
  });

  // 数据统计
  const [dataStats] = useState({
    totalSleepRecords: 128,
    totalAlarmEvents: 15,
    dataSizeMB: 25.6,
    firstCollectedDate: '2026-01-15',
  });

  // 模态框状态
  const [modal, setModal] = useState<{
    visible: boolean;
    title: string;
    desc: string;
    type: 'info' | 'confirm' | 'danger';
    onConfirm?: () => void;
  }>({ visible: false, title: '', desc: '', type: 'info' });

  // 切换授权
  const handlePermissionChange = (key: keyof typeof permissions, value: boolean) => {
    if (!value && (key === 'healthData')) {
      // 撤回健康数据授权需要确认
      setModal({
        visible: true,
        title: '撤回数据授权',
        desc: '撤回健康数据授权后，将停止收集您的睡眠和健康数据，已收集的数据将被删除。此操作不可撤销。',
        type: 'danger',
        onConfirm: () => {
          setPermissions(prev => ({ ...prev, [key]: value }));
          setModal(prev => ({ ...prev, visible: false }));
          Taro.showToast({ title: '授权已撤回', icon: 'success' });
        },
      });
    } else {
      setPermissions(prev => ({ ...prev, [key]: value }));
    }
  };

  // 导出数据
  const handleExportData = () => {
    setModal({
      visible: true,
      title: '导出个人数据',
      desc: '我们将整理您的所有个人数据并生成导出文件，包含睡眠记录、报警事件、账户信息等。导出文件将通过邮件发送给您，预计需要1-3个工作日。',
      type: 'info',
      onConfirm: () => {
        setModal(prev => ({ ...prev, visible: false }));
        Taro.showToast({ title: '导出申请已提交', icon: 'success' });
      },
    });
  };

  // 删除账户
  const handleDeleteAccount = () => {
    setModal({
      visible: true,
      title: '注销账户',
      desc: '注销账户后，您的所有个人数据将被永久删除，包括睡眠记录、设备绑定、账户信息等。此操作不可撤销，且注销后无法恢复。',
      type: 'danger',
      onConfirm: () => {
        setModal(prev => ({ ...prev, visible: false }));
        Taro.showModal({
          title: '再次确认',
          content: '您确定要注销账户吗？此操作不可撤销。',
          confirmColor: '#ff4d4f',
          success: (res) => {
            if (res.confirm) {
              Taro.showToast({ title: '注销申请已提交', icon: 'success' });
            }
          },
        });
      },
    });
  };

  // 权限列表项
  const permissionItems = [
    {
      key: 'healthData' as const,
      icon: '❤️',
      title: '健康数据收集',
      desc: '收集睡眠、心率、呼吸、血氧等健康数据',
      required: true,
    },
    {
      key: 'analyticsData' as const,
      icon: '📊',
      title: '使用数据分析',
      desc: '收集应用使用数据用于改进产品体验',
      required: false,
    },
    {
      key: 'locationData' as const,
      icon: '📍',
      title: '位置信息',
      desc: '用于天气关联和时区自动调整',
      required: false,
    },
    {
      key: 'personalizedAds' as const,
      icon: '🎯',
      title: '个性化推荐',
      desc: '基于您的使用习惯提供个性化内容推荐',
      required: false,
    },
  ];

  return (
    <View className='container'>
      {/* 头部 */}
      <View className='header'>
        <Text className='header-title'>隐私中心</Text>
        <Text className='header-desc'>
          我们重视您的隐私。您可以在这里管理数据授权、查看数据收集情况、行使个人信息权利。
        </Text>
      </View>

      {/* 数据收集授权 */}
      <View className='card'>
        <Text className='card-title'>数据收集授权</Text>
        {permissionItems.map(item => (
          <View className='list-item' key={item.key}>
            <View className='list-item-left'>
              <View className='list-item-icon'>{item.icon}</View>
              <View className='list-item-content'>
                <Text className='list-item-title'>
                  {item.title}
                  {item.required && <Text style={{ color: '#ff4d4f', marginLeft: '8rpx' }}>*</Text>}
                </Text>
                <Text className='list-item-desc'>{item.desc}</Text>
              </View>
            </View>
            <View className='list-item-right'>
              <Switch
                className='switch'
                checked={permissions[item.key]}
                onChange={(e) => handlePermissionChange(item.key, e.detail.value)}
                color='#667eea'
              />
            </View>
          </View>
        ))}
      </View>

      {/* 我的数据 */}
      <View className='card'>
        <Text className='card-title'>我的数据</Text>
        <View className='data-section'>
          <View className='data-item'>
            <Text className='data-item-label'>睡眠记录</Text>
            <Text className='data-item-value'>{dataStats.totalSleepRecords} 条</Text>
          </View>
          <View className='data-item'>
            <Text className='data-item-label'>报警事件</Text>
            <Text className='data-item-value'>{dataStats.totalAlarmEvents} 条</Text>
          </View>
          <View className='data-item'>
            <Text className='data-item-label'>数据大小</Text>
            <Text className='data-item-value'>{dataStats.dataSizeMB} MB</Text>
          </View>
          <View className='data-item'>
            <Text className='data-item-label'>首次收集日期</Text>
            <Text className='data-item-value'>{dataStats.firstCollectedDate}</Text>
          </View>
        </View>
      </View>

      {/* 个人信息权利 */}
      <View className='card'>
        <Text className='card-title'>个人信息权利</Text>
        <View
          className='list-item'
          onClick={handleExportData}
        >
          <View className='list-item-left'>
            <View className='list-item-icon'>📤</View>
            <View className='list-item-content'>
              <Text className='list-item-title'>导出个人数据</Text>
              <Text className='list-item-desc'>获取您的所有个人数据副本</Text>
            </View>
          </View>
          <View className='list-item-right'>
            <Text className='list-item-arrow'>›</Text>
          </View>
        </View>
        <View
          className='list-item'
          onClick={() => Taro.navigateTo({ url: '/pages/data-request/index?type=access' })}
        >
          <View className='list-item-left'>
            <View className='list-item-icon'>🔍</View>
            <View className='list-item-content'>
              <Text className='list-item-title'>查阅和复制数据</Text>
              <Text className='list-item-desc'>查看我们收集的您的个人信息</Text>
            </View>
          </View>
          <View className='list-item-right'>
            <Text className='list-item-arrow'>›</Text>
          </View>
        </View>
        <View
          className='list-item'
          onClick={() => Taro.navigateTo({ url: '/pages/data-request/index?type=correct' })}
        >
          <View className='list-item-left'>
            <View className='list-item-icon'>✏️</View>
            <View className='list-item-content'>
              <Text className='list-item-title'>更正个人信息</Text>
              <Text className='list-item-desc'>更正不准确的个人信息</Text>
            </View>
          </View>
          <View className='list-item-right'>
            <Text className='list-item-arrow'>›</Text>
          </View>
        </View>
      </View>

      {/* 第三方信息共享 */}
      <View className='card'>
        <Text className='card-title'>第三方信息共享</Text>
        <View
          className='list-item'
          onClick={() => Taro.navigateTo({ url: '/pages/third-party-list/index' })}
        >
          <View className='list-item-left'>
            <View className='list-item-icon'>🤝</View>
            <View className='list-item-content'>
              <Text className='list-item-title'>第三方共享清单</Text>
              <Text className='list-item-desc'>查看我们与哪些第三方共享您的信息</Text>
            </View>
          </View>
          <View className='list-item-right'>
            <Text className='list-item-arrow'>›</Text>
          </View>
        </View>
      </View>

      {/* 操作按钮 */}
      <View className='button-group'>
        <Button
          className='secondary-button'
          onClick={() => Taro.navigateTo({ url: '/pages/privacy-policy/index' })}
        >
          查看隐私政策
        </Button>
        <Button
          className='danger-button'
          onClick={handleDeleteAccount}
        >
          注销账户
        </Button>
      </View>

      {/* 底部说明 */}
      <View className='footer'>
        <Text>
          如有隐私相关问题，请联系我们：
        </Text>
        <Text className='footer-link' onClick={() => Taro.makePhoneCall({ phoneNumber: '400-xxx-xxxx' })}>
          400-xxx-xxxx
        </Text>
        <Text> 或 </Text>
        <Text className='footer-link' onClick={() => Taro.navigateTo({ url: '/pages/feedback/index' })}>
          在线反馈
        </Text>
      </View>

      {/* 模态框 */}
      {modal.visible && (
        <View className='modal-mask' onClick={() => modal.type !== 'danger' && setModal(prev => ({ ...prev, visible: false }))}>
          <View className='modal-content' onClick={(e) => e.stopPropagation()}>
            <Text className='modal-title'>{modal.title}</Text>
            <Text className='modal-desc'>{modal.desc}</Text>
            <View className='modal-buttons'>
              <Button
                className='modal-button modal-button-cancel'
                onClick={() => setModal(prev => ({ ...prev, visible: false }))}
              >
                取消
              </Button>
              <Button
                className='modal-button modal-button-confirm'
                onClick={() => modal.onConfirm?.()}
              >
                确认
              </Button>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
