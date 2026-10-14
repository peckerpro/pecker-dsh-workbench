/**
 * 包自检：字段、文件、客户端契约、patch 契约。
 * 运行：node test/check-package.mjs
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function check(condition, message) {
  if (condition) notes.push(`  ✓ ${message}`)
  else failures.push(`  ✗ ${message}`)
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
check(typeof manifest.name === 'string' && manifest.name.length > 0, 'package.json 有 name')
check(/^\d+\.\d+\.\d+/.test(manifest.version ?? ''), 'version 是完整 SemVer')
check(manifest.main === './dsh/index.js', 'main 指向服务端入口')
check(manifest.exports?.['.'] === './dsh/index.js', 'exports["."] 指向服务端入口')
check(manifest.exports?.['./client'] === './lib/client.js', 'exports["./client"] 指向客户端入口')
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 已声明')
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform === "web"')
check(
  Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.includes('dsh-desktop-workbenches'),
  'dsh.client.inject 含 dsh-desktop-workbenches（失败降级为 reported failure，不拖垮 GUI）',
)
check(
  manifest.private === true || manifest.publishConfig === undefined,
  '本地自用：private 为 true 或未配置 publishConfig（不会误发布；不影响 dsh plugin add file:<tgz>）',
)
check(
  typeof manifest.repository?.url === 'string' && /github\.com\/peckerpro\/pecker-dsh-workbench/.test(manifest.repository.url),
  'repository 指向 peckerpro/pecker-dsh-workbench（宿主用它解析工作台身份）',
)
check(manifest.peerDependenciesMeta?.['@deepseek-ai/cordis']?.optional === true, 'cordis peer 标为 optional（不重复装宿主代码）')

for (const [field, file] of [
  ['main', manifest.main],
  ['exports["./client"]', manifest.exports?.['./client']],
  ['dsh.bundle.patch', manifest.dsh?.bundle?.patch],
]) {
  const target = join(root, file.replace(/^\.\//, ''))
  const exists = await stat(target).then(() => true).catch(() => false)
  check(exists, `${field} 指向的文件存在：${file}`)
}

const client = await readFile(join(root, 'lib', 'client.js'), 'utf8')
check(client.includes('window.__ModuleLoader__.load('), '客户端入口使用 window.__ModuleLoader__.load')
check(client.includes(`id: '${manifest.name}'`), '客户端模块 id 与包名一致')
check(client.includes('desktopWorkbenches.register('), '客户端调用 desktopWorkbenches.register')
check(client.includes("inject: ['desktopWorkbenches']"), '客户端声明 inject: ["desktopWorkbenches"]')
check(client.includes('https://github.com/peckerpro/pecker-dsh-workbench'), 'register() 提供 repository')
check(/customFrame:\s*true/.test(client), '使用 customFrame（自己放置原生 conversation 节点）')
check(client.includes('pecker-wb-conversation'), '面板为原生会话节点预留容器')

const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
check(/^\s*- insert:/m.test(patch), 'cordis.patch.yml 有 insert 段')
check(/name:\s*pecker-dsh-workbench/.test(patch), 'insert 的 name 是 npm 包名')
check(/id:\s*pecker-dsh-workbench/.test(patch), 'insert 的 id 存在')
check(/root:\s*!!js dshHomePath\('pecker-dsh-workbench'\)/.test(patch), 'config.root 用 dshHomePath 解析')
check(/projectDir:/.test(patch), 'config.projectDir 可配置（唯一必须由安装者确认的键）')
check(!/^\s*\[\s*\]\s*$/m.test(patch.replace(/#.*$/gm, '')), 'patch 不是空数组')

const files = manifest.files ?? []
for (const required of ['dsh/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  const covered = files.some((entry) => required === entry || required.startsWith(entry.replace(/\*\*.*$/, '').replace(/\*.*$/, '')))
  check(covered, `files 覆盖 ${required}`)
}
check(!files.some((entry) => entry.startsWith('test/')), 'files 不包含 test/（不进安装包）')

console.log('# pecker-dsh-workbench 包自检')
console.log(notes.join('\n'))
if (failures.length > 0) {
  console.error(failures.join('\n'))
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log(`\n全部通过（${notes.length} 项）`)
