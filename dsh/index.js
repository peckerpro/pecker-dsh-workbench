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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
  platformBaseUrl: Schema.string().default('http://127.0.0.1:8765'),
  dashboardUrl: Schema.string().default('http://127.0.0.1:5173'),
  /** 是否桥接平台工具（关掉只保留面板与状态读取）。 */
  bridge: Schema.boolean().default(true),
  requestTimeoutMs: Schema.number().default(60_000),
})

const PREFIX = '/api/pecker-dsh-workbench'
const PROBE_TIMEOUT_MS = 3_000

export function apply(ctx, config) {
  const projectDir = typeof config.projectDir === 'string' ? config.projectDir.trim() : ''
  const platformDir = projectDir === '' ? '' : join(projectDir, 'platform')
  const rootsFile = projectDir === '' ? '' : join(projectDir, 'config', 'roots.json')
  const python = (typeof config.python === 'string' && config.python.trim().length > 0 ? config.python.trim() : '') || 'python'
  const platformBaseUrl = config.platformBaseUrl.replace(/\/+$/, '')
  const dashboardUrl = config.dashboardUrl.replace(/\/+$/, '')

  const bridge = {
    state: projectDir === '' || projectDir === undefined ? 'unconfigured' : config.bridge ? 'idle' : 'disabled',
    registered: false,
    toolCount: 0,
    toolNames: [],
    skipped: [],
    error: null,
    serverInfo: null,
    protocolVersion: null,
    startedAt: null,
  }
  let client = null
  let disposers = []

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
      return json({
        plugin: {
          name: name,
          version: '0.1.1',
          workbenchId: 'peckerpro/pecker-dsh-workbench',
          root: config.root,
        },
        config: { projectDir, platformBaseUrl, dashboardUrl, python },
        platform: {
          reachable: health.ok,
          error: health.ok ? null : health.error,
          url: platformBaseUrl,
          health: health.ok ? health.body : null,
          overview: overview.ok ? overview.body : null,
          overviewError: overview.ok ? null : overview.error,
          recentJobs: jobs.ok ? pickJobs(jobs.body) : [],
          jobsError: jobs.ok ? null : jobs.error,
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

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 注销失败不影响卸载 */
      }
    }
    disposers = []
    client?.close()
    client = null
  }, 'pecker-dsh-workbench: bridge lifetime')

  async function startBridge(reason, { force = false } = {}) {
    if (projectDir === '' || !config.bridge) return
    if (bridge.state === 'connecting') return
    if (bridge.state === 'ready' && !force) return
    if (force) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 注销失败继续重连 */
        }
      }
      disposers = []
      client?.close()
      client = null
      bridge.registered = false
    }
    bridge.state = 'connecting'
    bridge.error = null
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
      // 先构建、后注册：注册必须在 tools 服务就绪时同步完成。
      // 用 registered 标记区分「真的注册过」与「tools 服务没就绪」——不能只因为握手成功就报 ready。
      let registered = false
      ctx.inject(['tools'], (toolCtx) => {
        for (const definition of definitions) {
          disposers.push(toolCtx.effect(
            () => toolCtx.tools.register(definition),
            `pecker-dsh-workbench: tool ${definition.name}`,
          ))
        }
        registered = true
      })
      if (!registered) {
        next.close()
        bridge.state = 'tools-service-unavailable'
        bridge.registered = false
        bridge.toolCount = 0
        bridge.toolNames = []
        bridge.error = 'ctx.tools 服务不可用：工具没有注册（平台连接本身正常）'
        ctx.logger.warn('pecker-dsh-workbench: ctx.tools 不可用，27 个工具未注册')
        return
      }
      client?.close()
      client = next
      bridge.state = 'ready'
      bridge.registered = true
      bridge.toolCount = definitions.length
      bridge.toolNames = definitions.map((definition) => definition.name)
      bridge.skipped = skipped
      bridge.serverInfo = next.serverInfo
      bridge.protocolVersion = next.protocolVersion
      bridge.startedAt = new Date().toISOString()
      ctx.logger.info(`pecker-dsh-workbench: 已注册 ${definitions.length} 个平台工具（${reason}）`)
    } catch (error) {
      next.close()
      bridge.state = 'unavailable'
      bridge.registered = false
      bridge.toolCount = 0
      bridge.toolNames = []
      bridge.error = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`pecker-dsh-workbench: 平台 MCP 不可用，未注册任何工具（${reason}）：${bridge.error}`)
    }
  }

  if (projectDir !== '' && config.bridge) {
    // 不 await：桥接失败不能阻塞 Desktop 启动。工具在握手完成后才出现。
    void startBridge('startup')
  }

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

/** 本轮审计核实过的事实：这些 stage 在平台里没有登记，不能假装可用。 */
const LIMITATIONS = [
  'media.render / media.burn_subtitle 未登记 ToolRecord：渲染与字幕阶段不可执行',
  'asr.transcribe / tts.synthesize / tts.align 未登记：ASR 与配音不可执行',
  'whiteboard.* / huashu.canvas_render|visual_qa|film_gate|deliver 未登记：白板与 Huashu 阶段不可执行',
  '平台侧没有 gate 求值实现：红灯/黄灯目前只是 recipe 里的字符串标签',
  '人工审核 0 条：39 个版本仍全部是 awaiting_review',
]
