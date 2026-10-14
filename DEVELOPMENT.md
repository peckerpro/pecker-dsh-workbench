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
| 11 | 打包 | `pnpm pack` | `pecker-dsh-workbench-0.1.0.tgz`，16,301 B；内含 `package.json` / `cordis.patch.yml` / `dsh/index.js` / `lib/client.js` / `lib/mcp-bridge.mjs` / `lib/tool-defs.mjs` / `README.md` / `LICENSE`；**不含 `test/`、不含 `node_modules/`**；sha256 `6ccde4d96f598aa74eedf757c1981f9c0136a8feb95db093a436b33497b427b6` |
| 12 | 客户端 bundle 冒烟 | `node test/client-smoke.mjs` | **20 项通过**：`window.__ModuleLoader__.load` 形态、模块 id = 包名、只 require `react`、`apply()` 交给 `ctx.effect` 注销、注册描述符满足宿主真实校验（GitHub URL / customFrame 布尔 / businessSide / businessWidth∈[0.25,0.7] / icon≤2 字符）、把宿主 `conversation` 节点放进布局、无会话时给引导、不重建聊天容器 |
| 13 | **真实安装** | 见 README §2 的 `dsh plugin --profile web add file:<tgz>` | pnpm 输出 `+ pecker-dsh-workbench file:...tgz`、`Packages: +1`；profile 的 `dependencies` 与 `dsh.profile.bundles` 均新增本包；`profiles/web/node_modules/pecker-dsh-workbench/` 就位（`dsh/ lib/ cordis.patch.yml LICENSE package.json README.md`） |
| 14 | **配置层自检（官方 §8 自测项）** | `dsh --profile web --dump-config` | 产物 `work/dump-config-after-install.txt`：出现 `# == pecker-dsh-workbench` 行，`config.root = !!js dshHomePath('pecker-dsh-workbench')`、`projectDir` 正确；`__dshPluginOwner.workbench: **true**`（整份 dump 里唯一为 true 的插件，说明宿主已把它识别为工作台插件） |
| 15 | 配置覆盖生效 | 在 profile `cordis.patch.yml` 追加同 id 行后重新 `--dump-config` | 仍是 1 行（later wins per row，不是新增重复），`config` 已带 `python: C:\Python313\python.exe`（产物 `work/dump-config-after-override.txt`） |
| 16 | **已安装副本能否被宿主加载** | `PECKER_ENTRY=<installed>/dsh/index.js node --import ./test/host-fallback.mjs test/server-entry-smoke.mjs`、`PECKER_CLIENT=<installed>/lib/client.js node test/client-smoke.mjs` | **28 项 + 20 项全部通过**。关键点：已安装副本的 `node_modules` 里**没有** `@deepseek-ai/*`，测试用与 Desktop `host-module-fallback.mjs` 相同的解析回退才能跑通 → 与重启后的真实加载路径一致 |
| 17 | **0.1.1 加固 + 升级安装** | 重新 `pnpm pack` → `dsh plugin --profile web remove pecker-dsh-workbench` → `add file:…0.1.1.tgz` | 卸载把 bundle 与依赖都摘干净（bundle 列表回到 9 项），再装 0.1.1 成功（`+ pecker-dsh-workbench file:…0.1.1.tgz`、`Packages: +1`）；磁盘上 `node_modules/pecker-dsh-workbench/package.json` = 0.1.1、profile 依赖 spec 指向 0.1.1。**注意**：删除旧 tgz 后直接 `add` 新包会失败（pnpm 要解析 profile 里仍指向旧 tgz 的 spec，报 `ENOENT …0.1.0.tgz`），必须先 `remove` 再 `add`，或保留旧 tgz |
| 18 | 全量测试（0.1.1） | `check-package` / `server-entry-smoke`（带宿主回退）/ `client-smoke` / `bridge-smoke` | **33 + 28 + 20 项通过 + 真实 MCP 全通过** |
| 19 | **只读工具矩阵** | `node test/tool-matrix.mjs --json <out>` | **19/19 通过**（capabilities、roots、assets/versions/tools/skills/jobs/events/recipes/agents 的读操作 + media_probe）。矩阵刻意不碰写/联网/收费工具 |
| 20 | **发现并修掉 2 个平台 MCP 缺陷** | 矩阵首轮 18 项里 `roots` 失败、`skills_inspect` 失败 | ① `roots` 恒报 `'function' object has no attribute 'all'`（局部变量被同名工具函数遮蔽）→ 平台侧改名 `root_map`；② 纯 MCP 无法发现 `skill_id` → `skills_list` 增加可选 `provider_id`。修后矩阵 19/19；平台侧新增 `tests/test_mcp_tools_regression.py`（5 项）锁定 |
| 21 | **自然语言链路端到端（走工作台工具）** | 会话内 `workbench_agents_submit_request` → `workbench_agents_attach_plan(plan_source=dsh_session)` → 执行 | `agentreq_ee2dcd24b6924d3b`：`submitted → planned → executed`；probe `business_status=ok`、`process_exit_code=0`、`qa.full_decode=passed`。这同时补上了"写路径缺证据"这一条 |

## 1.1 重启后暴露的 0.1.1 自身缺陷（0.1.2 已修）

2026-10-14 17:40 用户重启 Desktop（本会话被恢复）。真机立刻证明**我在 0.1.1 里加的"加固"本身是错的**：

```
harness.log: warn pecker-dsh-workbench: ctx.tools 不可用，27 个工具未注册
/status: plugin.version=0.1.1  bridge.state=tools-service-unavailable  registered=false  toolCount=0
         且没有 python -m workbench.mcp 子进程（平台连接被自己的代码关掉了）
```

**根因**：`ctx.inject(deps, cb)` **不是同步调用**。cordis 把它当成一个**子插件**——
`registry.ts`：`inject(inject, callback) { return this.plugin({ inject, apply: callback }) }`，deps 齐了才 apply。
0.1.1 却用"同步没跑到"判定服务不可用，还 `next.close()` 关掉连接 → 27 个工具一个都没注册。
（也解释了 0.1.0 为什么"看起来"正常：它无条件置 ready，回调稍后跑到，工具照样注册成功。）

**0.1.2 修法**
- 状态更新放进注入回调里；等待期间**不关连接**，状态 `connected` + `registrationPending=true`；
- 回调跑到才 `ready` + `registered=true` + `toolCount`，并记 `connectedAt` / `registeredAt`；
- effect 注销时如实退回 `connected` + pending（不再谎报 ready），带可读 `note`；
- 等待超过 30 秒只记一条 warn（`ctx.tools 尚未就绪…连接保持打开`），不放弃、不关连接；
- `/bridge/restart` 先 dispose 注册 fiber 再重连（真重启）；面板按新状态显示（`connected` → "工具待注册（等宿主 tools 服务）"）并展示 `note`。

**新增回归测试** `test/server-entry-deferred.mjs`（**21 项全过**，真平台 MCP + "把 inject 回调存起来"的 mock ctx）：
握手后必须 connected/pending、无 warn 无 error；手动触发回调后必须 ready + 27 个 `workbench_*`；注销后必须如实退回 pending。

**两条纪律教训**
1. **别用 PowerShell 5.1 的 `Set-Content`/`Add-Content` 改带中文的源码**：它按 ANSI 读、按 UTF-8 写 → 双重编码。本次把 `dsh/index.js` 写坏（已 `git checkout` 还原并用编辑工具重做），还让 `package.json` 多了 BOM 导致 `JSON.parse` 失败。
2. pid 追踪要按"端口 + 命令行签名"识别真实进程，否则会杀到已退出的包装进程（本项目已修）。

## 1.2 0.1.3：看板嵌进面板（V3 服务端部分）

面板从"只有状态栏"升级为"**左边看板 + 右边原生会话与状态**"。看板是 `web/` 的嵌入式产物
（React 19 + Tailwind CSS 内联的单文件），由本插件托管；数据经本插件**同源反代**到平台。

| 新增 | 说明 |
|---|---|
| `lib/board.js` | 看板单文件产物（796,083 B），由 `web/` 的 `pnpm build:embed` 生成、`node scripts/sync-board.mjs` 同步进来。**它必须提交进插件仓库**，否则面板打开就是"看板没加载起来" |
| `GET /api/pecker-dsh-workbench/board.js` | 托管上面那份产物（带 mtime 缓存；缺失时 404 并给出生成命令） |
| `/api/pecker-dsh-workbench/platform/*`（**prefix**） | 同源反代到平台 API：透传 Range（视频拖动）、SSE 流式、POST 体；`accept-encoding: identity` 避免解压/content-length 不一致；**不设整体超时**（长连接）；客户端断开时 abort 上游 |

**为什么用 `webServer` 而不是 `connection.fetch`**：后者只支持精确路径，而反代必须是**前缀**匹配
（`@deepseek-ai/dsh-host-webserver` 支持 `exact`/`prefix`，最长前缀优先）。看板路由与反代都用 `ctx.inject(['webServer'], …)`
可选注入：拿不到服务时面板退回"只有状态栏"，并如实说明。

**验证（全部真跑）**
| 测试 | 结果 |
|---|---|
| `test/board-and-proxy.mjs` | **13/13**：`/board.js` 200 且字节数与磁盘一致、`Content-Length` 一致；反代 `/api/health`、`/api/overview` 200；缩略图带 `Range: bytes=0-1023` 返回 **206**；SSE 200 + `text/event-stream` 且收到真实帧（`event: workbench-event`）；平台不可达时 **502 + 可读原因** |
| `test/server-entry-smoke.mjs` | 33/33（新增：2 条 webServer 路由；MCP 失败时不注入 tools，但仍托管看板与反代） |
| `test/client-smoke.mjs` | 20/20（面板仍把原生 `conversation` 节点放进布局、不重建聊天容器） |
| `test/check-package` / `deferred` / `bridge-smoke` / `tool-matrix` | 33 / 21 / 全通过 / 19 项 ok |

**修掉一个会打挂 harness 的缺陷**：反代在客户端断开时 abort 上游，读流的 `AbortError` 原本是
**未处理的 'error' 事件**（真机上会崩掉整个 harness 进程）。现在 `body.on('error')` 收口、只在
"响应未正常结束"时 abort，并且客户端主动断开不再误报 502。这个 bug 是测试真去取消 SSE 流才暴露的。

命令行说明：`DSH Desktop.exe` 是 GUI 子系统程序，直接用 `&`/`Start-Process` 抓不到输出；本机用 `work/dsh-cli.cmd`（`cmd /c` + `ELECTRON_RUN_AS_NODE=1` 转发到 asar 内的 `bin.js`）才是可靠的调用方式。

**为什么需要那行覆盖**：PATH 上的 `python` 是 `D:\anaconda\python.exe`（3.11.9，**没有 `mcp` 包**），而平台业务 MCP 需要 `C:\Python313\python.exe`（3.13.1，有 `mcp`）。若沿用默认 `python`，重启后桥接会如实变成 `unavailable`、0 个工具——那是"正确但没用"的状态，所以必须在 profile 覆盖里钉死解释器。

测试用到的 `node_modules/@deepseek-ai/{schemastery,cosmokit}` 是从 `app.asar` 提取的宿主包副本，仅供本机跑测试；安装到 Desktop 后由宿主 `host-module-fallback.mjs` 提供解析。

## 2. 尚未实测（**只差一次重启**）

包已装进 `profiles/web`、配置层已自检通过、已安装副本在宿主回退下可加载。剩余项都需要 Desktop 重启（profile bundle 只在启动时合成），重启会结束当时的会话：

| # | 项 | 说明 |
|---|---|---|
| 1 | 侧栏模式切换器出现「本地创作」 | 需要宿主客户端加载本插件并完成 `desktopWorkbenches.register` |
| 2 | 面板可进入、不遮挡侧栏/市场/管理入口、窄窗口正常 | 界面边界（规范 §4） |
| 3 | 面板显示平台真实状态 | 平台 API 未起时应显示「未连接」+ 真实原因 |
| 4 | `desktop-workbenches/state.json` 的会话归属 | 工作台模式新建会话后写入 `sessionBindings`；切到「原生会话」不可见、切回来可见 |
| 5 | 属于本工作台的会话里能看到 `workbench_*` 工具并调用 | 桥接本身已在第 7–10 项用真实平台验证；未验证的是宿主加载后注册进 `ctx.tools` 这一段 |
| 6 | 卸载后数据保留 | 规范 §8 |
| 7 | `dsh --profile web --dump-config` 出现本包插件层 | **已完成**（第 14 项），保留在此仅作对照 |

## 2.1 0.1.0 装进真实 Desktop 后已经实测到的（无需重启就发生了）

2026-10-14 16:47 用 `dsh plugin --profile web add file:…0.1.0.tgz` 安装后，宿主**当场加载了插件**（不是等重启）：

| 证据 | 内容 |
|---|---|
| harness 日志 | `%APPDATA%\dsh-desktop\logs\harness.log` 出现 `warn pecker-dsh-workbench: 平台 MCP 不可用，未注册任何工具（startup）：MCP 进程已退出（code=1 …）`（16:49:03）。这是**正确行为**：当时配置里的 `python` 落到 Anaconda 3.11，没有 `mcp` 包 |
| 配置热加载 | 16:50:53 在 profile `cordis.patch.yml` 追加 `python: C:\Python313\python.exe`；**3 秒后**（16:50:56）插件以新配置重新 apply，桥接成功 |
| 真机进程 | `C:\Python313\python.exe -m workbench.mcp` 子进程常驻（PID 32904），证明 stdio MCP 由宿主进程真的拉起来了 |
| 工作台身份落盘 | `%APPDATA%\dsh-desktop\harness\desktop-workbenches\state.json`：`"added":["peckerpro/pecker-dsh-workbench"]`、`"pinned":["peckerpro/pecker-dsh-workbench"]` → 客户端注册成功且已固定在侧栏切换器里；`sessionBindings` 仍为空（还没建过工作台会话） |
| 路由实测 | 带 GUI token 换取的会话 cookie 请求 `GET /api/pecker-dsh-workbench/status` → 200，`bridge.state=ready`、`toolCount=27`、27 个 `workbench_*` 名字齐全、`skipped=[]`、`serverInfo={workbench,1.26.0}`、`protocolVersion=2025-11-25` |
| 平台联通 | 起平台后同一路由返回 `platform.reachable=true`、`health.status=ok`、`dashboard.reachable=true/200`、真实计数 `asset=2228 version=39 job=117 issue=84 tool=4`、`awaiting_review=39`、最近 5 条作业 |

**两个必须记住的运行时事实**：

1. **改配置能热加载，换代码不能**：16:50:53 改 `cordis.patch.yml` 触发了插件重新 apply（配置生效）；但把磁盘上的包换成 0.1.1 之后再改配置文件，`/status` 仍报 `0.1.0`（Node ESM 以同一路径缓存模块，profile bundle 层只在启动时合成）。**所以 0.1.1 必须重启 Desktop 才会生效。**
2. **0.1.0 的 ready 只是"桥接成功"，不等于"注册成功"**：0.1.0 在 `ctx.inject(['tools'], …)` 之后无条件置 `ready`；若 `tools` 服务没就绪，回调不执行但状态照样是 ready。**0.1.1 增加了 `bridge.registered` 字段**，只有真正走到 `tools.register` 才为 true；同时 `/bridge/restart` 改成"真重启"（先注销旧工具、断开旧连接）。重启后请以 `registered: true` 为准。


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
