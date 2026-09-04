import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Check,
  ChevronRight,
  Database,
  FlaskConical,
  Lightbulb,
  Moon,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Send,
  Server,
  ShieldCheck,
  Users,
  Wifi,
  X,
} from 'lucide-react'

type Overview = {
  generatedAt: number
  users: { total: number }
  devices: { total: number; online: number; active: number; onlineRate: number }
  light: { on: number; averageBrightness: number }
  alarms: { total: number }
  sleep: { recentReports: Array<Record<string, unknown>> }
  vitalSigns: { recent: Array<Record<string, unknown>> }
  websocket: { connectedDevices: number }
}

type ProposalAction = {
  id: string
  action: string
  actorId: string
  fromStatus?: string
  toStatus: string
  version: number
  reason?: string
  createdAt: string
}

type AlgorithmProposal = {
  id: string
  agentRunId: string
  proposerId: string
  reviewerId?: string
  status: string
  version: number
  policyVersion: string
  cohortCriteria: { cohortId?: string; dataClass?: string }
  parameterDiff: Record<string, { from?: number; to?: number }>
  hypothesis: string
  rationale: string
  primaryMetric: string
  guardrailMetrics: string[]
  sampleSize: number
  evidenceRef: string
  canaryPercentage: number
  rollbackCondition: string
  updatedAt: string
  actions?: ProposalAction[]
}

type ApiEnvelope<T> = { data?: T; message?: string }
type View = 'overview' | 'algorithm'

const emptyOverview: Overview = {
  generatedAt: Date.now(),
  users: { total: 0 },
  devices: { total: 0, online: 0, active: 0, onlineRate: 0 },
  light: { on: 0, averageBrightness: 0 },
  alarms: { total: 0 },
  sleep: { recentReports: [] },
  vitalSigns: { recent: [] },
  websocket: { connectedDevices: 0 },
}

const statusNames: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_REVIEW: '待审批',
  APPROVED: '已批准',
  CANARY: '5% 灰度',
  ACTIVE: '已生效',
  REJECTED: '已驳回',
  ROLLED_BACK: '已回滚',
  EXPIRED: '已过期',
}

async function parseResponse<T>(response: Response): Promise<ApiEnvelope<T>> {
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>
  if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
  return payload
}

function tokenUserId(token: string) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: string }
    return payload.sub || ''
  } catch {
    return ''
  }
}

export function App() {
  const [apiBase, setApiBase] = useState(() => localStorage.getItem('sleep_api_base') || 'http://localhost:3000/api')
  const [token, setToken] = useState(() => sessionStorage.getItem('sleep_access_token') || '')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [view, setView] = useState<View>('overview')
  const [overview, setOverview] = useState(emptyOverview)
  const [status, setStatus] = useState('等待刷新')
  const [proposals, setProposals] = useState<AlgorithmProposal[]>([])
  const [selected, setSelected] = useState<AlgorithmProposal | null>(null)
  const [proposalStatus, setProposalStatus] = useState('')
  const [proposalError, setProposalError] = useState('')
  const [proposalLoading, setProposalLoading] = useState(false)
  const [cohortId, setCohortId] = useState('employee-opt-in')
  const [actionReason, setActionReason] = useState('')
  const apiOrigin = useMemo(() => apiBase.replace(/\/+$/, ''), [apiBase])
  const userId = useMemo(() => tokenUserId(token), [token])
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  async function loadOverview() {
    setStatus('加载中')
    try {
      const response = await fetch(`${apiOrigin}/dashboard/overview`, {
        headers: token ? authHeaders : {},
      })
      const payload = await parseResponse<Overview>(response)
      setOverview(payload.data || emptyOverview)
      setStatus('已更新')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '加载失败')
    }
  }

  async function loginAndLoad() {
    setStatus('登录中')
    try {
      const response = await fetch(`${apiOrigin}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password }),
      })
      const payload = await parseResponse<{ accessToken: string }>(response)
      const nextToken = payload.data?.accessToken
      if (!nextToken) throw new Error('登录响应缺少访问令牌')
      setToken(nextToken)
      setPassword('')
      sessionStorage.setItem('sleep_access_token', nextToken)
      setStatus('已登录')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '登录失败')
    }
  }

  async function loadProposals(preferredId?: string) {
    if (!token) {
      setProposalError('请先使用管理员账号登录')
      return
    }
    setProposalLoading(true)
    setProposalError('')
    try {
      const query = proposalStatus ? `?status=${proposalStatus}` : ''
      const response = await fetch(`${apiOrigin}/algorithm-proposals${query}`, { headers: authHeaders })
      const payload = await parseResponse<AlgorithmProposal[]>(response)
      const list = payload.data || []
      setProposals(list)
      const nextId = preferredId || selected?.id || list[0]?.id
      if (nextId) await loadProposal(nextId)
      else setSelected(null)
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '提案加载失败')
    } finally {
      setProposalLoading(false)
    }
  }

  async function loadProposal(id: string) {
    const response = await fetch(`${apiOrigin}/algorithm-proposals/${id}`, { headers: authHeaders })
    const payload = await parseResponse<AlgorithmProposal>(response)
    setSelected(payload.data || null)
  }

  async function createProposal() {
    if (!cohortId.trim()) return
    setProposalLoading(true)
    setProposalError('')
    try {
      const runResponse = await fetch(`${apiOrigin}/agents/runs`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'algorithm_optimization',
          workflowVersion: 'business-v1',
          input: { cohort_id: cohortId.trim() },
        }),
      })
      const runPayload = await parseResponse<{ runId: string }>(runResponse)
      const runId = runPayload.data?.runId
      if (!runId) throw new Error('Agent 任务未返回运行编号')

      let completed = false
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 1000))
        const response = await fetch(`${apiOrigin}/agents/runs/${runId}`, { headers: authHeaders })
        const payload = await parseResponse<{ status: string; errorMessage?: string }>(response)
        if (payload.data?.status === 'succeeded') {
          completed = true
          break
        }
        if (['failed', 'cancelled'].includes(payload.data?.status || '')) {
          throw new Error(payload.data?.errorMessage || '算法分析未完成')
        }
      }
      if (!completed) throw new Error('算法分析超时，请稍后刷新')

      const response = await fetch(`${apiOrigin}/algorithm-proposals/from-run`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      })
      const payload = await parseResponse<AlgorithmProposal>(response)
      await loadProposals(payload.data?.id)
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '提案生成失败')
    } finally {
      setProposalLoading(false)
    }
  }

  async function transition(action: string, requireReason = false) {
    if (!selected) return
    if (requireReason && !actionReason.trim()) {
      setProposalError('该操作必须填写原因')
      return
    }
    setProposalLoading(true)
    setProposalError('')
    try {
      const response = await fetch(`${apiOrigin}/algorithm-proposals/${selected.id}/${action}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: selected.version, reason: actionReason.trim() || undefined }),
      })
      await parseResponse<AlgorithmProposal>(response)
      setActionReason('')
      await loadProposals(selected.id)
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '操作失败')
    } finally {
      setProposalLoading(false)
    }
  }

  useEffect(() => localStorage.setItem('sleep_api_base', apiBase), [apiBase])
  useEffect(() => {
    if (view === 'overview') void loadOverview()
    if (view === 'algorithm') void loadProposals()
  }, [apiOrigin, token, view, proposalStatus])

  const latestVital = overview.vitalSigns.recent[0]
  const latestReport = overview.sleep.recentReports[0]

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div className="brand">
          <span className="brand-mark"><Moon size={24} /></span>
          <div><h1>智能睡眠运营控制台</h1><p>设备运营与算法策略发布</p></div>
        </div>
        <button className="icon-command" onClick={() => void (view === 'overview' ? loadOverview() : loadProposals())} title="刷新">
          <RefreshCw size={18} /><span>刷新</span>
        </button>
      </header>

      <nav className="view-tabs" aria-label="控制台视图">
        <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}><Activity size={17} />运行总览</button>
        <button className={view === 'algorithm' ? 'active' : ''} onClick={() => setView('algorithm')}><ShieldCheck size={17} />算法策略</button>
      </nav>

      <section className="config-row">
        <label>API<input value={apiBase} onChange={(event) => setApiBase(event.target.value)} /></label>
        <label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="username" /></label>
        <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
        <button onClick={() => void loginAndLoad()}>登录</button>
        <output>{status} · {new Date(overview.generatedAt).toLocaleString()}</output>
      </section>

      {view === 'overview' ? (
        <>
          <section className="metric-grid">
            <Metric icon={<Users />} label="用户总数" value={overview.users.total} />
            <Metric icon={<Server />} label="设备总数" value={overview.devices.total} />
            <Metric icon={<Wifi />} label="在线设备" value={`${overview.devices.online} / ${overview.devices.onlineRate}%`} />
            <Metric icon={<Activity />} label="活跃设备" value={overview.devices.active} />
            <Metric icon={<Lightbulb />} label="亮灯设备" value={overview.light.on} />
            <Metric icon={<Radio />} label="WebSocket 设备" value={overview.websocket.connectedDevices} />
            <Metric icon={<Database />} label="平均亮度" value={`${overview.light.averageBrightness}%`} />
            <Metric icon={<Activity />} label="告警总数" value={overview.alarms.total} />
          </section>
          <section className="panel-grid">
            <Panel title="最新体征">
              <DataRow label="设备" value={String(latestVital?.deviceId || '-')} />
              <DataRow label="心率" value={String(latestVital?.heartRate ?? '-')} />
              <DataRow label="呼吸" value={String(latestVital?.breathingRate ?? '-')} />
              <DataRow label="睡眠状态" value={String(latestVital?.sleepState || '-')} />
            </Panel>
            <Panel title="最近睡眠报告">
              <DataRow label="设备" value={String(latestReport?.deviceId || '-')} />
              <DataRow label="评分" value={String(latestReport?.sleepScore ?? '-')} />
              <DataRow label="报告数量" value={overview.sleep.recentReports.length} />
            </Panel>
          </section>
        </>
      ) : (
        <section className="algorithm-workspace">
          <div className="proposal-toolbar">
            <label>授权群体<input value={cohortId} onChange={event => setCohortId(event.target.value)} /></label>
            <button disabled={proposalLoading || !token} onClick={() => void createProposal()}><FlaskConical size={17} />生成候选提案</button>
            <label>状态
              <select value={proposalStatus} onChange={event => setProposalStatus(event.target.value)}>
                <option value="">全部</option>
                {Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>

          {proposalError && <div className="error-banner" role="alert">{proposalError}<button onClick={() => void loadProposals()}>重试</button></div>}
          <div className="proposal-layout">
            <div className="proposal-list" aria-busy={proposalLoading}>
              {proposals.length === 0 && !proposalLoading && <div className="empty-state">暂无算法提案</div>}
              {proposals.map(item => (
                <button key={item.id} className={`proposal-row ${selected?.id === item.id ? 'selected' : ''}`} onClick={() => void loadProposal(item.id)}>
                  <span><strong>{item.hypothesis}</strong><small>{String(item.cohortCriteria.cohortId || '-')} · 样本 {item.sampleSize}</small></span>
                  <Status value={item.status} /><ChevronRight size={17} />
                </button>
              ))}
            </div>

            <div className="proposal-detail">
              {!selected ? <div className="empty-state">选择一条提案查看发布详情</div> : (
                <>
                  <div className="detail-heading"><div><Status value={selected.status} /><h2>{selected.hypothesis}</h2></div><span>v{selected.version}</span></div>
                  <div className="detail-grid">
                    <DataRow label="策略版本" value={selected.policyVersion} />
                    <DataRow label="目标群体" value={String(selected.cohortCriteria.cohortId || '-')} />
                    <DataRow label="主指标" value={selected.primaryMetric} />
                    <DataRow label="样本量" value={selected.sampleSize} />
                    <DataRow label="证据引用" value={selected.evidenceRef} />
                    <DataRow label="灰度比例" value={`${selected.canaryPercentage}%`} />
                  </div>
                  <section className="detail-section"><h3>参数变更</h3>{Object.entries(selected.parameterDiff).map(([key, value]) => <DataRow key={key} label={key} value={`${value.from ?? '-'} → ${value.to ?? '-'}`} />)}</section>
                  <section className="detail-section"><h3>回滚条件</h3><p>{selected.rollbackCondition}</p></section>

                  <label className="reason-field">操作说明<input value={actionReason} onChange={event => setActionReason(event.target.value)} placeholder="驳回和回滚时必填" /></label>
                  <div className="action-bar">
                    {selected.status === 'DRAFT' && <button onClick={() => void transition('submit')}><Send size={17} />提交审批</button>}
                    {selected.status === 'PENDING_REVIEW' && selected.proposerId !== userId && <button onClick={() => void transition('approve')}><Check size={17} />批准</button>}
                    {selected.status === 'PENDING_REVIEW' && <button className="danger" onClick={() => void transition('reject', true)}><X size={17} />驳回</button>}
                    {selected.status === 'PENDING_REVIEW' && selected.proposerId === userId && <span className="separation-note">需另一位 owner/admin 审批</span>}
                    {selected.status === 'APPROVED' && <button onClick={() => void transition('start-canary')}><Play size={17} />启动 5% 灰度</button>}
                    {selected.status === 'CANARY' && <button onClick={() => void transition('promote')}><Check size={17} />全量生效</button>}
                    {['CANARY', 'ACTIVE'].includes(selected.status) && <button className="danger" onClick={() => void transition('rollback', true)}><RotateCcw size={17} />回滚</button>}
                  </div>

                  <section className="timeline"><h3>操作记录</h3>{selected.actions?.map(action => <div key={action.id}><span className="timeline-dot" /><p><strong>{action.action}</strong> · {statusNames[action.toStatus] || action.toStatus}<small>{new Date(action.createdAt).toLocaleString()} · v{action.version}{action.reason ? ` · ${action.reason}` : ''}</small></p></div>)}</section>
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

function Status({ value }: { value: string }) {
  return <span className={`status-badge status-${value.toLowerCase()}`}>{statusNames[value] || value}</span>
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return <article className="metric-card"><span>{icon}</span><div><p>{label}</p><strong>{value}</strong></div></article>
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="panel"><h2>{title}</h2>{children}</section>
}

function DataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="data-row"><span>{label}</span><strong>{value}</strong></div>
}
