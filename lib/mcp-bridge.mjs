/**
 * 最小 MCP stdio 客户端（零依赖）。
 *
 * 为什么不用官方 SDK：工作台服务端入口跑在 Desktop 的 Harness 进程里，它的依赖解析只保证
 * 插件自己声明的包 + 宿主 @deepseek-ai/* 回退（resources/host-module-fallback.mjs）。
 * MCP 的 stdio 传输就是「每行一个 JSON-RPC 2.0 报文」，自己实现只有一百多行，
 * 换来零依赖、可独立测试、可精确控制超时与错误。
 *
 * 协议事实（本机实测）：平台侧 server 由官方 Python mcp SDK 1.26.0 提供，
 * 握手后 protocolVersion 为 2025-11-25，tools/list 返回 27 个工具。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export const DEFAULT_PROTOCOL_VERSION = '2025-11-25'
const STDERR_KEEP_LINES = 20

export class McpError extends Error {
  constructor(message, { code, data } = {}) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.data = data
  }
}

export class McpStdioClient {
  #child = null
  #rl = null
  #pending = new Map()
  #nextId = 1
  #closed = false
  #stderr = []

  constructor({
    command,
    args = [],
    env = {},
    cwd = undefined,
    connectTimeoutMs = 30_000,
    requestTimeoutMs = 60_000,
    clientName = 'pecker-dsh-workbench',
    clientVersion = '0.1.0',
  } = {}) {
    if (typeof command !== 'string' || command.length === 0) throw new TypeError('McpStdioClient: command is required')
    this.command = command
    this.args = [...args]
    this.env = { ...env }
    this.cwd = cwd
    this.connectTimeoutMs = connectTimeoutMs
    this.requestTimeoutMs = requestTimeoutMs
    this.clientName = clientName
    this.clientVersion = clientVersion
    this.serverInfo = null
    this.protocolVersion = null
  }

  get closed() {
    return this.#closed
  }

  get stderrTail() {
    return this.#stderr.join('\n')
  }

  /** 启动子进程并完成 initialize / initialized 握手。 */
  async connect() {
    if (this.#child !== null) throw new Error('McpStdioClient: already connected')
    this.#child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child.on('error', (error) => this.#failAll(new McpError(`MCP 启动失败：${error.message}`)))
    this.#child.on('exit', (code, signal) => {
      this.#closed = true
      this.#failAll(new McpError(`MCP 进程已退出（code=${String(code)} signal=${String(signal)}）`))
    })
    this.#rl = createInterface({ input: this.#child.stdout })
    this.#rl.on('line', (line) => this.#onLine(line))
    const errRl = createInterface({ input: this.#child.stderr })
    errRl.on('line', (line) => {
      this.#stderr.push(line)
      if (this.#stderr.length > STDERR_KEEP_LINES) this.#stderr.shift()
    })

    const result = await this.request(
      'initialize',
      {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      },
      this.connectTimeoutMs,
    )
    this.serverInfo = result?.serverInfo ?? null
    this.protocolVersion = result?.protocolVersion ?? null
    this.notify('notifications/initialized', {})
    return result
  }

  /** 发送带 id 的请求并等待同 id 响应。 */
  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.#closed) return Promise.reject(new McpError('MCP 连接已关闭'))
    const id = this.#nextId++
    const payload = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new McpError(`MCP 请求超时（${method}, ${timeoutMs}ms）`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#write(payload)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new McpError(String(error)))
      }
    })
  }

  /** 发送通知（无 id、无响应）。 */
  notify(method, params) {
    if (this.#closed) return
    this.#write({ jsonrpc: '2.0', method, params })
  }

  /** tools/list，自动翻页。 */
  async listTools() {
    const tools = []
    let cursor
    do {
      const response = await this.request('tools/list', cursor === undefined ? {} : { cursor })
      for (const tool of response?.tools ?? []) tools.push(tool)
      cursor = response?.nextCursor ?? undefined
    } while (cursor !== undefined)
    return tools
  }

  /** tools/call，返回原始 result（content / structuredContent / isError）。 */
  async callTool(name, args, timeoutMs = this.requestTimeoutMs) {
    return await this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs)
  }

  close() {
    this.#closed = true
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new McpError('MCP 连接被关闭'))
    }
    this.#pending.clear()
    try {
      this.#rl?.close()
    } catch {
      /* 关闭失败无关紧要 */
    }
    const child = this.#child
    this.#child = null
    if (child !== null && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        /* 进程可能已退出 */
      }
    }
  }

  #write(message) {
    const child = this.#child
    if (child?.stdin === null || child?.stdin === undefined) throw new McpError('MCP stdin 不可用')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #onLine(line) {
    const text = line.trim()
    if (text.length === 0) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      // 非 JSON 输出（某些 server 会往 stdout 打日志）忽略，保持 stderr 记录。
      this.#stderr.push(`[stdout] ${text.slice(0, 200)}`)
      if (this.#stderr.length > STDERR_KEEP_LINES) this.#stderr.shift()
      return
    }
    if (message.id === undefined || message.id === null) return // server 通知，V1 不需要
    const entry = this.#pending.get(message.id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.#pending.delete(message.id)
    if (message.error !== undefined) {
      entry.reject(new McpError(message.error?.message ?? `MCP 错误（${entry.method}）`, message.error ?? {}))
    } else {
      entry.resolve(message.result)
    }
  }

  #failAll(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#pending.clear()
  }
}
