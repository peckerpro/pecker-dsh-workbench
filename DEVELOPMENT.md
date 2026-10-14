# 开发与自测记录（V1）

日期：2026-10-14 · 包版本 0.1.0 · 工作台身份 `peckerpro/pecker-dsh-workbench`
规范依据：DSH Desktop 随包离线副本《工作台开发规范》（`app.asar/node_modules/dsh-desktop-workbenches/development-guide.zh.md`，2026-09-29 版）
宿主实测版本：DSH Desktop 0.11.1，打包 Harness 0.2.0-rc.2

## 1. 已完成并实测（有真实输出）

| # | 项 | 命令 | 结果 |
|---|---|---|---|
| 1 | 包字段 / 客户端契约 / patch 契约 | `node test/check-package.mjs` | **33 项全部通过** |
| 2 | 服务端入口（mock cordis 跑 `apply()`） | `node test/server-entry-smoke.mjs` | **28 项全部通过** |
| 3 | Config 校验与默认值 | 同上 | `~standard.validate` 通过；缺 `root` 时返回 issues（required 生效）；默认 `requestTimeoutMs=60000`、`bridge=true` |
| 4 | 路由只占自有前缀 | 同上 | 4 条路由全部在 `/api/pecker-dsh-workbench/` 下 |
| 5 | 平台不可达不伪造成功 | 同上 | `platform.reachable=false`、`overview=null`、带真实错误原因 |
| 6 | 桥接失败不阻塞、注册 0 工具 | 同上 | `bridge.state=unavailable`、`toolCount=0`、打 warn 日志 |
| 7 | **真实 MCP 握手** | `node test/bridge-smoke.mjs` | `protocolVersion=2025-11-25`，`serverInfo={"name":"workbench","version":"1.26.0"}` |
| 8 | **27 个工具与历史记录一致** | 同上 | 实测 27，与 `outputs/workbench/mcp-verification-2026-10-13.json` 名称集合完全一致（新增 [] 缺失 []） |
| 9 | **27 个工具全部映射成 ToolDefinition** | 同上 | 27/27，0 跳过；名称唯一、均带 `workbench_` 前缀、≤64 字符；每个都有原始 JSON Schema 参数、`output.render`、`execute` |
| 10 | **真实工具调用（execute 全链路）** | `node test/bridge-smoke.mjs --call media_probe --args '{...}'` | `media_probe` 返回真实 ffprobe 结果（11,217 字符，`full_decode.exit_code=0`），`isError=false` |
| 11 | 打包 | `pnpm pack` | `pecker-dsh-workbench-0.1.0.tgz`，16,301 B；内含 `package.json` / `cordis.patch.yml` / `dsh/index.js` / `lib/client.js` / `lib/mcp-bridge.mjs` / `lib/tool-defs.mjs` / `README.md` / `LICENSE`；**不含 `test/`、不含 `node_modules/`** |

测试用到的 `node_modules/@deepseek-ai/{schemastery,cosmokit}` 是从 `app.asar` 提取的宿主包副本，仅供本机跑测试；安装到 Desktop 后由宿主 `host-module-fallback.mjs` 提供解析。

## 2. 尚未实测（需要安装 + 重启 Desktop，由用户执行）

| # | 项 | 为什么没做 |
|---|---|---|
| 1 | `dsh plugin --profile web add file:<tgz>` 真实安装 | 会改写 profile 配置并要求重启 Desktop，会终止当前会话；命令已按真实 CLI 语法写好（见 README） |
| 2 | 侧栏出现「本地创作」、面板可进入、不遮挡宿主入口 | 同上 |
| 3 | `desktop-workbenches/state.json` 的会话归属记录 | 同上 |
| 4 | 在真实会话里看到 `workbench_*` 工具 | 同上（**桥接本身已在第 7–10 项用真实平台验证过；未验证的是宿主加载后注册进 `ctx.tools` 这一段**） |
| 5 | 卸载后数据保留 | 同上 |

这些项一律标注为**未实测**，不得在未做之前记为通过。

## 3. 规范 §8 自测清单对照

**包与加载**
- [x] 插件负责：§3 全部「必须」项（`dsh.bundle.patch`、`dsh.client.platform="web"`、`dsh.client.inject` 含 `dsh-desktop-workbenches`、真实存在的 `exports["./client"]`、`name` 一致）→ 由 `check-package.mjs` 33 项覆盖
- [x] 插件负责：`pnpm pack` 并用 `tar -tzf` 核对入口与 patch
- [ ] **待用户**：安装并重启；`dsh --profile web --dump-config` 出现本包插件层（注意：`--dump-config` **不含** Desktop 内置层，本包是装进 profile 的，所以会出现）；「已安装的工作台」有条目；从左侧入口打开面板

**界面边界（§4）**
- [ ] **待用户**：打开业务面板、缩放窗口、切换原生会话/工作台，确认不遮挡侧栏/市场/管理入口；键盘可达
- [x] 插件负责：`customFrame` 的根容器按正常 flex 填满宿主分配区域，内部不使用绝对定位越界；未创建第二套聊天界面（原生会话由宿主 `conversation` 节点提供，面板只负责摆放）

**工作区与会话（§5–6）**
- [x] 插件负责：**无会话时业务面板可用**（只读状态不依赖会话）；不静默创建目录/工作区；不替用户发言（本机 0.2.0-rc.2 **没有**开场草稿 API，规范 §6 的"填入草稿"无法实现，面板改为提示用户自行新建会话）
- [ ] **待用户**：同一工作区里分别建原生会话与工作台会话，核对归属互不污染

**模式切换与保留（§7）**
- [ ] **待用户**：模式切换、关闭重开、卸载后数据保留
- [x] 插件负责：记录 Desktop 版本 / 包版本 / 未验证项（本文件）

**已知宿主侧缺口（不是本插件没做好）**
- 规范 §7 要求"会话行前显示工作台小图标"，但 0.2.0-rc.2 的 `ui-sidebar` 没有声明 `sidebar.session.leading` 子槽，`slots.register` 进未声明槽会抛错 → 该图标在宿主层注册不上。

## 4. 设计取舍

| 取舍 | 理由 |
|---|---|
| 客户端手写单文件、不用 JSX/构建链 | 规范只要求"已构建的单文件模块"；少一个构建环节就少一类失败。将来引入 JSX/Tailwind 时再加构建步骤 |
| 自带最小 MCP stdio 客户端，而不用官方 SDK | 插件依赖解析只保证自有依赖 + 宿主 `@deepseek-ai/*` 回退；stdio MCP 就是逐行 JSON-RPC，约 200 行换来零依赖、可独立测试、可精确控制超时 |
| 工具命名 `workbench_<tool>` 而非 `mcp__<server>__<tool>` | 会话里一眼看出属于本工作台；形状（content 数组、isError 抛错、text 投影）与官方桥接一致，沿用宿主既有工具卡片与错误展示 |
| 不自动拉起 Python 平台 | 进程生命周期属于用户决策；V1 只给启动命令与不可达原因 |
| `private: true` | 只自用、不上架，防止误发布；不影响 `dsh plugin add file:<tgz>` |
| 填 `repository` | 宿主身份解析的硬要求，不是上架要求（详见 README §4） |
