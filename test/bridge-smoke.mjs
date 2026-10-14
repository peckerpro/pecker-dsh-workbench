/**
 * 真实 MCP 桥接冒烟测试：不依赖 DSH Desktop，直接用本插件自带的 stdio 客户端连业务平台。
 *
 * 用法：
 *   node test/bridge-smoke.mjs                      # 握手 + tools/list + 工具映射校验
 *   node test/bridge-smoke.mjs --call media_probe --args '{"root_id":"huashu","relative_path":"output/五险一金_生活物件科普_终版.mp4"}'
 *
 * 环境变量（都有默认值）：
 *   PECKER_PROJECT_DIR  平台根目录，默认 D:\project\本地创作工具
 *   PECKER_PYTHON       Python 可执行文件，默认 C:\Python313\python.exe
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { McpStdioClient } from '../lib/mcp-bridge.mjs'
import { buildToolDefinitions } from '../lib/tool-defs.mjs'

const projectDir = process.env.PECKER_PROJECT_DIR || 'D:\\project\\本地创作工具'
const python = process.env.PECKER_PYTHON || 'C:\\Python313\\python.exe'
const platformDir = join(projectDir, 'platform')
const rootsFile = join(projectDir, 'config', 'roots.json')

const argv = process.argv.slice(2)
const callIndex = argv.indexOf('--call')
const callName = callIndex === -1 ? null : argv[callIndex + 1]
const argsIndex = argv.indexOf('--args')
const callArgs = argsIndex === -1 ? {} : JSON.parse(argv[argsIndex + 1])

const failures = []
const lines = []
function check(condition, message) {
  lines.push(`${condition ? '  ✓' : '  ✗'} ${message}`)
  if (!condition) failures.push(message)
}

console.log(`# MCP 桥接冒烟测试\n  projectDir=${projectDir}\n  python=${python}\n`)

const client = new McpStdioClient({
  command: python,
  args: ['-m', 'workbench.mcp'],
  cwd: platformDir,
  env: {
    PYTHONPATH: platformDir,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    ...(existsSync(rootsFile) ? { WORKBENCH_ROOTS_FILE: rootsFile } : {}),
  },
  requestTimeoutMs: 120_000,
})

try {
  const init = await client.connect()
  console.log(`握手完成：protocolVersion=${client.protocolVersion} server=${JSON.stringify(client.serverInfo)}\n`)
  check(typeof client.protocolVersion === 'string' && client.protocolVersion.length > 0, 'initialize 返回 protocolVersion')
  check(init?.capabilities !== undefined, 'initialize 返回 capabilities')

  const tools = await client.listTools()
  check(Array.isArray(tools) && tools.length > 0, `tools/list 返回非空列表（实际 ${tools.length}）`)

  const expectedFile = join(projectDir, 'outputs', 'workbench', 'mcp-verification-2026-10-13.json')
  if (existsSync(expectedFile)) {
    const recorded = JSON.parse(await readFile(expectedFile, 'utf8'))
    const live = tools.map((tool) => tool.name).sort()
    const before = [...(recorded.tools ?? [])].sort()
    check(live.length === before.length, `工具数量与 2026-10-13 记录一致（记录 ${before.length}，实测 ${live.length}）`)
    const onlyLive = live.filter((name) => !before.includes(name))
    const onlyRecorded = before.filter((name) => !live.includes(name))
    check(onlyLive.length === 0 && onlyRecorded.length === 0,
      `工具名集合一致（新增 [${onlyLive.join(', ')}] / 缺失 [${onlyRecorded.join(', ')}]）`)
  } else {
    lines.push(`  · 未找到 ${expectedFile}，跳过与历史记录的比对`)
  }

  const { definitions, skipped } = buildToolDefinitions(tools, { call: async () => ({ content: [] }) })
  check(definitions.length === tools.length, `全部工具都成功映射为 ToolDefinition（${definitions.length}/${tools.length}）`)
  check(skipped.length === 0, `没有映射失败的工具有 ${skipped.length} 个${skipped.length ? `：${JSON.stringify(skipped)}` : ''}`)
  check(new Set(definitions.map((definition) => definition.name)).size === definitions.length, '公开工具名无重复')
  check(definitions.every((definition) => definition.name.startsWith('workbench_')),
    '公开工具名统一带 workbench_ 前缀')
  check(definitions.every((definition) => definition.name.length <= 64), '公开工具名不超过 64 字符')
  check(definitions.every((definition) => definition.parameters !== null && typeof definition.parameters === 'object'),
    '每个工具都带原始 JSON Schema 参数')
  check(definitions.every((definition) => typeof definition.output?.render === 'function'), '每个工具都有 output.render')
  check(definitions.every((definition) => definition.output?.schema?.required?.includes('content')), 'output.schema 要求 content')
  check(definitions.every((definition) => typeof definition.execute === 'function'), '每个工具都有 execute')

  const withParams = definitions.filter((definition) => (definition.parameters.required ?? []).length > 0)
  lines.push(`  · ${withParams.length}/${definitions.length} 个工具有必填参数`)
  lines.push(`  · expect（已实测）示例：${(tools.find((tool) => tool.name === 'media_probe')?.inputSchema?.required ?? []).join(', ') || '(无必填)'}`)
  lines.push('')
  lines.push(`  · 桥接后的工具名（前 8 个）：${definitions.slice(0, 8).map((definition) => definition.name).join(', ')}…`)

  if (callName !== null) {
    console.log(`\n# tools/call ${callName} ${JSON.stringify(callArgs)}`)
    const result = await client.callTool(callName, callArgs)
    const text = (result?.content ?? []).map((block) => block?.text ?? '').join('\n')
    console.log(`isError=${String(result?.isError ?? false)}`)
    console.log(text.length > 4000 ? `${text.slice(0, 4000)}\n…（截断，共 ${text.length} 字符）` : text)
    check(result?.isError !== true, `${callName} 未返回 isError`)
  }
} catch (error) {
  failures.push(`桥接失败：${error instanceof Error ? error.message : String(error)}`)
  if (client.stderrTail.length > 0) {
    lines.push('')
    lines.push('  MCP stderr（最后 20 行）：')
    for (const line of client.stderrTail.split('\n')) lines.push(`    ${line}`)
  }
} finally {
  client.close()
}

console.log('\n' + lines.join('\n'))
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\n全部通过')
