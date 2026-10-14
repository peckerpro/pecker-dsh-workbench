/**
 * 把 MCP 工具映射成 Harness 的 ToolDefinition。
 *
 * 形状照抄官方 MCP 桥接（@deepseek-ai/dsh-mcp-client 的 syncTools/createOutput）：
 *   { name, description, parameters: <原始 JSON Schema>, output: { schema, render }, execute }
 * Harness 的 ctx.tools.register 直接接受原始 JSON Schema（MCP 工具就是这么进来的）。
 *
 * 与官方桥接的差别：命名前缀用 `workbench_` 而不是 `mcp__<server>__`，便于会话里一眼看出
 * 这些工具属于本工作台；其余（content 数组形状、isError 抛错、text 投影）保持一致，
 * 这样工具卡片与错误展示沿用宿主既有渲染。
 */

const NAME_SAFE = /[^A-Za-z0-9_]/g
export const DEFAULT_PREFIX = 'workbench_'

/** 公开工具名：只保留 [A-Za-z0-9_]，并限制在 64 字符内。 */
export function publicToolName(prefix, rawName) {
  const joined = `${prefix}${rawName}`.replace(NAME_SAFE, '_')
  if (joined.length <= 64) return joined
  return joined.slice(0, 64)
}

/** 从 MCP content 数组里取纯文本（与官方桥接同样的宽松读取）。 */
export function extractText(content, fallbackLabel = 'tool') {
  if (!Array.isArray(content)) return `（${fallbackLabel} 无输出）`
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (block.type !== undefined && block.type !== 'text') parts.push(JSON.stringify(block))
  }
  if (parts.length === 0) return `（${fallbackLabel} 无文本输出）`
  return parts.join('\n')
}

/** MCP 结果 → 规范值（与 output.schema 对齐：只有 content 一个键）。 */
export function normalizeResult(result) {
  if (Array.isArray(result?.content)) return result.content
  if (result !== null && typeof result === 'object' && 'structuredContent' in result) {
    return [{ type: 'text', text: JSON.stringify(result.structuredContent) }]
  }
  return [{ type: 'text', text: '(no output)' }]
}

/**
 * 构造单个工具的 ToolDefinition。
 * @param {{name: string, description?: string, inputSchema?: unknown}} tool MCP 工具描述
 * @param {{prefix?: string, call: (rawName: string, args: Record<string, unknown>, exec?: unknown) => Promise<unknown>}} options
 */
export function buildToolDefinition(tool, { prefix = DEFAULT_PREFIX, call } = {}) {
  if (typeof call !== 'function') throw new TypeError('buildToolDefinition: call is required')
  const rawName = tool?.name
  if (typeof rawName !== 'string' || rawName.length === 0) throw new TypeError('buildToolDefinition: tool.name is required')
  const schema = tool.inputSchema
  const parameters = schema !== null && typeof schema === 'object' && !Array.isArray(schema)
    ? schema
    : { type: 'object', properties: {} }

  return {
    name: publicToolName(prefix, rawName),
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: extractText(value?.content, rawName) }]
      },
    },
    async execute(args, exec) {
      const argsObject = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
      const result = await call(rawName, argsObject, exec)
      const content = normalizeResult(result)
      if (result?.isError === true) {
        throw new Error(extractText(content, rawName) || `工具 ${rawName} 返回错误`)
      }
      return { content }
    },
  }
}

/** 批量构造；单个工具失败只跳过它，并记录原因（不静默吞掉）。 */
export function buildToolDefinitions(tools, options) {
  const definitions = []
  const skipped = []
  for (const tool of tools ?? []) {
    try {
      definitions.push(buildToolDefinition(tool, options))
    } catch (error) {
      skipped.push({ tool: tool?.name ?? '(unnamed)', reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { definitions, skipped }
}
