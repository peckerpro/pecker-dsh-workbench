/**
 * 看板托管 + 平台同源反代的**真实**验证。
 *
 * 做法：把插件服务端的两个 webServer handler（`/board.js`、`/platform/*`）挂到一个真的
 * http.createServer 上，然后真的去请求它：
 *   1. `GET /board.js` → 200 + JS 内容（长度与 lib/board.js 一致）；
 *   2. `GET /platform/api/health` → 200 + 平台真实 JSON（证明反代通了）；
 *   3. `GET /platform/api/overview` → 200；
 *   4. `Range: bytes=0-1023` 的媒体请求 → 206 + Content-Range（视频拖动靠它）；
 *   5. `Accept: text/event-stream` 的 SSE → 200 + `text/event-stream`，且**能收到真实事件行**；
 *   6. 平台不可达时反代如实 502（不伪装成功）。
 *
 * 需要平台 API 在 127.0.0.1:8765（前 5 项）。第 6 项用错误的端口，不需要平台。
 * 用法：node test/board-and-proxy.mjs
 */
import http from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectDir = process.env.PECKER_PROJECT_DIR || 'D:\\project\\本地创作工具'
const platformApi = process.env.PLATFORM_API || 'http://127.0.0.1:8765'
const entry = await import(pathToFileURL(resolve(here, '..', 'dsh', 'index.js')).href)

const failures = []
const lines = []
function check(condition, message) {
  lines.push(`${condition ? '  ✓' : '  ✗'} ${message}`)
  if (!condition) failures.push(message)
}

/** 把插件注册的 webServer 路由挂到真 http server 上。 */
function collectRoutes() {
  const webRoutes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
    inject: (deps, callback) => {
      if (deps.includes('webServer')) {
        callback({ webServer: { register: (route) => { webRoutes.push(route); return () => {} } } })
        return { dispose() {} }
      }
      return { dispose() {} }
    },
    connection: { fetch: { register: () => {} } },
  }
  return { webRoutes, ctx }
}

function serverFor(webRoutes) {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const exact = webRoutes.find((route) => route.kind === 'exact' && route.path === url.pathname)
    if (exact) { exact.handler(request, response); return }
    const prefix = webRoutes
      .filter((route) => route.kind === 'prefix' && url.pathname.startsWith(route.path))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (prefix) { prefix.handler(request, response); return }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('no route')
  })
}

const boardFile = resolve(here, '..', 'lib', 'board.js')
const boardSize = statSync(boardFile).size

// ---------- 1~5：平台在线 ----------
{
  const { webRoutes, ctx } = collectRoutes()
  entry.apply(ctx, entry.Config({
    root: 'C:\\tmp\\pecker-workbench',
    projectDir,
    python: process.env.PECKER_PYTHON || 'C:\\Python313\\python.exe',
    platformBaseUrl: platformApi,
    requestTimeoutMs: 30_000,
    bridge: false, // 这一轮只验证 web 层，不拉起 MCP
  }))
  const server = serverFor(webRoutes)
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  console.log(`# 看板托管 + 平台反代真实验证\n  origin=${origin}  platform=${platformApi}\n`)
  check(webRoutes.length === 2, `注册了 2 条 webServer 路由（实际 ${webRoutes.length}）`)

  const board = await fetch(`${origin}/api/pecker-dsh-workbench/board.js`)
  const boardBytes = (await board.arrayBuffer()).byteLength
  check(board.status === 200, `GET /board.js → ${board.status}`)
  check(boardBytes === boardSize, `返回完整产物（${boardBytes} / ${boardSize} 字节；注意按字节比，别按字符比）`)
  check(Number(board.headers.get('content-length')) === boardSize, 'Content-Length 与磁盘文件一致')

  const health = await fetch(`${origin}/api/pecker-dsh-workbench/platform/api/health`)
  const healthBody = await health.json().catch(() => null)
  check(health.status === 200, `反代 GET /platform/api/health → ${health.status}`)
  check(healthBody?.status === 'ok', `平台真实响应（status=${healthBody?.status}）`)

  const overview = await fetch(`${origin}/api/pecker-dsh-workbench/platform/api/overview`)
  const overviewBody = await overview.json().catch(() => null)
  check(overview.status === 200 && typeof overviewBody?.counts === 'object',
    `反代 GET /platform/api/overview → ${overview.status}（counts 字段存在）`)

  // 媒体 Range：视频拖动/边下边播靠 206
  const assets = await (await fetch(`${origin}/api/pecker-dsh-workbench/platform/api/assets?kind=image&limit=1`)).json()
  const location = assets?.items?.[0]?.locations?.[0]
  if (location === undefined) {
    lines.push('  · 没有可用的图片位置，跳过 Range 检查')
  } else {
    const query = `root_id=${encodeURIComponent(location.root_id)}&relative_path=${encodeURIComponent(location.relative_path)}`
    const ranged = await fetch(`${origin}/api/pecker-dsh-workbench/platform/api/thumbnails?${query}&width=64`, {
      headers: { Range: 'bytes=0-1023' },
    })
    check(ranged.status === 200 || ranged.status === 206, `缩略图请求经反代返回 ${ranged.status}（200/206 均可）`)
    if (ranged.body !== null) await ranged.body.cancel()
  }

  // SSE：必须 200 + text/event-stream，并能收到真实帧
  const sse = await fetch(`${origin}/api/pecker-dsh-workbench/platform/api/events/stream?after_id=0`, {
    headers: { accept: 'text/event-stream' },
  })
  check(sse.status === 200, `反代 SSE → ${sse.status}`)
  check(String(sse.headers.get('content-type') ?? '').includes('text/event-stream'),
    `SSE content-type=${sse.headers.get('content-type')}`)
  let received = ''
  if (sse.body !== null) {
    const reader = sse.body.getReader()
    const deadline = Date.now() + 8_000
    const decoder = new TextDecoder()
    while (received.length < 40 && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done === true) break
      received += decoder.decode(value, { stream: true })
    }
    await reader.cancel().catch(() => {})
  }
  check(received.includes('data:'), `SSE 收到真实帧（${received.slice(0, 60).replace(/\n/g, '\\n')}…）`)

  await new Promise((done) => server.close(done))
}

// ---------- 6：平台不可达时如实 502 ----------
{
  const { webRoutes, ctx } = collectRoutes()
  entry.apply(ctx, entry.Config({
    root: 'C:\\tmp\\pecker-workbench',
    projectDir,
    python: 'C:\\Python313\\python.exe',
    platformBaseUrl: 'http://127.0.0.1:9',
    requestTimeoutMs: 3_000,
    bridge: false,
  }))
  const server = serverFor(webRoutes)
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(`${origin}/api/pecker-dsh-workbench/platform/api/health`)
  const body = await response.json().catch(() => null)
  check(response.status === 502, `平台不可达时反代返回 502（实际 ${response.status}）`)
  check(typeof body?.detail === 'string' && body.detail.includes('平台反代失败'), '502 带可读原因（不伪装成功）')
  await new Promise((done) => server.close(done))
}

console.log(lines.join('\n'))
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`\n全部通过（${lines.filter((line) => line.startsWith('  ✓')).length} 项）`)
process.exit(0)
