/**
 * pecker-dsh-workbench —— 服务端入口。
 *
 * 职责（V1，只读）：
 *   1. 在自己的路由前缀 /api/pecker-dsh-workbench/ 下提供状态与配置读取；
 *   2. 把业务平台的 27 个 MCP 工具桥接成 Harness 原生工具（命名 workbench_<tool>），
 *      让 DSH 会话能用自然语言调用平台能力；
 *   3. 平台不可达时如实报告 unreachable，绝不返回假数据，也不阻塞 Desktop 启动。
 *
 * 不做（留给后续 Goal）：自动拉起 Python 平台、写业务数据、会话归属写入、看板托管。
 *
 * 契约依据：
 *   - dsh-desktop-workbenches 的《工作台开发规范》（随包离线副本 development-guide.zh.md）
 *   - @deepseek-ai/dsh-mcp-client 的真实工具桥接形状（parameters 用原始 JSON Schema）
 */
import Schema from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { McpStdioClient } from '../lib/mcp-bridge.mjs'
import { buildToolDefinitions } from '../lib/tool-defs.mjs'

export const name = 'pecker-dsh-workbench'
export const inject = ['connection']

export const Config = Schema.object({
  /** 插件自己的数据目录（V1 只记录，不写业务数据）。 */
  root: Schema.string().required(),
  /** 业务平台根目录（包含 platform/ 与 config/）。留空则平台相关能力全部标记为未配置。 */
  projectDir: Schema.string().default(''),
  /** 启动业务 MCP 用的 Python；留空则用 PATH 上的 python。 */
  python: Schema.string().default(''),
  /** 跑平台守护进程用的真 node；留空则自动解析（PATH → 自身 → Electron as node）。 */
  nodePath: Schema.string().default(''),
  /**
   * 是否允许插件**自动**拉起平台守护进程（/status 发现不可达时）。
   * 手动按钮（/platform/start|restart）不受此开关限制——那是用户明确的动作。
   * 测试里必须关掉：自动自愈会真的 spawn 进程，测试不该有这种副作用。
   */
  managePlatform: Schema.boolean().default(true),
  platformBaseUrl: Schema.string().default('http://127.0.0.1:8765'),
  dashboardUrl: Schema.string().default('http://127.0.0.1:5173'),
  /** 是否桥接平台工具（关掉只保留面板与状态读取）。 */
  bridge: Schema.boolean().default(true),
  requestTimeoutMs: Schema.number().default(60_000),
})

const PREFIX = '/api/pecker-dsh-workbench'
const PROBE_TIMEOUT_MS = 3_000
/** 看板（嵌入式产物）由本插件托管的路径。 */
const BOARD_PATH = `${PREFIX}/board.js`
/** 平台 API 的同源反代前缀：面板里的看板用它取数据（后端没有 CORS，必须同源）。 */
const PLATFORM_PREFIX = `${PREFIX}/platform`
/** 等 ctx.tools 就绪多久之后提醒一次（只提醒，不关连接、不放弃）。 */
const PENDING_WARN_MS = 30_000
/**
 * 平台自愈节流：面板每几秒就拉一次 /status，如果不节流就会不停 spawn 守护进程。
 *
 * 为什么插件要管平台生死（2026-10-15 真实故障）：
 *   平台 API/前端曾被一个控制台中断事件（cmd.exe 的 `^C`）打死，面板如实显示"未连接"，
 *   但用户没有办法在面板里把它拉起来。现在改成：/status 发现不可达 → 启动**无控制台**的守护进程
 *   （deploy/workbench-supervisor.mjs），由它负责把服务带起来并持续看护。
 *   守护进程是 detached 的，Desktop 重启不会带走它；即使被带走，下次插件加载又会补上。
 */
const ENSURE_THROTTLE_MS = 20_000

/**
 * 插件版本：**从 package.json 读**，不要手写。
 * 手写过一次 0.1.2，结果装的是 0.1.3 而 /status 自报 0.1.2 —— 自报版本必须只有一个真源。
 */
const PLUGIN_VERSION = (() => {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    return JSON.parse(raw).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

export function apply(ctx, config) {
  const projectDir = typeof config.projectDir === 'string' ? config.projectDir.trim() : ''
  const platformDir = projectDir === '' ? '' : join(projectDir, 'platform')
  const rootsFile = projectDir === '' ? '' : join(projectDir, 'config', 'roots.json')
  const python = (typeof config.python === 'string' && config.python.trim().length > 0 ? config.python.trim() : '') || 'python'
  const platformBaseUrl = config.platformBaseUrl.replace(/\/+$/, '')
  const dashboardUrl = config.dashboardUrl.replace(/\/+$/, '')
  const deployDir = projectDir === '' ? '' : join(projectDir, 'deploy')
  const runDir = projectDir === '' ? '' : join(projectDir, 'work', 'run')
  const supervisorScript = deployDir === '' ? '' : join(deployDir, 'workbench-supervisor.mjs')
  const supervisorStarter = deployDir === '' ? '' : join(deployDir, 'start-supervisor.mjs')
  const supervisorStateFile = runDir === '' ? '' : join(runDir, 'supervisor-state.json')
  const supervisorLogFile = runDir === '' ? '' : join(runDir, 'supervisor.log')

  /** 平台进程生命周期（自愈）的运行时状态，通过 /status 如实暴露。 */
  const lifecycle = {
    supervisorScript,
    supervisorScriptExists: supervisorScript !== '' && existsSync(supervisorScript),
    lastStartAt: null,
    lastStartResult: null,
    lastEnsureAt: null,
    lastEnsureReason: null,
    error: null,
  }
  let lastEnsureAtMs = 0

  const bridge = {
    // state 语义（0.1.2 起）：
    //   unconfigured / disabled   —— 没配置或关掉了
    //   idle                      —— 还没开始
    //   connecting                —— 正在连平台 MCP
    //   connected                 —— 平台连接已建立，但 ctx.tools 还没就绪（工具未注册）
    //   ready                     —— 工具已真正注册进 ctx.tools
    //   unavailable               —— 平台连接失败
    state: projectDir === '' || projectDir === undefined ? 'unconfigured' : config.bridge ? 'idle' : 'disabled',
    registered: false,
    registrationPending: false,
    toolCount: 0,
    toolNames: [],
    skipped: [],
    error: null,
    note: null,
    serverInfo: null,
    protocolVersion: null,
    connectedAt: null,
    registeredAt: null,
  }
  let client = null
  let registrationFiber = null
  let pendingTimer = null

  ctx.connection.fetch.register({
    path: `${PREFIX}/ping`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      return json({ ok: true, plugin: 'pecker-dsh-workbench' })
    },
  })

  ctx.connection.fetch.register({
    path: `${PREFIX}/config`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      return json({
        root: config.root,
        projectDir,
        platformDir,
        platformBaseUrl,
        dashboardUrl,
        python,
        bridgeEnabled: config.bridge,
        requestTimeoutMs: config.requestTimeoutMs,
        rootsFile,
        rootsFileExists: rootsFile !== '' && existsSync(rootsFile),
      })
    },
  })

  ctx.connection.fetch.register({
    path: `${PREFIX}/status`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      const [health, overview, jobs, dashboard] = await Promise.all([
        probeJson(`${platformBaseUrl}/api/health`),
        probeJson(`${platformBaseUrl}/api/overview`),
        probeJson(`${platformBaseUrl}/api/jobs?limit=5`, { retryWithoutQuery: `${platformBaseUrl}/api/jobs` }),
        probeHead(dashboardUrl),
      ])
      // 平台不可达就顺手自愈（有节流，不阻塞本次响应）。这样"重启 Desktop 后面板未连接"
      // 不需要用户做任何事：下一次轮询就会把守护进程拉起来。
      if (!health.ok && config.managePlatform) void ensurePlatform('status-unreachable')
      return json({
        plugin: {
          name: name,
          version: PLUGIN_VERSION,
          workbenchId: 'peckerpro/pecker-dsh-workbench',
          root: config.root,
        },
        config: { projectDir, platformBaseUrl, dashboardUrl, python, nodePath: config.nodePath },
        platform: {
          reachable: health.ok,
          error: health.ok ? null : health.error,
          url: platformBaseUrl,
          health: health.ok ? health.body : null,
          overview: overview.ok ? overview.body : null,
          overviewError: overview.ok ? null : overview.error,
          recentJobs: jobs.ok ? pickJobs(jobs.body) : [],
          jobsError: jobs.ok ? null : jobs.error,
          supervisor: supervisorInfo(),
        },
        dashboard: { url: dashboardUrl, reachable: dashboard.reachable, status: dashboard.status, error: dashboard.error },
        bridge: { ...bridge, toolNames: [...bridge.toolNames], skipped: [...bridge.skipped] },
        startCommands: buildStartCommands(python, projectDir),
        limitations: LIMITATIONS,
        checkedAt: new Date().toISOString(),
      })
    },
  })

  ctx.connection.fetch.register({
    path: `${PREFIX}/bridge/restart`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      // 手动重启必须是"真重启"：先注销旧工具、断开旧连接，再重连。
      await startBridge('manual-restart', { force: true })
      return json({ bridge: { ...bridge, toolNames: [...bridge.toolNames], skipped: [...bridge.skipped] } })
    },
  })

  // ---------------- 平台进程生命周期（自愈）----------------
  // 面板上的「启动平台 / 重启平台」按钮打这两个入口。它们只做一件事：
  // 以**无控制台、脱离本会话**的方式拉起 deploy/workbench-supervisor.mjs，
  // 由守护进程负责把 api/web 带起来并持续看护（重启 Desktop 也不会带走它）。
  ctx.connection.fetch.register({
    path: `${PREFIX}/platform/start`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      const result = await ensurePlatform('manual-start', { force: true })
      const health = await probeJson(`${platformBaseUrl}/api/health`)
      return json({
        action: 'start',
        result,
        reachable: health.ok,
        error: health.ok ? null : health.error,
        supervisor: supervisorInfo(),
      })
    },
  })

  ctx.connection.fetch.register({
    path: `${PREFIX}/platform/restart`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      // 先停（守护进程会随 --stop 一起退出），再重新拉起守护进程。
      const stopped = await stopSupervisor()
      const result = await ensurePlatform('manual-restart', { force: true })
      const health = await probeJson(`${platformBaseUrl}/api/health`)
      return json({
        action: 'restart',
        stopped,
        result,
        reachable: health.ok,
        error: health.ok ? null : health.error,
        supervisor: supervisorInfo(),
      })
    },
  })

  // ---------------- 看板托管 + 平台同源反代（V3）----------------
  // 面板里的看板跑在宿主渲染器里：它读不到插件包目录，也不该跨源直连平台
  // （平台后端**没有 CORS**）。所以服务端做两件事：
  //   1. 托管单文件看板产物 `lib/board.js`；
  //   2. 把 `/api/pecker-dsh-workbench/platform/*` 同源反代到平台 API，
  //      含 SSE 与 Range 的**流式透传**（视频拖动/事件流都靠它）。
  // 用 `webServer` 而不是 `connection.fetch`：后者只支持精确路径，这里需要**前缀**匹配
  // （@deepseek-ai/dsh-host-webserver 支持 exact/prefix，最长前缀优先）。
  let boardCache = null
  ctx.inject(['webServer'], (serverCtx) => {
    ctx.effect(() => serverCtx.webServer.register({
      kind: 'exact',
      path: BOARD_PATH,
      handler: (request, response) => serveBoard(request, response),
    }), 'pecker-dsh-workbench: board asset')
    ctx.effect(() => serverCtx.webServer.register({
      kind: 'prefix',
      path: PLATFORM_PREFIX,
      handler: (request, response) => {
        void proxyPlatform(request, response)
      },
    }), 'pecker-dsh-workbench: platform proxy')
    ctx.logger.info(`pecker-dsh-workbench: 已托管看板 ${BOARD_PATH}，反代前缀 ${PLATFORM_PREFIX}`)
  })

  /** 托管看板单文件产物（带 mtime 缓存，读不到就如实 404 并说明怎么生成）。 */
  function serveBoard(request, response) {
    const file = fileURLToPath(new URL('../lib/board.js', import.meta.url))
    try {
      const stat = statSync(file)
      if (boardCache === null || boardCache.mtimeMs !== stat.mtimeMs) {
        boardCache = { mtimeMs: stat.mtimeMs, body: readFileSync(file) }
      }
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': boardCache.body.length,
        'cache-control': 'no-store',
        'x-board-source': file,
      })
      response.end(boardCache.body)
    } catch (error) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({
        detail: `看板产物不存在：${file}`,
        hint: '先在 web/ 跑 pnpm build:embed，再在插件仓库跑 node scripts/sync-board.mjs',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  /**
   * 同源反代到平台 API。
   *
   * 关键点：
   * - 一律 `accept-encoding: identity`：避免 undici 透明解压与 content-length 不一致；
   * - **不设整体超时**：视频 Range 与 SSE 都是长连接，超时会把播放/事件流截断；
   * - 客户端断开时 `AbortController` 一路 abort 到上游（否则每次挂/卸面板都会漏一个 SSE）；
   * - 只透传安全头，丢掉 hop-by-hop。
   */
  async function proxyPlatform(request, response) {
    const raw = request.url ?? '/'
    const rest = raw.slice(PLATFORM_PREFIX.length) || '/'
    const target = new URL(rest.startsWith('/') ? rest : `/${rest}`, `${platformBaseUrl}/`)
    const headers = { ...request.headers }
    delete headers.host
    delete headers.connection
    delete headers['content-length']
    headers['accept-encoding'] = 'identity'
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const controller = new AbortController()
    // 客户端提前断开（关面板、切标签、视频 seek、SSE 取消）时别把上游留着。
    // 注意用 response 的 close 而不是 request 的：GET 的 request 流在请求体读完后就会 close，
    // 挂在那里会在响应还没写完时就把上游 abort 掉。只有在"响应没正常结束"时才 abort。
    response.on('close', () => {
      if (!response.writableEnded) {
        try {
          controller.abort()
        } catch {
          /* abort 本身失败无妨 */
        }
      }
    })
    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: hasBody ? request : undefined,
        duplex: hasBody ? 'half' : undefined,
        redirect: 'manual',
        signal: controller.signal,
      })
      const outHeaders = {}
      upstream.headers.forEach((value, key) => {
        const name = key.toLowerCase()
        if (name === 'connection' || name === 'keep-alive' || name === 'transfer-encoding' || name === 'upgrade') return
        outHeaders[name] = value
      })
      if (!response.headersSent) response.writeHead(upstream.status, outHeaders)
      if (upstream.body === null) {
        response.end()
        return
      }
      // 关键：上游被 abort（客户端断开）时，读流会 emit AbortError；
      // 不接住它就会变成 unhandled 'error' 并**打挂整个 harness 进程**。
      const body = Readable.fromWeb(upstream.body)
      body.on('error', () => {
        if (!response.writableEnded) response.destroy()
      })
      response.on('error', () => {
        body.destroy()
      })
      body.pipe(response)
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      // 客户端自己断开导致的 abort 不是错误，不该报 502。
      if (controller.signal.aborted) {
        response.destroy()
        return
      }
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({
        // 看板直接把这句显示给用户，所以这里写"怎么办"，而不是只有一句"反代失败"。
        // 2026-10-15 实际反馈：只显示「平台反代失败：/api/overview」时用户不知道发生了什么。
        detail: `平台 API（${platformBaseUrl}）当前不可达，读不到 ${target.pathname}${target.search}。`
          + '点面板上的「启动平台」即可拉起（由无控制台守护进程看护）；也可在状态栏展开看守护日志。',
        path: `${target.pathname}${target.search}`,
        upstream: platformBaseUrl,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  ctx.effect(() => () => {
    clearPendingWatchdog()
    try {
      registrationFiber?.dispose?.()
    } catch {
      /* 注销失败不影响卸载 */
    }
    registrationFiber = null
    client?.close()
    client = null
  }, 'pecker-dsh-workbench: bridge lifetime')

  async function startBridge(reason, { force = false } = {}) {
    if (projectDir === '' || !config.bridge) return
    if (bridge.state === 'connecting') return
    if ((bridge.state === 'ready' || bridge.state === 'connected') && !force) return
    if (force) {
      clearPendingWatchdog()
      try {
        registrationFiber?.dispose?.()
      } catch {
        /* 注销失败继续重连 */
      }
      registrationFiber = null
      client?.close()
      client = null
      bridge.registered = false
      bridge.registrationPending = false
      bridge.toolCount = 0
      bridge.toolNames = []
    }
    bridge.state = 'connecting'
    bridge.error = null
    bridge.note = null
    const next = new McpStdioClient({
      command: python,
      args: ['-m', 'workbench.mcp'],
      cwd: platformDir,
      env: {
        PYTHONPATH: platformDir,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        ...(rootsFile !== '' && existsSync(rootsFile) ? { WORKBENCH_ROOTS_FILE: rootsFile } : {}),
      },
      requestTimeoutMs: config.requestTimeoutMs,
    })
    try {
      await next.connect()
      const tools = await next.listTools()
      const { definitions, skipped } = buildToolDefinitions(tools, {
        call: (rawName, args, exec) => next.callTool(rawName, args, config.requestTimeoutMs).then((result) => {
          if (exec?.signal?.aborted) throw new Error(`工具 ${rawName} 被中止`)
          return result
        }),
      })
      const previous = client
      client = next
      previous?.close()
      bridge.state = 'connected'
      bridge.registered = false
      bridge.registrationPending = true
      bridge.skipped = skipped
      bridge.serverInfo = next.serverInfo
      bridge.protocolVersion = next.protocolVersion
      bridge.connectedAt = new Date().toISOString()

      // ctx.inject(deps, cb) 不是同步调用：cordis 把它当成一个**子插件**，deps 齐了才 apply
      // （registry.ts: inject() → plugin({ inject, apply })）。所以绝不能"同步没跑到"就判定
      // 服务不可用——0.1.1 就是这么误判的，还把平台连接关掉，结果 27 个工具一个都没注册上。
      // 正确做法：状态更新放进回调里，连接保持打开，等 ctx.tools 真正出现时再注册。
      registrationFiber = ctx.inject(['tools'], (toolCtx) => {
        const localDisposers = []
        toolCtx.effect(() => {
          for (const definition of definitions) {
            localDisposers.push(toolCtx.tools.register(definition))
          }
          bridge.state = 'ready'
          bridge.registered = true
          bridge.registrationPending = false
          bridge.toolCount = definitions.length
          bridge.toolNames = definitions.map((definition) => definition.name)
          bridge.registeredAt = new Date().toISOString()
          bridge.error = null
          bridge.note = null
          clearPendingWatchdog()
          ctx.logger.info(`pecker-dsh-workbench: 已注册 ${definitions.length} 个平台工具（${reason}）`)
          return () => {
            for (const dispose of localDisposers) {
              try {
                dispose()
              } catch {
                /* 单个注销失败不影响其余 */
              }
            }
            localDisposers.length = 0
            // 工具随服务一起消失：如实退回 pending，而不是继续报 ready。
            if (bridge.state === 'ready') {
              bridge.state = 'connected'
              bridge.registered = false
              bridge.registrationPending = true
              bridge.toolCount = 0
              bridge.toolNames = []
              bridge.note = 'ctx.tools 已不可用：工具已注销，等待服务再次就绪'
            }
          }
        }, `pecker-dsh-workbench: ${definitions.length} tools`)
      })

      // 等待 ctx.tools 的过程中不关连接；超时只记一条 warn（服务可能随后才出现）。
      pendingTimer = setTimeout(() => {
        if (bridge.registrationPending) {
          bridge.note = 'ctx.tools 尚未就绪：工具还没注册（连接保持打开，服务出现后会自动注册）'
          ctx.logger.warn('pecker-dsh-workbench: ctx.tools 尚未就绪，工具暂未注册（连接保持打开）')
        }
      }, PENDING_WARN_MS)
      if (typeof pendingTimer.unref === 'function') pendingTimer.unref()

      ctx.logger.info(`pecker-dsh-workbench: 已连接平台（${next.protocolVersion}），${definitions.length} 个工具等待 ctx.tools 就绪（${reason}）`)
    } catch (error) {
      next.close()
      bridge.state = 'unavailable'
      bridge.registered = false
      bridge.registrationPending = false
      bridge.toolCount = 0
      bridge.toolNames = []
      bridge.error = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`pecker-dsh-workbench: 平台 MCP 不可用，未注册任何工具（${reason}）：${bridge.error}`)
    }
  }

  /**
   * 解析"用哪个 node 去跑守护进程"。
   * 优先用户配置；然后 PATH 里的真 node；自己就是 node 就用自己的；
   * 都不行就回退 Electron + ELECTRON_RUN_AS_NODE=1（能跑，只是多一层壳）。
   */
  function resolveSupervisorNode() {
    const configured = typeof config.nodePath === 'string' ? config.nodePath.trim() : ''
    if (configured !== '' && existsSync(configured)) return { command: configured, env: {}, basis: 'config.nodePath' }
    if (/^node(\.exe)?$/i.test(process.execPath.split(/[\\/]/).pop() ?? '')) {
      return { command: process.execPath, env: {}, basis: 'self' }
    }
    for (const dir of String(process.env.PATH ?? '').split(';')) {
      const trimmed = dir.trim()
      if (trimmed === '') continue
      const candidate = join(trimmed, 'node.exe')
      try {
        if (existsSync(candidate)) return { command: candidate, env: {}, basis: `PATH:${trimmed}` }
      } catch {
        /* 不可读的 PATH 项跳过 */
      }
    }
    return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, basis: 'electron-as-node' }
  }

  function readTextTail(file, bytes) {
    if (file === '') return null
    try {
      const raw = readFileSync(file, 'utf8')
      return raw.length > bytes ? raw.slice(raw.length - bytes) : raw
    } catch {
      return null
    }
  }

  function readSupervisorState() {
    if (supervisorStateFile === '') return null
    try {
      return JSON.parse(readFileSync(supervisorStateFile, 'utf8'))
    } catch {
      return null
    }
  }

  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** 给面板看的守护进程事实：绝不猜，读不到就是读不到。 */
  function supervisorInfo() {
    const state = readSupervisorState()
    const pid = Number.isInteger(state?.supervisorPid) ? state.supervisorPid : null
    return {
      scriptExists: lifecycle.supervisorScriptExists,
      script: supervisorScript === '' ? null : supervisorScript,
      pid,
      alive: pid !== null && pidAlive(pid),
      stateFile: supervisorStateFile === '' ? null : supervisorStateFile,
      updatedAt: state?.updatedAt ?? null,
      children: Array.isArray(state?.children) ? state.children : [],
      logTail: readTextTail(supervisorLogFile, 2_000),
      lastStartAt: lifecycle.lastStartAt,
      lastStartResult: lifecycle.lastStartResult,
      lastEnsureAt: lifecycle.lastEnsureAt,
      lastEnsureReason: lifecycle.lastEnsureReason,
      error: lifecycle.error,
    }
  }

  function startSupervisor(reason) {
    if (supervisorStarter === '' || !existsSync(supervisorStarter)) {
      const error = `找不到守护进程启动器：${supervisorStarter === '' ? '(未配置 projectDir)' : supervisorStarter}`
      lifecycle.error = error
      return { started: false, error }
    }
    const node = resolveSupervisorNode()
    try {
      // detached + stdio ignore：没有控制台、不挂在 harness 的进程会话上。
      // 这是 2026-10-15 那次 `^C` 事故的直接对策。
      const child = spawn(node.command, [supervisorStarter], {
        cwd: projectDir,
        env: { ...process.env, ...node.env, WORKBENCH_NODE: node.command },
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      })
      child.unref()
      lifecycle.lastStartAt = new Date().toISOString()
      lifecycle.lastStartResult = `pid=${child.pid ?? '?'} node=${node.command} (${node.basis})`
      lifecycle.error = null
      ctx.logger.info(`pecker-dsh-workbench: 已启动平台守护进程（${reason}）${lifecycle.lastStartResult}`)
      return { started: true, pid: child.pid ?? null, node: node.command, nodeBasis: node.basis }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lifecycle.error = message
      ctx.logger.warn(`pecker-dsh-workbench: 启动平台守护进程失败（${reason}）：${message}`)
      return { started: false, error: message }
    }
  }

  /** 停掉守护进程（--stop 会连带停掉它记录的 api/web）。 */
  async function stopSupervisor() {
    if (supervisorScript === '' || !existsSync(supervisorScript)) return { stopped: false, error: '守护进程脚本不存在' }
    const node = resolveSupervisorNode()
    return await new Promise((resolve) => {
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let child
      try {
        child = spawn(node.command, [supervisorScript, '--stop'], {
          cwd: projectDir,
          env: { ...process.env, ...node.env, WORKBENCH_NODE: node.command },
          windowsHide: true,
          stdio: 'ignore',
        })
      } catch (error) {
        done({ stopped: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      child.on('exit', (code) => done({ stopped: true, exitCode: code }))
      child.on('error', (error) => done({ stopped: false, error: error.message }))
      setTimeout(() => done({ stopped: false, error: '停止超时（8s）' }), 8_000)
    })
  }

  /**
   * 保证平台在跑：守护进程不在（或强制）就拉起来。
   * 守护进程本身是幂等的（有 lock 文件），所以重复调用安全；这里再节流一次避免刷日志。
   */
  async function ensurePlatform(reason, { force = false } = {}) {
    if (projectDir === '') return { attempted: false, reason: '未配置 projectDir' }
    const info = supervisorInfo()
    if (info.alive && !force) return { attempted: false, reason: '守护进程已在运行', pid: info.pid }
    const now = Date.now()
    if (!force && now - lastEnsureAtMs < ENSURE_THROTTLE_MS) {
      return { attempted: false, reason: `节流中（${ENSURE_THROTTLE_MS}ms 内只尝试一次）` }
    }
    lastEnsureAtMs = now
    lifecycle.lastEnsureAt = new Date().toISOString()
    lifecycle.lastEnsureReason = reason
    const started = startSupervisor(reason)
    if (started.started) {
      // 等服务真起来再回报，面板下一次轮询就能看到"已连接"。
      await sleep(1_500)
    }
    return { attempted: true, reason, ...started }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function clearPendingWatchdog() {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
  }

  if (projectDir !== '' && config.bridge) {
    // 不 await：桥接失败不能阻塞 Desktop 启动。工具在握手完成后才出现。
    void startBridge('startup')
  }

  // 平台进程自愈与工具桥接是两件事：即使关掉桥接，面板也仍然要能看到真实数据，
  // 所以这里无条件保证守护进程在跑（不 await，不能拖慢 Desktop 启动）。
  if (projectDir !== '' && config.managePlatform) void ensurePlatform('plugin-load')

  ctx.logger.info(
    `pecker-dsh-workbench: 已加载（projectDir=${projectDir === '' ? '(未配置)' : projectDir}, 路由前缀 ${PREFIX}）`,
  )
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

async function probeJson(url, { retryWithoutQuery } = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) {
      if (retryWithoutQuery !== undefined) return await probeJson(retryWithoutQuery)
      return { ok: false, error: `${url} → HTTP ${response.status}` }
    }
    return { ok: true, body: await response.json() }
  } catch (error) {
    return { ok: false, error: `${url} → ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function probeHead(url) {
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return { reachable: response.ok, status: response.status, error: response.ok ? null : `HTTP ${response.status}` }
  } catch (error) {
    return { reachable: false, status: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function pickJobs(body) {
  const rows = Array.isArray(body) ? body : Array.isArray(body?.jobs) ? body.jobs : Array.isArray(body?.items) ? body.items : []
  return rows.slice(0, 5).map((row) => ({
    jobId: row?.job_id ?? row?.id ?? null,
    toolId: row?.tool_id ?? null,
    state: row?.state ?? null,
    createdAt: row?.created_at ?? null,
    finishedAt: row?.finished_at ?? null,
  }))
}

function buildStartCommands(python, projectDir) {
  if (projectDir === '') return []
  const platform = join(projectDir, 'platform')
  return [
    `cd ${platform}`,
    `${python} -m workbench.server --host 127.0.0.1 --port 8765`,
    `${python} -m workbench.jobs.worker --loop`,
    `cd ${join(projectDir, 'web')} && pnpm dev`,
  ]
}

/** 平台侧真实缺口（随平台进展更新，不许把已修好的继续写成缺）。 */
const LIMITATIONS = [
  'media.render 未登记 ToolRecord：渲染阶段不可执行',
  'tts.synthesize / tts.align 未登记：配音不可执行（缺火山凭证）',
  'huashu.storyboard_lint 已登记（分镜 lint 真跑）；huashu.canvas_render|visual_qa|film_gate|deliver 未登记：Huashu 后段阶段仍不可执行',
  'whiteboard.* 未登记：白板阶段不可执行',
  '人工审核只能由人在看板/面板里登记（agent 侧只能写 agent_audit，写不了 approved）：没有人工结论前门禁一律不允许交付',
  '已可执行（供参考）：media.probe / media.extract_clip / media.verify / media.extract_audio / media.burn_subtitle / asr.transcribe（离线，用本机已缓存模型）/ media.download（仅 plan）',
  '门禁已可求值：GET /api/versions/{id}/gate（红灯阻断交付、黄灯必须带理由、未知不算通过）',
  '平台进程由 deploy/workbench-supervisor.mjs 守护（无控制台、detached）；面板「启动/重启平台」与 /status 自愈都走它',
]
