/**
 * 客户端单文件冒烟测试：在没有浏览器的前提下执行客户端 bundle，并用假的 React 渲染一次面板。
 *
 * 覆盖：
 *   1. 文件是 classic 脚本形态，通过 window.__ModuleLoader__.load 注册；
 *   2. 模块 id 与包名一致；factory 只 require 共享基线上的 react；
 *   3. apply() 用 ctx.effect 管理注销，并调用 desktopWorkbenches.register；
 *   4. 注册描述符满足宿主的真实校验（title、repository 是 GitHub URL、customFrame 布尔、
 *      businessSide ∈ {left,right}、businessWidth ∈ [0.25,0.7]、icon ≤ 2 字符）；
 *   5. 面板能渲染，且把宿主给的 conversation 节点放进自己的布局（不再建一套聊天界面）；
 *   6. 没有 conversation（未绑定会话）时仍能渲染业务内容。
 *
 * 用法：node test/client-smoke.mjs
 *      PECKER_CLIENT=<已安装副本的 lib/client.js> node test/client-smoke.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = process.env.PECKER_CLIENT ?? resolve(here, '..', 'lib', 'client.js')
const manifest = JSON.parse(await readFile(resolve(here, '..', 'package.json'), 'utf8'))
const source = await readFile(clientPath, 'utf8')

const failures = []
const lines = []
function check(condition, message) {
  lines.push(`${condition ? '  ✓' : '  ✗'} ${message}`)
  if (!condition) failures.push(message)
}

console.log(`# 客户端冒烟测试\n  client: ${clientPath}\n`)

const loads = []
globalThis.window = { __ModuleLoader__: { load: (definition) => loads.push(definition) } }
new Function(source)() // classic 脚本：执行 window.__ModuleLoader__.load(...)

check(loads.length === 1, `注册了 1 个工作台客户端模块（实际 ${loads.length}）`)
const definition = loads[0] ?? {}
check(definition.id === manifest.name, `模块 id 与包名一致（${definition.id}）`)
check(typeof definition.factory === 'function', 'factory 是函数')

const fakeReact = {
  createElement(type, props, ...children) {
    return { __el: true, type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useCallback: (fn) => fn,
  useRef(initial) {
    return { current: initial ?? null }
  },
  useEffect: () => {},
}
fakeReact.Fragment = Symbol('Fragment')
const requireStub = (specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`客户端 require 了共享基线之外的模块：${specifier}`)
}
const exports = definition.factory(requireStub)
check(typeof exports?.apply === 'function', 'factory 返回 apply()')
check(Array.isArray(exports?.inject) && exports.inject.includes('desktopWorkbenches'),
  `inject 声明 desktopWorkbenches（实际 ${JSON.stringify(exports?.inject)}）`)

// ---- apply() ----
let registered = null
const effectLabels = []
const ctx = {
  effect(factory, label) {
    effectLabels.push(label ?? '(unlabeled)')
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  desktopWorkbenches: {
    register(descriptor, Component) {
      registered = { descriptor, Component }
      return () => {}
    },
  },
}
exports.apply(ctx)
check(registered !== null, 'apply() 调用了 desktopWorkbenches.register')
check(effectLabels.length === 1, `注销交给 ctx.effect 管理（effect 数量 ${effectLabels.length}）`)

const descriptor = registered?.descriptor ?? {}
check(typeof descriptor.title === 'string' && descriptor.title.length > 0, `title 存在：${descriptor.title}`)
check(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(descriptor.repository ?? ''),
  `repository 是宿主认可的 GitHub URL：${descriptor.repository}`)
check(typeof descriptor.customFrame === 'boolean', 'customFrame 是布尔')
check(['left', 'right'].includes(descriptor.layout?.businessSide ?? 'right'),
  `businessSide 合法：${descriptor.layout?.businessSide}`)
const width = descriptor.layout?.businessWidth
check(width === undefined || (Number.isFinite(width) && width >= 0.25 && width <= 0.7),
  `businessWidth 在 [0.25,0.7]：${width}`)
const icon = descriptor.icon
check(icon === undefined || [...icon].length <= 2, `icon ≤ 2 字符（否则宿主会退回主题图标）：${icon}`)
check(descriptor.initialization === undefined || descriptor.initialization === 'new-session',
  `initialization 取值合法：${descriptor.initialization}`)
check(descriptor.id === undefined, '没有填旧的 register({ id })（新包不应填）')

// ---- 渲染 ----
const conversationNode = fakeReact.createElement('div', { 'data-test': 'native-conversation' })
const service = { newSession: () => {}, newWorkspaceSession: () => {} }
let tree
try {
  tree = registered.Component({ service, entry: descriptor, conversation: conversationNode })
  check(tree !== null && tree !== undefined, '带 conversation 时面板渲染成功')
} catch (error) {
  check(false, `带 conversation 时面板渲染抛错：${error instanceof Error ? error.message : String(error)}`)
}
function contains(node, predicate) {
  if (node === null || typeof node !== 'object') return false
  if (predicate(node)) return true
  const children = Array.isArray(node.children) ? node.children : []
  return children.some((child) => contains(child, predicate))
}
check(contains(tree, (node) => node?.props?.['data-test'] === 'native-conversation'),
  '面板把宿主的 conversation 节点放进了自己的布局')
check(contains(tree, (node) => node?.props?.className?.includes?.('pecker-wb-conversation')),
  '为 conversation 预留了容器类名')

// ---- 0.1.7 布局契约（用户实际反馈：对话区不能调大小、问题卡被挤到看不全）----
check(contains(tree, (node) => node?.props?.['aria-orientation'] === 'vertical'),
  '有可拖拽的竖直分隔条（role=separator）——对话区宽度可调')
check(contains(tree, (node) => typeof node?.props?.className === 'string'
  && node.props.className.includes('pecker-wb-split')), '分隔条带 pecker-wb-split 类（拖动/双击复位）')
check(contains(tree, (node) => typeof node?.props?.className === 'string'
  && node.props.className.includes('pecker-wb-side--collapsed')),
  '状态区默认收起（把高度让给对话，避免问题卡被挤压）')
check(contains(tree, (node) => Array.isArray(node?.children) && node.children.includes('对话占满')),
  '有"对话占满"按钮（一键把整个面板让给对话）')
// 关键 CSS：对话容器的 min-width/min-height 必须为 0，否则宿主对话节点拒绝收缩会横向溢出
check(/\.pecker-wb-conversation\s*\{[^}]*min-width:\s*0/.test(source),
  'CSS: .pecker-wb-conversation 设了 min-width: 0（宿主节点可收缩）')
check(/\.pecker-wb-conversation\s*\{[^}]*min-height:\s*0/.test(source),
  'CSS: .pecker-wb-conversation 设了 min-height: 0（内部可滚动而不是溢出）')
check(/\.pecker-wb-right\s*\{[^}]*overflow:\s*hidden/.test(source),
  'CSS: .pecker-wb-right 设了 overflow: hidden（内容不越界到看板上）')
check(source.includes('RIGHT_WIDTH_KEY') && source.includes('pointermove'),
  '宽度可调并持久化（localStorage + pointermove 拖拽）')

let bare
try {
  bare = registered.Component({ service, entry: descriptor, conversation: null })
  check(contains(bare, (node) => typeof node?.props?.className === 'string'
    && node.props.className.includes('pecker-wb-empty')), '无会话时给出"新建工作台会话"的引导而不是空白')
} catch (error) {
  check(false, `无会话时面板渲染抛错：${error instanceof Error ? error.message : String(error)}`)
}
check(!contains(tree, (node) => node?.props?.className === 'dshWbConversation'),
  '没有重建宿主的会话容器（不造第二套聊天界面）')

// ---- 0.1.8 平台生命周期契约（用户实际反馈：重启 Desktop 后"未连接"却无法在面板里恢复）----
check(source.includes('/platform/${action}') && source.includes("run('start')") && source.includes("run('restart')"),
  '面板调用插件自己的平台启动/重启端点（而不是让用户去手敲命令）')
check(contains(tree, (node) => Array.isArray(node?.children) && node.children.includes('启动平台')),
  '平台未连接时给出「启动平台」按钮（面板内可一键恢复）')
check(/\busePlatformLifecycle\b/.test(source) && source.includes('lifecycle.pending'),
  '启动/重启有进行中状态（不出现"点了没反应"）')
// 未连接时的话术必须是"怎么办"：读不到 ≠ 数据为空，并指向启动按钮。
check(source.includes('平台没在运行') && source.includes('不是数据为空') && source.includes('守护进程'),
  '未连接时解释原因 + 指向启动按钮 + 说明守护进程（不是一句原始报错）')
check(source.includes('supervisor') && source.includes('logTail'),
  '状态里暴露守护进程事实（pid / alive / 日志尾巴），不猜')

// ---- 0.1.9 会话归属契约（实测：不写 initialization 会沿用当前活动会话，绑错会话）----
check(/initialization:\s*'new-session'/.test(source),
  "register 声明 initialization:'new-session'（否则面板沿用当前会话 → 绑到无关会话）")
check(source.includes('没有"指定 cwd"的字段') || source.includes('工作区'),
  '注释说明工作台会话落在用户选的工作区（宿主无 cwd 字段）')
check(contains(tree, (node) => Array.isArray(node?.children) && node.children.includes('新建创作会话')),
  '头部常驻「新建创作会话」入口（选项目文件夹 → 绑定到本工作台，不靠"当前会话")')
check(source.includes('newWorkspaceSession'), '走宿主 newWorkspaceSession（弹目录选择并建立工作台归属）')

console.log(lines.join('\n'))
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`\n全部通过（${lines.length} 项）`)
