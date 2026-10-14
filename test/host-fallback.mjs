/**
 * 模拟 Desktop 的宿主包回退（resources/host-module-fallback.mjs）：
 * 插件自己的 node_modules 里没有 @deepseek-ai/* 时，Desktop 会从安装锚点重新解析。
 * 这里用同样的规则把 @deepseek-ai/* 映射到本机开发用的宿主包副本，
 * 从而在**不启动 Desktop** 的前提下验证"已安装的插件包能否被加载"。
 *
 * 用法：node --import ./test/host-fallback.mjs <script>
 * 环境变量：PECKER_HOST_ANCHOR（含 node_modules/@deepseek-ai/* 的目录），默认本包根目录
 */
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const anchor = process.env.PECKER_HOST_ANCHOR || resolve(here, '..')
const anchorEntryUrl = pathToFileURL(resolve(anchor, '__host_anchor__.js')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('@deepseek-ai/')) throw error
      try {
        return nextResolve(specifier, { ...context, parentURL: anchorEntryUrl })
      } catch (hostError) {
        error.message += `\n  host fallback from ${anchorEntryUrl} also failed: ${hostError.message}`
        throw error
      }
    }
  },
})
