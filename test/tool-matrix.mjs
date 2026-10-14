/**
 * 只读工具矩阵：把 27 个工具里**不产生副作用**的那些逐个真调一遍，
 * 逐个报告 OK / 错误。目的：证明"27 个工具注册了"之外，还要证明它们**真的能用**。
 *
 * 会调用的（读）：capabilities, roots, assets_list/get, versions_list/get, tools_list/inspect,
 *                skills_list/inspect, jobs_list/status/result, events_list, recipes_list/impact,
 *                agents_providers, media_probe
 * 不会调用的（写/收费/联网）：bundles_import, skills_materialize, media_extract_clip,
 *                media_download, jobs_submit/cancel/retry, agents_submit_request/attach_plan
 *
 * 用法：node test/tool-matrix.mjs [--json <outfile>]
 */
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { McpStdioClient } from '../lib/mcp-bridge.mjs'

const projectDir = process.env.PECKER_PROJECT_DIR || 'D:\\project\\本地创作工具'
const python = process.env.PECKER_PYTHON || 'C:\\Python313\\python.exe'
const platformDir = join(projectDir, 'platform')
const rootsFile = join(projectDir, 'config', 'roots.json')
const jsonFlag = process.argv.indexOf('--json')
const jsonOut = jsonFlag === -1 ? null : process.argv[jsonFlag + 1]

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

/** 从工具返回的信封里取出载荷（{result: ...} 或错误对象）。 */
function payload(result) {
  const text = (result?.content ?? []).map((block) => block?.text ?? '').join('\n')
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 400) }
  }
}

function firstId(list, key) {
  const items = list?.result?.items ?? list?.items ?? []
  if (!Array.isArray(items) || items.length === 0) return null
  const row = items[0]
  return row?.[key] ?? row?.skill_id ?? row?.job_id ?? null
}

const state = {}
const cases = [
  ['capabilities', () => ({})],
  ['roots', () => ({})],
  ['assets_list', () => ({ limit: 3 })],
  ['assets_get', () => (state.assetId === null ? null : { asset_id: state.assetId })],
  ['versions_list', () => ({ limit: 3 })],
  ['versions_get', () => (state.versionId === null ? null : { version_id: state.versionId })],
  ['tools_list', () => ({})],
  ['tools_inspect', () => (state.toolId === null ? null : { tool_id: state.toolId })],
  ['skills_list', () => ({})],
  ['skills_list(provider)', () => (state.providerId === null ? null : { provider_id: state.providerId }), 'skills_list'],
  ['skills_inspect', () => (state.skillRef === null ? null : { ...state.skillRef, include_instructions: false })],
  ['jobs_list', () => ({ limit: 3 })],
  ['jobs_status', () => (state.jobId === null ? null : { job_id: state.jobId })],
  ['jobs_result', () => (state.jobId === null ? null : { job_id: state.jobId })],
  ['events_list', () => ({ limit: 3 })],
  ['recipes_list', () => ({})],
  ['recipes_impact', () => (state.recipeId === null ? null : { recipe_id: state.recipeId, patch: { note: 'tool-matrix dry-run' } })],
  ['agents_providers', () => ({})],
  ['media_probe', () => ({
    root_id: 'huashu',
    relative_path: 'output/五险一金_生活物件科普_终版.mp4',
  })],
]

const rows = []
try {
  await client.connect()

  for (const [name, argBuilder, toolOverride] of cases) {
    const wireName = toolOverride ?? name
    const args = argBuilder()
    if (args === null) {
      rows.push({ tool: name, status: 'skipped', note: '前置列表没给出可用 id' })
      continue
    }
    const started = Date.now()
    try {
      const result = await client.callTool(wireName, args)
      const body = payload(result)
      const raw = (result?.content ?? []).map((block) => block?.text ?? '').join('\n')
      const failed = body?.status === 'error' || result?.isError === true
      const inner = body?.result ?? body

      // 给后续用例留 id
      if (name === 'assets_list') state.assetId = firstId(inner, 'asset_id')
      if (name === 'versions_list') state.versionId = firstId(inner, 'version_id')
      if (name === 'tools_list') state.toolId = firstId(inner, 'tool_id')
      if (name === 'skills_list') {
        const items = inner?.items ?? inner?.skills ?? []
        const first = Array.isArray(items) ? items[0] : null
        state.providerId = first?.provider_id ?? null
      }
      if (name === 'skills_list(provider)') {
        const items = inner?.items ?? inner?.skills ?? []
        const first = Array.isArray(items) ? items[0] : null
        state.skillRef = first === null || first === undefined
          ? null
          : { provider_id: first.provider_id ?? state.providerId, skill_id: first.skill_id }
      }
      if (name === 'jobs_list') state.jobId = firstId(inner, 'job_id')
      if (name === 'recipes_list') state.recipeId = firstId(inner, 'recipe_id')

      rows.push({
        tool: name,
        status: failed ? 'ERROR' : 'ok',
        ms: Date.now() - started,
        note: failed ? (String(`${body?.error ?? ''} ${body?.detail ?? ''}`).trim() || raw.slice(0, 200)) : summarize(inner),
      })
    } catch (error) {
      rows.push({ tool: name, status: 'THREW', note: error instanceof Error ? error.message : String(error) })
    }
  }
} finally {
  client.close()
}

function summarize(inner) {
  if (inner === null || typeof inner !== 'object') return typeof inner
  const items = inner.items ?? inner.skills
  if (Array.isArray(items)) return `${items.length} 项`
  const keys = Object.keys(inner)
  return `${keys.length} 字段（${keys.slice(0, 4).join(',')}${keys.length > 4 ? '…' : ''}）`
}

console.log('# 只读工具矩阵（真实 MCP 调用）\n')
for (const row of rows) {
  const mark = row.status === 'ok' ? '✓' : row.status === 'skipped' ? '·' : '✗'
  console.log(`${mark} ${row.tool.padEnd(18)} ${row.status.padEnd(8)} ${String(row.ms ?? '').padStart(6)}ms  ${row.note}`)
}
const bad = rows.filter((row) => row.status !== 'ok' && row.status !== 'skipped')
console.log(`\n合计 ${rows.length} 个：ok ${rows.filter((r) => r.status === 'ok').length} / skipped ${rows.filter((r) => r.status === 'skipped').length} / 失败 ${bad.length}`)
if (jsonOut !== null) {
  await writeFile(jsonOut, JSON.stringify({ checkedAt: new Date().toISOString(), rows }, null, 2), 'utf8')
  console.log(`已写入 ${jsonOut}`)
}
process.exit(bad.length === 0 ? 0 : 1)
