/**
 * pecker-dsh-workbench —— 客户端入口（已构建的单文件模块）。
 *
 * 形态说明：本文件是手写的单文件模块，不含 JSX、不依赖打包器。工作台规范只要求
 * “已构建好的单文件模块”并通过 window.__ModuleLoader__.load 注册；不用 JSX/构建链
 * 是刻意的选择，少一个会出错的环节。（看板本身是另一个构建产物 `lib/board.js`，
 * 由本插件服务端托管在 `/api/pecker-dsh-workbench/board.js`，面板挂载时注入。）
 *
 * customFrame: 宿主把原生会话节点作为 conversation prop 交给本面板，面板必须把它
 * 放进自己的布局，不得再建一套聊天界面。
 *
 * V3 布局：左边**看板**（嵌入式产物，Shadow DOM 隔离 + 同源反代取数），
 * 右边一列：原生会话（上）+ 只读状态（下）。看板加载失败时右边仍显示真实状态与失败原因。
 */
window.__ModuleLoader__.load({
  id: 'pecker-dsh-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/pecker-dsh-workbench'
    const BOARD_URL = `${API}/board.js`
    const PLATFORM_PREFIX = `${API}/platform`
    const POLL_MS = 15_000
    //: 对话区宽度（px）：默认 520，可拖到最小 320 / 面板宽度 80%，双击复位；按本机记忆。
    const RIGHT_WIDTH_KEY = 'pecker-dsh-workbench.right-width'
    const DEFAULT_RIGHT_WIDTH = 520
    const MIN_RIGHT_WIDTH = 320
    let stylesDone = false
    let boardPromise = null

    const CSS = `
.pecker-wb { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0;
  font-size: 13px; line-height: 1.5; color: var(--dsh-text, currentColor); }
.pecker-wb-header { display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  border-bottom: 1px solid var(--dsh-border, rgba(128,128,128,.28)); flex: 0 0 auto; }
.pecker-wb-title { font-weight: 600; }
.pecker-wb-spacer { flex: 1 1 auto; }
.pecker-wb-btn { border: 1px solid var(--dsh-border, rgba(128,128,128,.35)); background: transparent;
  color: inherit; border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
.pecker-wb-btn:hover { background: rgba(128,128,128,.12); }
.pecker-wb-btn[disabled] { opacity: .5; cursor: default; }
.pecker-wb-body { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }
.pecker-wb-board { flex: 1 1 auto; min-width: 0; min-height: 0; position: relative; }
.pecker-wb-board-empty { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; padding: 24px; text-align: center; }
/* 拖拽分隔条：宽度可调（0.1.7 起），双击复位。 */
.pecker-wb-split { flex: 0 0 6px; cursor: col-resize; background: transparent; position: relative; }
.pecker-wb-split::after { content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 2px;
  background: var(--dsh-border, rgba(128,128,128,.28)); }
.pecker-wb-split:hover::after, .pecker-wb-split--active::after { background: #7c3aed; }
.pecker-wb-right { flex: 0 0 auto; display: flex; flex-direction: column;
  border-left: 1px solid var(--dsh-border, rgba(128,128,128,.28));
  min-width: 0; min-height: 0; overflow: hidden; }
.pecker-wb-collapsed .pecker-wb-right { display: none; }
/* 关键：min-width/min-height 必须为 0 —— 否则宿主的对话节点（尤其是带选项按钮的问题卡）
   会拒绝收缩，横向溢出、内容看不全。 */
.pecker-wb-conversation { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex;
  flex-direction: column; overflow: hidden; }
.pecker-wb-conversation > * { min-width: 0; }
.pecker-wb-side { flex: 0 0 auto; min-width: 0; display: flex; flex-direction: column;
  gap: 10px; padding: 10px 12px; border-top: 1px solid var(--dsh-border, rgba(128,128,128,.28));
  overflow: auto; }
/* 状态区默认收起成一行，把高度让给对话（实际使用反馈：对话被状态区挤压）。 */
.pecker-wb-side--collapsed { max-height: 4.4em; overflow: hidden; padding: 6px 12px; gap: 4px; }
.pecker-wb-side--open { max-height: 52%; }
.pecker-wb-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: 0 0 auto; }
.pecker-wb-dot--ok { background: #16a34a; }
.pecker-wb-dot--bad { background: #dc2626; }
.pecker-wb-dot--warn { background: #d97706; }
.pecker-wb-state { font-size: 12px; opacity: .85; }
.pecker-wb-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
.pecker-wb-card { border: 1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius: 8px; padding: 6px 8px; min-width: 0; }
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
.pecker-wb-bad { border-color: rgba(220,38,38,.5); background: rgba(220,38,38,.08); }
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

    /** 注入看板产物脚本（只注入一次；重复挂载复用同一个 promise）。 */
    function loadBoardBundle() {
      if (boardPromise !== null) return boardPromise
      boardPromise = new Promise((resolve, reject) => {
        if (typeof window !== 'undefined' && typeof window.PeckerBoard?.mountBoard === 'function') {
          resolve()
          return
        }
        const script = document.createElement('script')
        script.src = BOARD_URL
        script.async = true
        script.onload = () => resolve()
        script.onerror = () => reject(new Error(`看板产物加载失败：${BOARD_URL}（插件是否缺少 lib/board.js？）`))
        document.head.appendChild(script)
      })
      return boardPromise
    }

    async function getJson(path) {
      const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
      return await response.json()
    }

    /**
     * 平台启动/重启。
     *
     * 走插件自己的端点（见 dsh/index.js）：它用**无控制台、脱离会话**的方式拉起
     * deploy/workbench-supervisor.mjs，由守护进程把 api/web 带起来并持续看护。
     * 之所以要有这个按钮：2026-10-15 那次平台被控制台中断信号打死后面板只能显示"未连接"，
     * 用户没有任何办法在面板里恢复它。
     */
    function usePlatformLifecycle(reload) {
      const [state, setState] = React.useState({ pending: null, error: null, result: null })
      const run = React.useCallback(async (action) => {
        setState({ pending: action, error: null, result: null })
        try {
          const response = await fetch(`${API}/platform/${action}`, { method: 'POST' })
          const body = await response.json().catch(() => null)
          if (!response.ok) throw new Error(`${action} → HTTP ${response.status}`)
          setState({ pending: null, error: null, result: body })
          await reload()
          return body
        } catch (error) {
          setState({ pending: null, error: error instanceof Error ? error.message : String(error), result: null })
          return null
        }
      }, [reload])
      return {
        pending: state.pending,
        error: state.error,
        result: state.result,
        start: () => run('start'),
        restart: () => run('restart'),
      }
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

    /** 只读状态内容（放进右侧栏下段；看板打不开时这里是唯一可信来源）。 */
    function StatusContent({ status, error, loading, reload, lifecycle }) {
      const platform = status?.platform
      const supervisor = platform?.supervisor
      const counts = platform?.overview?.counts
      const reachable = platform?.reachable === true
      const bridge = status?.bridge
      const bridgeTone = bridge?.state === 'ready' ? 'ok' : bridge?.state === 'unavailable' ? 'bad' : 'warn'
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

      return h(React.Fragment, null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: `pecker-wb-dot ${reachable ? 'pecker-wb-dot--ok' : 'pecker-wb-dot--bad'}` }),
          h('span', { className: 'pecker-wb-state' }, reachable ? '平台已连接' : '平台未连接'),
          h('span', { className: 'pecker-wb-spacer' }),
          h('span', { className: `pecker-wb-dot pecker-wb-dot--${bridgeTone}` }),
          h('span', { className: 'pecker-wb-state' }, bridgeLabel)),
        bridge?.note ? h('div', { className: 'pecker-wb-muted' }, bridge.note) : null,
        error !== null && error !== undefined
          ? h('div', { className: 'pecker-wb-muted' }, `读取插件状态失败：${error}`)
          : null,
        // 平台没在跑时给的是"怎么办"，不是一串原始报错：看板与面板都靠平台 API，
        // 平台进程死了它们只能如实失败，所以这里必须能一键恢复。
        reachable ? null : h('div', { className: 'pecker-wb-note pecker-wb-bad' },
          h('strong', null, '平台没在运行'),
          h('div', { style: { marginTop: 4 } },
            '看板与状态都读自平台 API（127.0.0.1:8765），它现在不可达，所以数据读不出来——这不是数据为空，也不是出错。'),
          h('div', { className: 'pecker-wb-muted', style: { marginTop: 4 } },
            supervisor?.alive === true
              ? `守护进程在跑（pid ${supervisor.pid}），它每 2 秒看护一次，稍等即会恢复。`
              : supervisor?.scriptExists === true
                ? '守护进程当前不在运行；面板每 20 秒会自动尝试拉起一次，也可以点下面的按钮立刻启动。'
                : '这台机器上没找到 deploy/workbench-supervisor.mjs，需要手动启动平台（见下方命令）。'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h('button', {
              className: 'pecker-wb-btn',
              disabled: lifecycle?.pending !== null,
              onClick: () => void lifecycle?.start(),
            }, lifecycle?.pending === 'start' ? '启动中…' : '启动平台'),
            h('button', {
              className: 'pecker-wb-btn',
              disabled: lifecycle?.pending !== null,
              onClick: () => void lifecycle?.restart(),
            }, lifecycle?.pending === 'restart' ? '重启中…' : '重启平台'),
            h('button', { className: 'pecker-wb-btn', disabled: loading === true, onClick: () => void reload() }, '刷新状态')),
          lifecycle?.error ? h('div', { className: 'pecker-wb-muted', style: { marginTop: 4 } }, `上次操作失败：${lifecycle.error}`) : null,
          platform?.error ? h('div', { className: 'pecker-wb-muted', style: { marginTop: 4 } }, `原始错误：${platform.error}`) : null),

        supervisor === null || supervisor === undefined ? null : h('details', null,
          h('summary', { className: 'pecker-wb-muted' }, `平台进程守护（${supervisor.alive === true ? `运行中 pid ${supervisor.pid}` : '未运行'}）`),
          h('pre', { className: 'pecker-wb-pre' }, supervisor.logTail ?? '（还没有守护日志）')),

        h('div', { className: 'pecker-wb-section-title' }, '平台计数'),
        h('div', { className: 'pecker-wb-cards' },
          Metric('素材', countOf(counts, 'asset')),
          Metric('作品版本', countOf(counts, 'version')),
          Metric('作业', countOf(counts, 'job')),
          Metric('待人工审核', reviewPending),
          Metric('导入问题', countOf(counts, 'issue')),
          Metric('已登记工具', countOf(counts, 'tool'))),

        h('div', { className: 'pecker-wb-section-title' }, '作业状态'),
        h('div', { className: 'pecker-wb-cards' },
          Metric('排队', stateCount(platform?.overview?.jobs_by_state, 'state', 'queued')),
          Metric('运行中', stateCount(platform?.overview?.jobs_by_state, 'state', 'running')),
          Metric('成功', stateCount(platform?.overview?.jobs_by_state, 'state', 'succeeded')),
          Metric('失败', stateCount(platform?.overview?.jobs_by_state, 'state', 'failed'))),

        h('div', { className: 'pecker-wb-section-title' }, '最近作业'),
        recent.length === 0
          ? h('div', { className: 'pecker-wb-muted' }, reachable ? '没有作业记录' : '未知')
          : h('ul', { className: 'pecker-wb-list' },
            recent.slice(0, 4).map((job) => h('li', { key: job.jobId ?? `${job.toolId}-${job.createdAt}` },
              h('span', { className: 'pecker-wb-mono', style: { flex: '0 0 46%' } }, job.toolId ?? '未知'),
              h('span', { className: 'pecker-wb-muted' }, job.state ?? '未知'),
              h('span', { className: 'pecker-wb-spacer' }),
              h('span', { className: 'pecker-wb-mono' }, job.createdAt ?? '')))),

        h('div', { className: 'pecker-wb-note' },
          h('strong', null, '当前不可用（如实标注，不做替代）'),
          h('ul', null, (status?.limitations ?? []).map((line, index) => h('li', { key: index }, line)))),

        (status?.startCommands ?? []).length === 0 ? null : h('details', null,
          h('summary', { className: 'pecker-wb-muted' }, '平台没在跑？点开启动命令'),
          h('pre', { className: 'pecker-wb-pre' }, (status?.startCommands ?? []).join('\n'))),

        h('div', { className: 'pecker-wb-muted' },
          `工作台身份 peckerpro/pecker-dsh-workbench · 插件 v${status?.plugin?.version ?? '-'}`))
    }

    function Panel(props) {
      ensureStyles()
      const { service, conversation } = props
      const { loading, data, error, reload } = useStatus()
      const lifecycle = usePlatformLifecycle(reload)
      const [showRight, setShowRight] = React.useState(true)
      const [boardState, setBoardState] = React.useState('loading')
      const [boardError, setBoardError] = React.useState(null)
      const boardHost = React.useRef(null)
      const board = React.useRef(null)

      React.useEffect(() => {
        let cancelled = false
        const host = boardHost.current
        if (host === null) return undefined
        loadBoardBundle()
          .then(() => {
            if (cancelled) return
            if (typeof window.PeckerBoard?.mountBoard !== 'function') throw new Error('看板产物没有导出 mountBoard')
            board.current = window.PeckerBoard.mountBoard(host, { apiBase: PLATFORM_PREFIX })
            setBoardState('ready')
          })
          .catch((err) => {
            if (cancelled) return
            setBoardState('failed')
            setBoardError(err instanceof Error ? err.message : String(err))
          })
        return () => {
          cancelled = true
          try {
            board.current?.unmount()
          } catch {
            /* 卸载失败不影响宿主 */
          }
          board.current = null
        }
      }, [])

      const platformOk = data?.platform?.reachable === true

      // ---- 宽度可调 + 布局开关（0.1.7）----
      // 宿主把原生会话节点交给我们（customFrame），**布局完全由我们负责**：所以"对话区不能
      // 调大小 / 问题卡被挤到看不全"是这里的固定宽度与最小宽高造成的，不是 harness 写死的。
      const rootRef = React.useRef(null)
      const [rightWidth, setRightWidth] = React.useState(() => {
        try {
          const saved = Number(window.localStorage?.getItem(RIGHT_WIDTH_KEY))
          return Number.isFinite(saved) && saved >= MIN_RIGHT_WIDTH ? saved : DEFAULT_RIGHT_WIDTH
        } catch {
          return DEFAULT_RIGHT_WIDTH
        }
      })
      const [resizing, setResizing] = React.useState(false)
      const [boardHidden, setBoardHidden] = React.useState(false)
      const [statusOpen, setStatusOpen] = React.useState(false)

      const clampWidth = React.useCallback((width) => {
        const total = rootRef.current?.getBoundingClientRect().width ?? 1200
        const max = Math.max(MIN_RIGHT_WIDTH, Math.min(width, Math.round(total * 0.8)))
        return Math.max(MIN_RIGHT_WIDTH, Math.min(width, max))
      }, [])

      React.useEffect(() => {
        if (!resizing) return undefined
        const onMove = (event) => {
          const rect = rootRef.current?.getBoundingClientRect()
          if (!rect) return
          setRightWidth(clampWidth(Math.round(rect.right - event.clientX)))
        }
        const onUp = () => setResizing(false)
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [resizing, clampWidth])

      React.useEffect(() => {
        try {
          window.localStorage?.setItem(RIGHT_WIDTH_KEY, String(rightWidth))
        } catch {
          /* 存不下就只在本次会话里生效 */
        }
      }, [rightWidth])

      const header = h('div', { className: 'pecker-wb-header' },
        h('span', { className: 'pecker-wb-title' }, '本地创作'),
        h('span', { className: `pecker-wb-dot ${platformOk ? 'pecker-wb-dot--ok' : 'pecker-wb-dot--bad'}` }),
        h('span', { className: 'pecker-wb-state' }, platformOk ? '已连接' : '未连接'),
        h('span', { className: 'pecker-wb-spacer' }),
        // 平台生命周期按钮：未连接时给「启动平台」，已连接时给「重启平台」。
        // 这里刻意不隐藏失败/等待态，避免"点了没反应"的观感。
        platformOk
          ? h('button', {
            className: 'pecker-wb-btn',
            disabled: lifecycle.pending !== null,
            onClick: () => void lifecycle.restart(),
            title: '停掉再重新拉起平台 API 与看板（无控制台守护进程）',
          }, lifecycle.pending === 'restart' ? '重启中…' : '重启平台')
          : h('button', {
            className: 'pecker-wb-btn',
            disabled: lifecycle.pending !== null,
            onClick: () => void lifecycle.start(),
            title: '启动平台 API 与看板（无控制台守护进程，脱离本会话）',
          }, lifecycle.pending === 'start' ? '启动中…' : '启动平台'),
        h('button', {
          className: 'pecker-wb-btn',
          onClick: () => {
            const url = data?.dashboard?.url
            if (typeof url === 'string' && url.length > 0) window.open(url, '_blank', 'noopener')
          },
          title: data?.dashboard?.reachable === true ? '在新标签打开独立看板' : '独立看板当前未运行',
        }, data?.dashboard?.reachable === true ? '打开独立看板' : '独立看板未运行'),
        h('button', { className: 'pecker-wb-btn', onClick: () => void reload(), disabled: loading === true },
          loading ? '刷新中…' : '刷新状态'),
        // 会话归属：宿主会在"当前活动会话"里沿用会话（见 initialization 注释），
        // 所以必须给一个显式的"选项目文件夹 → 新建属于本工作台的会话"入口。
        // 没有它的时候，面板会显示别的项目（例如素材目录）下的会话，用户会以为"工作台里就是本地创作"。
        h('button', {
          className: 'pecker-wb-btn',
          title: '选择一个项目文件夹，并在其中新建一个属于「本地创作」的会话（宿主会把它绑定到本工作台）',
          onClick: () => {
            try {
              if (service?.newWorkspaceSession !== undefined) void service.newWorkspaceSession()
              else if (service?.newSession !== undefined) void service.newSession()
            } catch (err) {
              console.warn('pecker-dsh-workbench: 新建创作会话失败', err)
            }
          },
        }, '新建创作会话'),
        h('button', {
          className: 'pecker-wb-btn',
          onClick: () => setBoardHidden((value) => !value),
          title: '把整个面板让给对话（问题卡较长时用）',
        }, boardHidden ? '显示看板' : '对话占满'),
        h('button', { className: 'pecker-wb-btn', onClick: () => setShowRight((value) => !value) },
          showRight ? '收起侧栏' : '展开侧栏'))

      const boardArea = h('div', { className: 'pecker-wb-board', ref: boardHost },
        boardState === 'failed'
          ? h('div', { className: 'pecker-wb-board-empty' },
            h('div', null,
              h('div', { className: 'pecker-wb-note pecker-wb-bad' },
                h('strong', null, '看板没加载起来'),
                h('div', { style: { marginTop: 4 } }, boardError ?? '未知原因'),
                h('div', { className: 'pecker-wb-muted', style: { marginTop: 4 } },
                  '右侧状态栏仍显示平台的真实状态；修复后可点"刷新状态"或重开面板。'))))
          : null)

      const conversationArea = conversation !== null && conversation !== undefined
        ? h('div', { className: 'pecker-wb-conversation' }, conversation)
        : h('div', { className: 'pecker-wb-empty' },
          h('div', { className: 'pecker-wb-title' }, '还没有属于本工作台的会话'),
          h('div', { className: 'pecker-wb-muted' }, '看板与状态不依赖会话；要用自然语言提需求时，先新建一个工作台会话。'),
          h('button', {
            className: 'pecker-wb-btn',
            onClick: () => {
              try {
                if (service?.newWorkspaceSession !== undefined) service.newWorkspaceSession()
                else if (service?.newSession !== undefined) service.newSession()
              } catch (err) {
                console.warn('pecker-dsh-workbench: 新建会话失败', err)
              }
            },
          }, '新建创作会话（选项目文件夹）'))

      const statusStrip = h('div', {
        className: `pecker-wb-side${statusOpen ? ' pecker-wb-side--open' : ' pecker-wb-side--collapsed'}`,
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: `pecker-wb-dot ${platformOk ? 'pecker-wb-dot--ok' : 'pecker-wb-dot--bad'}` }),
          h('span', { className: 'pecker-wb-state' },
            platformOk
              ? `平台已连接 · 工具 ${data?.bridge?.toolCount ?? '?'} 个 · 素材 ${data?.platform?.overview?.counts?.asset ?? '?'}`
              : '平台未连接'),
          h('span', { className: 'pecker-wb-spacer' }),
          // 收起状态下也要能一键恢复：平台挂了的时候，多展开一步都是多余的。
          platformOk ? null : h('button', {
            className: 'pecker-wb-btn',
            disabled: lifecycle.pending !== null,
            onClick: () => void lifecycle.start(),
          }, lifecycle.pending === 'start' ? '启动中…' : '启动平台'),
          h('button', { className: 'pecker-wb-btn', onClick: () => setStatusOpen((value) => !value) },
            statusOpen ? '收起状态' : '展开状态')),
        statusOpen ? h(StatusContent, { status: data, error, loading, reload, lifecycle }) : null)

      const rightColumn = h('div', {
        className: 'pecker-wb-right',
        style: boardHidden ? { flex: '1 1 auto' } : { flex: `0 0 ${rightWidth}px` },
      },
        conversationArea,
        statusStrip)

      const splitter = boardHidden ? null : h('div', {
        className: `pecker-wb-split${resizing ? ' pecker-wb-split--active' : ''}`,
        role: 'separator',
        'aria-orientation': 'vertical',
        title: '拖动调整对话区宽度（双击复位）',
        onPointerDown: (event) => {
          event.preventDefault()
          setResizing(true)
        },
        onDoubleClick: () => setRightWidth(clampWidth(DEFAULT_RIGHT_WIDTH)),
      })

      return h('div', { className: `pecker-wb${showRight ? '' : ' pecker-wb-collapsed'}`, ref: rootRef },
        header,
        h('div', { className: 'pecker-wb-body' },
          boardHidden ? null : boardArea,
          splitter,
          showRight ? rightColumn : null))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: '本地创作',
        repository: 'https://github.com/peckerpro/pecker-dsh-workbench',
        description: '本地素材与创作工具的工作台：素材、作品版本、作业状态与创作能力进入 DSH 会话',
        panelTitle: '本地创作工具',
        icon: '🎬',
        audience: '本机单人使用',
        requirements: '平台 API（127.0.0.1:8765）在跑才能看到真实数据；未运行时如实显示未连接，并可一键启动（无控制台守护进程）',
        category: '创作',
        customFrame: true,
        layout: { businessSide: 'right', businessWidth: 0.4 },
        // 宿主 `open(id)` 的取会话顺序（work/asar-out/client.js:781-790）：
        //   target = sessionId || recentSessions[id]
        //   有 target 且 sessionBindings[target] === id → 打开那个会话
        //   否则若 initialization === 'new-session' 且有默认工作区 → 新建会话
        // 不写这一条时的真实后果（2026-10-15 实测）：面板会**沿用当前活动会话**，
        // 于是「本地创作」绑到了一个 cwd 为 D:\project\素材 的哔哩哔哩批量下载会话，
        // 面板里显示的对话根本不是创作会话。
        // 注意：宿主没有"指定 cwd"的字段，工作台会话落在**用户为该工作台选的工作区**里
        // （在侧栏选文件夹 / 「在此工作区新建会话」）。
        initialization: 'new-session',
      }, Panel))
    }

    return { apply, inject: ['desktopWorkbenches'], Panel }
  },
})
