/**
 * 0.1.2 回归：ctx.inject(['tools'], cb) 是**延迟**的（cordis 把它当子插件），
 * 不能在 apply() 里同步判定"服务不可用"。
 *
 * 0.1.1 的 bug：同步检查 registered → 立刻认定 ctx.tools 不可用 → 关掉平台连接 →
 * 结果 27 个工具一个都没注册（真机日志：`ctx.tools 不可用，27 个工具未注册`）。
 *
 * 本测试用**真实**平台 MCP + 一个"把 inject 回调存起来、稍后再调用"的 mock ctx：
 *   1. 连接建立后状态必须是 connected + registrationPending，且**不许报错、不许关连接**；
 *   2. 稍后调用注入回调 → 状态变 ready、registered=true、27 个 workbench_* 工具注册；
 *   3. 注销该 effect → 状态如实退回 connected + pending（不继续谎报 ready）。
 *
 * 需要本机平台 MCP 可用（C:\Python313\python.exe 有 mcp 包）。用法：node test/server-entry-deferred.mjs
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectDir = process.env.PECKER_PROJECT_DIR || 'D:\\project\\本地创作工具'
const entry = await import(pathToFileURL(resolve(here, '..', 'dsh', 'index.js')).href)

const failures = []
const lines = []
function check(condition, message) {
  lines.push(`${condition ? '  ✓' : '  ✗'} ${message}`)
  if (!condition) failures.push(message)
}

const routes = new Map()
const logs = []
let deferredInject = null
let deferredDeps = null

const ctx = {
  logger: {
    info: (message) => logs.push(`info: ${message}`),
    warn: (message) => logs.push(`warn: ${message}`),
    error: (message) => logs.push(`error: ${message}`),
  },
  effect(factory, label) {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  // 关键：延迟调用，模拟"tools 服务稍后才出现"
  inject(deps, callback) {
    deferredDeps = deps
    deferredInject = callback
    return { dispose() {} }
  },
  connection: { fetch: { register: (route) => routes.set(route.path, route) } },
}

const config = entry.Config({
  root: 'C:\\tmp\\pecker-workbench',
  projectDir,
  // 必须显式指定带 mcp 包的解释器：PATH 上的 python 是 Anaconda 3.11，没有 mcp。
  python: process.env.PECKER_PYTHON || 'C:\\Python313\\python.exe',
  platformBaseUrl: 'http://127.0.0.1:9',
  requestTimeoutMs: 120_000,
})
entry.apply(ctx, config)

const statusRoute = routes.get('/api/pecker-dsh-workbench/status')
async function readStatus() {
  const response = await statusRoute.fetch(new Request('http://x/status'))
  return await response.json()
}

// 等桥接完成握手（不调用注入回调）
let status = await readStatus()
const deadline = Date.now() + 60_000
while (status.bridge.state === 'connecting' && Date.now() < deadline) {
  await new Promise((done) => setTimeout(done, 400))
  status = await readStatus()
}

console.log(`# 服务端入口：延迟注入回归\n  bridge.state=${status.bridge.state}\n`)
check(status.bridge.state === 'connected', `握手后状态是 connected（实际 ${status.bridge.state}）`)
check(status.bridge.registered === false, 'registered 仍为 false（工具还没注册）')
check(status.bridge.registrationPending === true, 'registrationPending=true（如实表达"在等服务"）')
check(status.bridge.toolCount === 0, 'toolCount=0（没注册就不报数）')
check(status.bridge.error === null || status.bridge.error === undefined, '没有把"等待"当成错误')
check(status.bridge.protocolVersion === '2025-11-25', `protocolVersion 已记录（${status.bridge.protocolVersion}）`)
check(!logs.some((line) => line.startsWith('warn:')), '没有 warn（0.1.1 会在这里误报不可用）')
check(typeof deferredInject === 'function', 'ctx.inject 被调用且回调被挂起（等待 tools）')
check(Array.isArray(deferredDeps) && deferredDeps.includes('tools'), `inject 依赖含 tools（${JSON.stringify(deferredDeps)}）`)

// 稍后 tools 就绪：手动调用挂起的回调
const registered = []
let effectCleanup = null
const fakeToolCtx = {
  effect(factory, label) {
    const dispose = factory()
    effectCleanup = typeof dispose === 'function' ? dispose : null
    void label
    return () => effectCleanup?.()
  },
  tools: {
    register(definition) {
      registered.push(definition.name)
      return () => {
        const index = registered.indexOf(definition.name)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  },
}
deferredInject(fakeToolCtx)

status = await readStatus()
check(status.bridge.state === 'ready', `注入回调跑完后状态是 ready（实际 ${status.bridge.state}）`)
check(status.bridge.registered === true, 'registered=true')
check(status.bridge.registrationPending === false, 'registrationPending=false')
check(registered.length === 27, `注册了 27 个工具（实际 ${registered.length}）`)
check(status.bridge.toolCount === 27, `toolCount=27（实际 ${status.bridge.toolCount}）`)
check(registered.every((name) => name.startsWith('workbench_')), '工具名统一 workbench_ 前缀')
check(typeof status.bridge.registeredAt === 'string', 'registeredAt 已记录')

// 服务消失：注销后必须如实退回 pending
effectCleanup?.()
status = await readStatus()
check(status.bridge.state === 'connected', `注销后状态退回 connected（实际 ${status.bridge.state}）`)
check(status.bridge.registered === false, '注销后 registered=false')
check(status.bridge.registrationPending === true, '注销后 registrationPending=true')
check(status.bridge.toolCount === 0, '注销后 toolCount 归零')
check((status.bridge.note ?? '').length > 0, '注销后给出可读 note')

console.log(lines.join('\n'))
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`\n全部通过（${lines.length} 项）`)
process.exit(0)
