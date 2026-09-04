import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'

const emptyOverview = {
  generatedAt: Date.now(),
  users: { total: 0 },
  devices: { total: 0, online: 0, active: 0, onlineRate: 0 },
  light: { on: 0, averageBrightness: 0 },
  alarms: { total: 0 },
  sleep: { recentReports: [] },
  vitalSigns: { recent: [] },
  websocket: { connectedDevices: 0 },
}

describe('App (web operations console)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: emptyOverview }),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the console shell and overview metrics', async () => {
    render(<App />)
    expect(screen.getByText('智能睡眠运营控制台')).toBeInTheDocument()
    expect(screen.getByText('运行总览')).toBeInTheDocument()
    expect(await screen.findByText('设备总数')).toBeInTheDocument()
  })

  it('switches to the algorithm strategy view', async () => {
    render(<App />)
    await screen.findByText('设备总数')
    const tab = screen.getByText('算法策略')
    tab.click()
    expect(await screen.findByText('生成候选提案')).toBeInTheDocument()
  })
})
