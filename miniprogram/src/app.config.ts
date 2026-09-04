export default {
  pages: [
    'pages/login/index',
    'pages/index/index',
    'pages/history/index',
    'pages/sleep-report/index',
    'pages/profile/index',
    'pages/device/index',
    'pages/device-provision/index',
    'pages/device-bind/index',
    'pages/device-detail/index',
    'pages/alarm/index',
    'pages/alarm/detail/index',
    'pages/alarm-settings/index',
    'pages/light/index',
    'pages/light-alarm/index',
    'pages/voice/index',
    'pages/agent-center/index'
  ],
  window: {
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#fdf9f1',
    navigationBarTitleText: '智能睡眠台灯',
    navigationBarTextStyle: 'black'
  },
  tabBar: {
    color: 'rgba(75,42,106,0.45)',
    selectedColor: '#8264A2',
    backgroundColor: '#fdf9f1',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/index/index',
        text: '首页',
        iconPath: 'assets/icons/home.png',
        selectedIconPath: 'assets/icons/home-active.png'
      },
      {
        pagePath: 'pages/history/index',
        text: '数据',
        iconPath: 'assets/icons/data.png',
        selectedIconPath: 'assets/icons/data-active.png'
      },
      {
        pagePath: 'pages/profile/index',
        text: '我的',
        iconPath: 'assets/icons/profile.png',
        selectedIconPath: 'assets/icons/profile-active.png'
      }
    ]
  }
}
