# pecker-dsh-workbench

把本地创作工具（`D:\project\本地创作工具`）接进 DSH Desktop 的工作台插件：在侧栏获得「本地创作」模式，用原生 DSH 会话通过平台工具驱动素材、作品与创作能力。

- 工作台身份：`peckerpro/pecker-dsh-workbench`
- 版本：0.1.0（V1，只读）
- 状态：**本机自用**，不上架工作台市场

## 1. 它做什么（V1）

| 能力 | 说明 |
|---|---|
| 侧栏「本地创作」工作台 | 由 `desktopWorkbenches.register()` 注册，`customFrame` 面板：左边原生会话、右边只读状态栏 |
| 原生会话节点 | 宿主把会话 React 子树交给面板，面板只负责摆放，不重建聊天界面 |
| 状态如实呈现 | 平台未运行时显示「未连接」+ 真实失败原因；不显示 0 冒充成功 |
| 27 个平台工具 | 插件自带最小 MCP stdio 客户端，把平台业务 MCP 的工具注册为 `workbench_<tool>`，会话里可直接调用 |
| 不可用能力标注 | 渲染 / 字幕 / ASR / TTS / 白板 / Huashu gate 等未登记的 stage 在面板里明确列出 |

V1 **不做**：自动拉起 Python 平台、写业务数据、会话归属写入、托管看板前端（这些在后续 Goal）。

## 2. 安装（本机自用）

桌面版没有「选择本地包」入口，本地包只能走命令行：

```powershell
# 1) 打包
cd D:\project\pecker-dsh-workbench
pnpm pack            # 产出 pecker-dsh-workbench-0.1.0.tgz

# 2) 安装到 Desktop 的 web profile（Desktop 自带的 dsh CLI 在 app.asar 里，不在 PATH 上）
$env:ELECTRON_RUN_AS_NODE='1'
& "D:\dsh-windows\DSH Desktop\DSH Desktop.exe" `
  "D:\dsh-windows\DSH Desktop\resources\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile web add "file:D:\project\pecker-dsh-workbench\pecker-dsh-workbench-0.1.0.tgz"

# 3) 完全退出并重启 DSH Desktop（profile bundle 只在启动时合成）
```

卸载：

```powershell
& "D:\dsh-windows\DSH Desktop\DSH Desktop.exe" "<同上 bin.js 路径>" plugin --profile web remove pecker-dsh-workbench
```

## 3. 配置

安装后本插件的配置来自 `package.json` 里的 `cordis.patch.yml`；需要改动时写进目标 profile 的 `cordis.patch.yml`（整行替换 `config`，不是深合并）：

```yaml
- id: pecker-dsh-workbench
  name: pecker-dsh-workbench
  config:
    root: !!js dshHomePath('pecker-dsh-workbench')
    projectDir: 'D:\project\本地创作工具'      # 唯一必须确认的键
    platformBaseUrl: 'http://127.0.0.1:8765'   # 平台 HTTP API
    dashboardUrl: 'http://127.0.0.1:5173'      # 独立看板（Vite）
    python: 'C:\Python313\python.exe'          # 启动平台 MCP 用；留空则用 PATH 上的 python
    bridge: true                               # 关掉则只保留面板与状态读取
```

插件自有的本机接口（全部在 `/api/pecker-dsh-workbench/` 下）：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/ping` | GET | 插件存活 |
| `/config` | GET | 解析后的有效配置（无密钥） |
| `/status` | GET | 平台健康 / 总览 / 最近作业 / 桥接状态 / 启动命令 / 不可用能力 |
| `/bridge/restart` | POST | 平台刚起来但工具没注册上时，重试桥接（不必重启 Desktop） |

## 4. 关于 `repository` 字段：本地自用也必须填

工作台规范把 `repository` 列为**必须**，原因不是「要上架」，而是宿主拿它当**工作台身份**：

- `register({ repository })` 里的 URL 会被规范化成 `owner/repo`（这里 = `peckerpro/pecker-dsh-workbench`）；
- 宿主 `identityForSource()` 会把「市场安装记录 ∪ 市场目录 ∪ 旧 id ∪ 声明的 repository」收敛成**唯一身份**；本地安装的包没有市场记录，如果又不声明 repository，身份数为 0 → 抛 `Client package X is not attributed to a market repository.` → **这个工作台根本不会出现在侧栏**（不是少个图标，是整个面板注册不上）；
- 这个 URL **不会被访问、不会被上传、不会被校验仓库是否存在、不会要求仓库公开**；它只是字符串身份，用于侧栏条目、会话归属表（`desktop-workbenches/state.json` 的 `sessionBindings`）与本地 `knownProviders`；
- 官方规范也写明：只在本地开发自己使用时，满足规范即可，**不需要公开代码，也不需要上传到任何地方**。

**代价**：身份一旦写进会话归属就不能随意改名/转移仓库，否则既有会话会失去归属（数据不丢，但那些会话会变回普通会话）。所以选一个稳定的 URL 后就不要动。

## 5. 自测

```powershell
node test/check-package.mjs        # 33 项：包字段 / 客户端契约 / patch 契约
node test/server-entry-smoke.mjs   # 28 项：mock cordis 跑 apply()，含"平台不可达不伪造成功"
node test/client-smoke.mjs         # 20 项：执行客户端 bundle，用假 React 渲染面板并校验注册描述符
node test/bridge-smoke.mjs         # 真实 MCP：握手 + tools/list(27) + 工具映射 + 可选 tools/call
node test/tool-matrix.mjs          # 19 项只读工具逐个真调（不含写/联网/收费工具）
node test/bridge-smoke.mjs --call media_probe --args '{\"root_id\":\"huashu\",\"relative_path\":\"output/五险一金_生活物件科普_终版.mp4\"}'
```

`node_modules/@deepseek-ai/{schemastery,cosmokit}` 只是**本机开发测试**用的宿主包副本（从 `app.asar` 提取），不进安装包；安装到 Desktop 后这两个包由宿主的 `host-module-fallback` 提供。

真实自测记录见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 6. 许可

MIT。
