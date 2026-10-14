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
  useEffect: () => {},
}
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

console.log(lines.join('\n'))
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`\n全部通过（${lines.length} 项）`)
