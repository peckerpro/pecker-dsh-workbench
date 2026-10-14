/**
 * 服务端入口冒烟测试：用 mock cordis context 跑 apply()，断言路由与桥接行为。
 *
 * 覆盖：
 *   1. Config 能被 Schemastery 校验并填默认值；
 *   2. apply() 注册了 4 条自有路由，且都在 /api/pecker-dsh-workbench/ 前缀下；
 *   3. 平台不可达时 /status 如实返回 reachable=false（不显示 0 当成功）；
 *   4. projectDir 未配置时 bridge = unconfigured，且不尝试启动任何子进程。
 *
 * 运行：node test/server-entry-smoke.mjs
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// PECKER_ENTRY 指向已安装副本时，本测试同时验证"装进 profile 的那份文件"可用。
const entryPath = process.env.PECKER_ENTRY ?? resolve(here, '..', 'dsh', 'index.js')
const entry = await import(pathToFileURL(entryPath).href)
console.log(`# entry: ${entryPath}`)

const failures = []
const results = []
function check(condition, message) {
  results.push(`${condition ? '  ✓' : '  ✗'} ${message}`)
  if (!condition) failures.push(message)
}

// ---- 1. Config ----
const standard = entry.Config?.['~standard']
check(typeof standard?.validate === 'function', 'Config 暴露 Standard Schema 的 ~standard.validate')
const validated = standard.validate({
  root: 'C:\\tmp\\pecker-workbench',
  projectDir: '',
  platformBaseUrl: 'http://127.0.0.1:9', // 保证探测失败且不误连真实服务
})
check(validated?.issues === undefined, `Config 校验通过（issues=${JSON.stringify(validated?.issues ?? null)}）`)
check(validated?.value?.requestTimeoutMs === 60_000, 'Config 填入了 requestTimeoutMs 默认值')
check(validated?.value?.bridge === true, 'Config 填入了 bridge 默认值')
const rejected = standard.validate({})
check(Array.isArray(rejected?.issues) && rejected.issues.length > 0, 'Config 对缺失 root 报错（required 生效）')

// ---- 2/3. apply() ----
const routes = new Map()
const logs = []
const effects = []
const ctx = {
  logger: {
    info: (message) => logs.push(`info: ${message}`),
    warn: (message) => logs.push(`warn: ${message}`),
    error: (message) => logs.push(`error: ${message}`),
  },
  effect(factory, label) {
    effects.push(label ?? '(unlabeled)')
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject() {
    throw new Error('V1 冒烟测试不应触发 ctx.inject（桥接必须在 unconfigured 时跳过）')
  },
  connection: {
    fetch: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
      },
    },
  },
}

entry.apply(ctx, entry.Config(validated.value))

check(routes.size === 4, `注册了 4 条路由（实际 ${routes.size}）`)
for (const path of [
  '/api/pecker-dsh-workbench/ping',
  '/api/pecker-dsh-workbench/config',
  '/api/pecker-dsh-workbench/status',
  '/api/pecker-dsh-workbench/bridge/restart',
]) {
  check(routes.has(path), `路由存在：${path}`)
}
check([...routes.keys()].every((path) => path.startsWith('/api/pecker-dsh-workbench/')),
  '所有路由都在自己的前缀下（不占用宿主或其他插件的路径）')
check(effects.some((label) => label.includes('bridge lifetime')), '登记了 bridge 生命周期 effect')
check(logs.some((line) => line.startsWith('info:') && line.includes('已加载')), 'apply() 打出加载日志')
check(!logs.some((line) => line.startsWith('warn:') && line.includes('平台 MCP')),
  'projectDir 未配置时不尝试启动 MCP（无 warn）')

const pingResponse = await routes.get('/api/pecker-dsh-workbench/ping').fetch(new Request('http://x/api/pecker-dsh-workbench/ping'))
check(pingResponse.status === 200, `/ping 返回 200（实际 ${pingResponse.status}）`)

const statusResponse = await routes.get('/api/pecker-dsh-workbench/status').fetch(new Request('http://x/api/pecker-dsh-workbench/status'))
const status = await statusResponse.json()
check(statusResponse.status === 200, `/status 返回 200（实际 ${statusResponse.status}）`)
check(status.platform?.reachable === false, '平台不可达时 reachable=false（不伪造成功）')
check(typeof status.platform?.error === 'string' && status.platform.error.length > 0, '/status 带上真实失败原因')
check(status.platform?.overview === null, '平台不可达时 overview 为 null（不显示 0）')
check(status.bridge?.state === 'unconfigured', `projectDir 为空时 bridge.state=unconfigured（实际 ${status.bridge?.state}）`)
check(Array.isArray(status.limitations) && status.limitations.length >= 5, '/status 带 limitations（不可用能力如实列出）')
check(Array.isArray(status.startCommands) && status.startCommands.length === 0, '未配置 projectDir 时不给启动命令')
check(status.plugin?.workbenchId === 'peckerpro/pecker-dsh-workbench', '/status 带工作台身份')

// ---- 4. 已配置但平台未跑：reachable=false，且 bridge 尝试失败后如实记录 ----
const routes2 = new Map()
const logs2 = []
const ctx2 = {
  logger: { info: (m) => logs2.push(`info: ${m}`), warn: (m) => logs2.push(`warn: ${m}`), error: (m) => logs2.push(`error: ${m}`) },
  effect: (factory) => { factory(); return () => {} },
  inject: () => { throw new Error('平台 MCP 不可用时不应注册工具（ctx.inject 不应被调用）') },
  connection: { fetch: { register: (route) => routes2.set(route.path, route) } },
}
const config2 = entry.Config({
  root: 'C:\\tmp\\pecker-workbench',
  projectDir: dirname(resolve(here, '..')), // 真实目录，但没有 platform/workbench.mcp 可跑
  platformBaseUrl: 'http://127.0.0.1:9',
  python: process.execPath === '' ? 'python' : '__definitely_missing_python__',
  requestTimeoutMs: 2_000,
})
entry.apply(ctx2, config2)
await new Promise((done) => setTimeout(done, 1_500))
const status2 = await (await routes2.get('/api/pecker-dsh-workbench/status').fetch(new Request('http://x/status'))).json()
check(status2.bridge?.state === 'unavailable', `MCP 启动失败时 bridge.state=unavailable（实际 ${status2.bridge?.state}）`)
check(typeof status2.bridge?.error === 'string' && status2.bridge.error.length > 0, 'MCP 失败原因被如实记录')
check(status2.bridge?.toolCount === 0, '失败时注册 0 个工具')
check(logs2.some((line) => line.startsWith('warn:') && line.includes('平台 MCP 不可用')), '失败时打 warn 日志（不静默）')
check(Array.isArray(status2.startCommands) && status2.startCommands.length === 4, '配置了 projectDir 时给出 4 条启动命令')

console.log('# 服务端入口冒烟测试')
console.log(results.join('\n'))
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`\n全部通过（${results.length} 项）`)
