/**
 * 把看板的嵌入式产物同步进插件包：`web/dist-embed/pecker-board.js` → `lib/board.js`。
 *
 * 为什么要有这一步：工作台面板是宿主渲染器里的一个 React 组件，它不能自己去 fetch
 * 插件包目录里的文件；而看板（React 19 + Tailwind CSS 内联）是一个**单文件**产物。
 * 插件服务端会用 `GET /api/pecker-dsh-workbench/board.js` 把这份文件托管给面板，
 * 因此它必须躺在插件包里。
 *
 * 用法（在插件仓库根目录）：
 *   node scripts/sync-board.mjs
 *   PECKER_WEB_DIR=D:\project\本地创作工具\web node scripts/sync-board.mjs
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const webDir = process.env.PECKER_WEB_DIR || 'D:\\project\\本地创作工具\\web'
const source = join(webDir, 'dist-embed', 'pecker-board.js')
const target = join(pluginRoot, 'lib', 'board.js')

let info
try {
  info = statSync(source)
} catch {
  console.error(`找不到 ${source}\n先在 web/ 跑：pnpm build:embed`)
  process.exit(2)
}

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
const bytes = readFileSync(target)
const digest = createHash('sha256').update(bytes).digest('hex')
console.log(`synced ${source} -> ${target}`)
console.log(`  size=${info.size} bytes  sha256=${digest}`)
console.log('  记得把 lib/board.js 提交进插件仓库（它是面板要托管的产物）')
