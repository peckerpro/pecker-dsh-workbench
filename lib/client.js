/**
 * pecker-dsh-workbench —— 客户端入口（已构建的单文件模块）。
 *
 * 形态说明：本文件是手写的单文件模块，不含 JSX、不依赖打包器。工作台规范只要求
 * “已构建好的单文件模块”并通过 window.__ModuleLoader__.load 注册；不用 JSX/构建链
 * 是 V1 的刻意选择（少一个会出错的环节）。后续引入 JSX/Tailwind 时需要加构建步骤。
 *
 * customFrame: 宿主把原生会话节点作为 conversation prop 交给本面板，面板必须把它
 * 放进自己的布局，不得再建一套聊天界面。
 */
window.__ModuleLoader__.load({
  id: 'pecker-dsh-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/pecker-dsh-workbench'
    const POLL_MS = 15_000
    let stylesDone = false

    const CSS = `
.pecker-wb { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0;
  font-size: 13px; line-height: 1.5; color: var(--dsh-text, currentColor); }
.pecker-wb-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--dsh-border, rgba(128,128,128,.28)); flex: 0 0 auto; }
.pecker-wb-title { font-weight: 600; }
.pecker-wb-spacer { flex: 1 1 auto; }
.pecker-wb-btn { border: 1px solid var(--dsh-border, rgba(128,128,128,.35)); background: transparent;
  color: inherit; border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
.pecker-wb-btn:hover { background: rgba(128,128,128,.12); }
.pecker-wb-btn[disabled] { opacity: .5; cursor: default; }
.pecker-wb-body { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }
.pecker-wb-conversation { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.pecker-wb-side { flex: 0 0 380px; max-width: 45%; min-width: 0; overflow: auto; display: flex;
  flex-direction: column; gap: 10px; padding: 10px 12px;
  border-left: 1px solid var(--dsh-border, rgba(128,128,128,.28)); }
.pecker-wb-collapsed .pecker-wb-side { display: none; }
.pecker-wb-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: 0 0 auto; }
.pecker-wb-dot--ok { background: #16a34a; }
.pecker-wb-dot--bad { background: #dc2626; }
.pecker-wb-dot--warn { background: #d97706; }
.pecker-wb-state { font-size: 12px; opacity: .85; }
.pecker-wb-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
.pecker-wb-card { border: 1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius: 8px;
  padding: 6px 8px; min-width: 0; }
.pecker-wb-card-label { font-size: 11px; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pecker-wb-card-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pecker-wb-card-value--muted { font-size: 13px; font-weight: 400; opacity: .7; }
.pecker-wb-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; margin-top: 2px; }
.pecker-wb-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.pecker-wb-list li { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.pecker-wb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pecker-wb-muted { opacity: .7; font-size: 12px; }
.pecker-wb-note { border: 1px solid rgba(217,119,6,.5); background: rgba(217,119,6,.08);
  border-radius: 8px; padding: 8px 10px; font-size: 12px; }
.pecker-wb-note ul { margin: 4px 0 0 16px; padding: 0; }
.pecker-wb-pre { background: rgba(128,128,128,.1); border-radius: 6px; padding: 6px 8px; margin: 0;
  overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.pecker-wb-empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 10px; padding: 24px; text-align: center; }
`

    function ensureStyles() {
      if (stylesDone) return
      stylesDone = true
      try {
        const style = document.createElement('style')
        style.setAttribute('data-pecker-workbench', 'v1')
        style.textContent = CSS
        document.head.appendChild(style)
      } catch {
        /* 样式注入失败不影响功能 */
      }
    }

    async function getJson(path) {
      const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
      return await response.json()
    }

    function useStatus() {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const load = React.useCallback(async () => {
        try {
          setState((previous) => ({ ...previous, loading: true }))
          const data = await getJson('/status')
          setState({ loading: false, data, error: null })
        } catch (error) {
          setState({ loading: false, data: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [])
      React.useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), POLL_MS)
        return () => clearInterval(timer)
      }, [load])
      return { ...state, reload: load }
    }

    function countOf(counts, key) {
      const value = counts?.[key]
      return typeof value === 'number' ? value : null
    }

    function stateCount(rows, field, wanted) {
      if (!Array.isArray(rows)) return null
      const row = rows.find((item) => item?.[field] === wanted)
      return row === undefined ? 0 : row.n
    }

    function Metric(label, value) {
      const known = value !== null && value !== undefined
      return h('div', { className: 'pecker-wb-card', key: label },
        h('div', { className: 'pecker-wb-card-label' }, label),
        h('div', { className: `pecker-wb-card-value${known ? '' : ' pecker-wb-card-value--muted'}` },
          known ? String(value) : '未知'))
    }

    function StatusPanel({ status, error, loading, reload }) {
      const platform = status?.platform
      const counts = platform?.overview?.counts
      const reachable = platform?.reachable === true
      const dotClass = `pecker-wb-dot ${reachable ? 'pecker-wb-dot--ok' : 'pecker-wb-dot--bad'}`
      const bridge = status?.bridge
      const bridgeTone = bridge?.state === 'ready' ? 'ok' : bridge?.state === 'unavailable' ? 'bad' : 'warn'
      // 0.1.2 起 state 分得更细：connected = 平台连上了但 ctx.tools 还没就绪，
      // 这时既不能显示成"工具 N 个"，也不能当成错误。
      const bridgeLabel = bridge?.state === 'ready'
        ? `工具 ${bridge.toolCount} 个`
        : bridge?.state === 'connected'
          ? '工具待注册（等宿主 tools 服务）'
          : bridge?.state === 'connecting'
            ? '正在连接平台…'
            : bridge?.state === 'unavailable'
              ? '平台工具不可用'
              : bridge?.state === 'unconfigured'
                ? '未配置 projectDir'
                : bridge?.state === 'disabled'
                  ? '工具桥接已关闭'
                  : `工具桥接：${bridge?.state ?? '未知'}`

      const recent = platform?.recentJobs ?? []
      const reviewPending = stateCount(platform?.overview?.versions_by_review_state, 'review_state', 'awaiting_review')

      return h('div', { className: 'pecker-wb-side' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: 'pecker-wb-title' }, '本地创作工具'),
          h('span', { className: 'pecker-wb-spacer' }),
          h('button', { className: 'pecker-wb-btn', onClick: () => void reload(), disabled: loading === true },
            loading ? '刷新中…' : '刷新')),

        // 平台连接
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: dotClass }),
          h('span', { className: 'pecker-wb-state' },
            reachable ? `平台已连接 ${status?.config?.platformBaseUrl ?? ''}` : '平台未连接'),
          h('span', { className: 'pecker-wb-spacer' }),
          h('span', { className: `pecker-wb-dot pecker-wb-dot--${bridgeTone}` }),
          h('span', { className: 'pecker-wb-state' }, bridgeLabel)),
        bridge?.note ? h('div', { className: 'pecker-wb-muted' }, bridge.note) : null,
        error !== null && error !== undefined
          ? h('div', { className: 'pecker-wb-muted' }, `读取插件状态失败：${error}`)
          : null,
        reachable ? null : h('div', { className: 'pecker-wb-muted' },
          platform?.error ? `原因：${platform.error}` : '未取得平台健康信息'),

        // 计数
        h('div', { className: 'pecker-wb-section-title' }, '平台计数'),
        h('div', { className: 'pecker-wb-cards' },
          Metric('素材', countOf(counts, 'asset')),
          Metric('作品版本', countOf(counts, 'version')),
          Metric('作业', countOf(counts, 'job')),
          Metric('待人工审核', reviewPending),
          Metric('导入问题', countOf(counts, 'issue')),
          Metric('已登记工具', countOf(counts, 'tool'))),

        // 作业状态
        h('div', { className: 'pecker-wb-section-title' }, '作业状态'),
        h('div', { className: 'pecker-wb-cards' },
          Metric('排队', stateCount(platform?.overview?.jobs_by_state, 'state', 'queued')),
          Metric('运行中', stateCount(platform?.overview?.jobs_by_state, 'state', 'running')),
          Metric('成功', stateCount(platform?.overview?.jobs_by_state, 'state', 'succeeded')),
          Metric('失败', stateCount(platform?.overview?.jobs_by_state, 'state', 'failed'))),

        // 最近作业
        h('div', { className: 'pecker-wb-section-title' }, '最近作业'),
        recent.length === 0
          ? h('div', { className: 'pecker-wb-muted' }, reachable ? '没有作业记录' : '未知')
          : h('ul', { className: 'pecker-wb-list' },
            recent.map((job) => h('li', { key: job.jobId ?? `${job.toolId}-${job.createdAt}` },
              h('span', { className: 'pecker-wb-mono', style: { flex: '0 0 46%' } }, job.toolId ?? '未知'),
              h('span', { className: 'pecker-wb-muted' }, job.state ?? '未知'),
              h('span', { className: 'pecker-wb-spacer' }),
              h('span', { className: 'pecker-wb-mono' }, job.createdAt ?? '')))),

        // 明确不可用能力
        h('div', { className: 'pecker-wb-note' },
          h('strong', null, '当前不可用（如实标注，不做替代）'),
          h('ul', null, (status?.limitations ?? []).map((line, index) => h('li', { key: index }, line)))),

        // 启动命令
        (status?.startCommands ?? []).length === 0 ? null : h('details', null,
          h('summary', { className: 'pecker-wb-muted' }, '平台没在跑？点开启动命令'),
          h('pre', { className: 'pecker-wb-pre' }, (status?.startCommands ?? []).join('\n'))),

        h('div', { className: 'pecker-wb-muted' },
          `工作台身份 peckerpro/pecker-dsh-workbench · 插件 v${status?.plugin?.version ?? '0.1.0'}`))
    }

    function Panel(props) {
      ensureStyles()
      const { service, conversation } = props
      const { loading, data, error, reload } = useStatus()
      const [showSide, setShowSide] = React.useState(true)
      const platformOk = data?.platform?.reachable === true

      React.useEffect(() => {
        // 面板打开时提示一次非会话功能可用（不主动创建会话、不替用户发言）。
        return undefined
      }, [])

      const header = h('div', { className: 'pecker-wb-header' },
        h('span', { className: 'pecker-wb-title' }, '本地创作'),
        h('span', { className: `pecker-wb-dot ${platformOk ? 'pecker-wb-dot--ok' : 'pecker-wb-dot--bad'}` }),
        h('span', { className: 'pecker-wb-state' }, platformOk ? '已连接' : '未连接'),
        h('span', { className: 'pecker-wb-spacer' }),
        h('button', {
          className: 'pecker-wb-btn',
          onClick: () => {
            const url = data?.dashboard?.url
            if (typeof url === 'string' && url.length > 0) window.open(url, '_blank', 'noopener')
          },
          title: data?.dashboard?.reachable === true ? '在新标签打开独立看板' : '独立看板当前未运行',
        }, data?.dashboard?.reachable === true ? '打开看板' : '看板未运行'),
        h('button', { className: 'pecker-wb-btn', onClick: () => setShowSide((value) => !value) },
          showSide ? '收起信息' : '展开信息'))

      const conversationArea = conversation !== null && conversation !== undefined
        ? h('div', { className: 'pecker-wb-conversation' }, conversation)
        : h('div', { className: 'pecker-wb-empty' },
          h('div', { className: 'pecker-wb-title' }, '还没有属于本工作台的会话'),
          h('div', { className: 'pecker-wb-muted' }, '右侧信息与刷新不依赖会话；要用自然语言提需求时，先在侧栏新建一个会话。'),
          h('button', {
            className: 'pecker-wb-btn',
            onClick: () => {
              try {
                if (service?.newWorkspaceSession !== undefined) service.newWorkspaceSession()
                else if (service?.newSession !== undefined) service.newSession()
              } catch (err) {
                // 宿主校验失败（例如没有可用工作区）时不静默：交给宿主自己的提示。
                console.warn('pecker-dsh-workbench: 新建会话失败', err)
              }
            },
          }, '新建工作台会话'))

      return h('div', { className: `pecker-wb${showSide ? '' : ' pecker-wb-collapsed'}` },
        header,
        h('div', { className: 'pecker-wb-body' },
          conversationArea,
          showSide ? h(StatusPanel, { status: data, error, loading, reload }) : null))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: '本地创作',
        repository: 'https://github.com/peckerpro/pecker-dsh-workbench',
        description: '本地素材与创作工具的工作台：素材、作品版本、作业状态与创作能力进入 DSH 会话',
        panelTitle: '本地创作工具',
        icon: '🎬',
        audience: '本机单人使用',
        requirements: '平台 API（127.0.0.1:8765）在跑才能看到真实数据；未运行时如实显示未连接',
        category: '创作',
        customFrame: true,
        layout: { businessSide: 'right', businessWidth: 0.4 },
      }, Panel))
    }

    return { apply, inject: ['desktopWorkbenches'], Panel }
  },
})
