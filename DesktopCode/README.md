# SYAOCode Desktop

> SYAOCode 的桌面端实现。内核复用 `../code/` 的 `@syaocode/*` 包，**不改一行内核代码**。

设计与规格文档仅在本地保留：`doc/DesktopDoc/` 与重构补充文档 `doc/newDesktopDoc/`，不随公开仓库发布。

---

## 1. 这是什么

一个 Electron 桌面应用 + 一套可独立运行的本机 Host：

```
Electron 主进程（壳）
   │  ELECTRON_RUN_AS_NODE=1 拉起
   ▼
Host（Node 进程）── DHP over WebSocket（127.0.0.1 + Bearer）──► 渲染层（React）
   │
   └── @syaocode/core（agent 循环、权限、工具、会话）
```

三条不变量：

| 编号 | 不变量 | 落地位置 |
| --- | --- | --- |
| P1 | 渲染层不碰文件系统、不持密钥 | `apps/desktop/src/preload/index.ts`（窄桥）+ `@syaocode/ui` 零 `node:` 依赖 |
| P2 | 治理状态只有一个所有者 | 单 Host 进程；`packages/host/src/session-registry.ts` |
| P3 | 会话事实源只有一份 | Host 持有投影；客户端只读（`packages/client/src/projection-store.ts`） |

---

## 2. 包结构

| 包 | 职责 | 依赖 |
| --- | --- | --- |
| `packages/dhp` | **DHP 协议**：错误码、版本协商、JSON-RPC 帧、命令信封、投影 fold | 仅 `zod`（零 node、零内核） |
| `packages/host` | **Host 进程**：DHP 服务端、会话注册表、审批代理、Agent 工厂、配置、工作区 | core / node / providers / tools / testing + `ws` |
| `packages/client` | **客户端 SDK**：WS 连接、断线重连、投影 store | `dhp` |
| `packages/ui` | **React 组件**：时间线、输入区、审批卡片、状态栏、i18n | `dhp` + React |
| `apps/desktop` | **Electron 壳**：主进程、preload、渲染层入口 | 以上全部 |

依赖方向（硬规则）：`ui → client → dhp`、`desktop → host → core`。
`ui`/`client` **不得** import `electron` 或 `node:`；`dhp` **不得** import 内核。

---

## 3. 快速开始

```bash
cd DesktopCode
corepack pnpm install          # 首次需下载 Electron 二进制（约 100MB）

corepack pnpm typecheck        # 5 个包全部类型检查
corepack pnpm test             # 协议、Host、客户端、界面和壳层回归
corepack pnpm verify:layout    # 响应式布局真浏览器验证（需本机 Playwright，缺省跳过）
corepack pnpm verify:theme     # 明暗两套主题的 WCAG AA 对比度实测（同上）
corepack pnpm verify:smoke     # 真实 Electron 启动冒烟（electron → host → dhp → renderer）
corepack pnpm verify:docs      # 文档里的数字与引用是否与代码一致（文档缺失时跳过）
corepack pnpm verify:interaction  # 真实窗口交互验证（建会话 / 输入 / 切主题 / 切页 / mock 流式对话）
# 以下需要真实渠道凭据；缺省时脚本跳过并说明
corepack pnpm verify:real-model           # 真实模型：Host 跑完一轮（真实回复 / 流式 / 思维链分流）
corepack pnpm verify:real-window          # 真实模型 + 真实 Electron 窗口
corepack pnpm verify:real-commit-message  # 真实模型生成提交信息（含降级路径）
corepack pnpm verify:real-usage           # 真实用量口径（token / 成本自洽 / 会话一致）
corepack pnpm verify:real-tool-use        # 真实工具调用闭环（模型自主调工具 → 结果回灌）
corepack pnpm verify:real-approval        # 真实审批流（写审批通过前文件未被改动）

# ① 只跑 Host（调试 DHP 协议最方便，不需要窗口）
corepack pnpm dev:host
#    输出：[host] ready url=ws://127.0.0.1:<port> workspace=...

# ② 跑完整桌面应用
corepack pnpm build && corepack pnpm dev:desktop
#    正常应看到 [main] host ready on port <n> 与 dhp: hello；
#    若窗口停在"正在启动本地运行时…"，先看终端有没有 [main] host ready —— 没有就是缺陷 8/9 复发。

# ③ 打包（产出到 apps/desktop/release/）
corepack pnpm package:dir      # 不生成安装包，用于快速验证 asar/资源
corepack pnpm package:mac
```

### 数据目录

默认 `~/.syaocode`。桌面工作区、完整会话历史、渠道和请求账本保存在 `desktop/state-v1.json`，不迁移或修改 CLI JSONL。用 `SYAOCODE_HOME` 覆盖（**这是本项目实现的 OI-D-07**）：

```bash
SYAOCODE_HOME=/tmp/syao-test corepack pnpm dev:host
```

> 未设置 `SYAOCODE_HOME` 且 `os.homedir()` 为空时**直接报错**，不再静默回退到 `.`
> ——旧行为会把会话写进当前工作目录，用户完全不会察觉。

### 离线可用

默认 provider 是 `mock`，**不需要任何密钥**：

```bash
corepack pnpm dev:host
# 另一个终端连上去发消息即可，会看到固定的三条剧本回复
```

接真实模型：`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。也可在“渠道与设置”中添加 OpenAI-compatible 或 Anthropic 渠道、真实模型 ID、容量和价格；API Key 只由 Host 从指定环境变量读取。

---

## 4. 环境变量

| 变量 | 作用 |
| --- | --- |
| `SYAOCODE_HOME` | 数据目录（默认 `~/.syaocode`） |
| `SYAO_MODEL` | 覆盖模型（`provider:model`），优先级最高 |
| `SYAO_PERMISSION_MODE` | 覆盖权限模式（`strict`/`default`/`acceptEdits`/`plan`/`bypass`） |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | provider 密钥 |
| `DEEPSEEK_BASE_URL` / `OPENAI_BASE_URL` | 自定义端点 |

---

## 5. 实现状态（诚实版）

| 能力 | 状态 |
| --- | --- |
| DHP 协议：46 个错误码、版本协商、命令信封六态 ACK、三条投影铁律 | 已实现，23 项测试 |
| Host：会话/事件环/补洞、审批代理、配置分层、工作区围栏、MCP / Agent 群 / Git / 提交信息 | 已实现，269 项测试（含真实 WebSocket 端到端场景） |
| 客户端：连接、抖动重连、投影 store（断档重订阅、隔离过期会话 delta） | 已实现，11 项测试 |
| UI：Markdown 时间线、Composer、审批卡片、状态栏、i18n | 已实现，9 项共享组件测试 |
| 三栏工作台：多项目、多会话、搜索、归档恢复、模型与权限控制、文件预览 | 已实现；启动不自动创建会话，每个会话使用真实 cwd 和独立历史 |
| 用量与账户：请求级账本、10 项 KPI、日期/项目筛选、渠道健康、手动余额与配额 | 已实现；未知数据保持未知，余额和配额明确标注非实时 |
| Electron 壳与页面：窗口、Host 守护、窄 preload、CSP、统计/设置/Agent/MCP 页、会话详情、Git 侧栏、`/` `@` 输入面板 | 已实现，409 项应用测试 |
| 应用启动 → Host ready → 按需建会话 → 流式渲染 → 重启恢复 | 27 项真实 Electron 验收通过 |
| 内嵌终端（PTY） | 未接（`terminal/*` 方法已在协议里，Host 侧未实现） |
| 治理面可视化（任务/预算/审计链） | 接口存在，`governance/*` 返回占位数据（ARF Fabric 未装配） |
| MCP、技能、多代理编排、工作区检查点回滚 | 界面明确标为未接入，不伪造能力状态 |
| 多轮 steer | 明确返回 `rejected` + 原因（不静默丢弃） |
| 自动更新 / 签名公证 | 未做（配置骨架在 `electron-builder.yml`） |

2026-11-06 实测（macOS arm64 / Node 24.18 / Electron 44.10.1）：

- 类型检查、生产构建和 731 项 DesktopCode 测试通过。
- 两个隔离项目完成多会话、严格审批、真实 cwd、模型切换、统计、归档恢复和重启恢复验收。
- 本机临时 SSE Provider 证实请求依次到达 `alpha`、`beta`；第二次请求保留第一次的完整输入与回复。
- 900px 与 1440px 视口均完成截图检查，无页面级横向溢出；renderer page error 和 console error 均为 0。

详细结果见本地 `doc/newDesktopDoc/05-验证记录与交付说明.md`。

---

## 6. 实现过程中发现并修掉的真实缺陷

这些不是"计划"，是写代码时撞上的：

| # | 缺陷 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | `revision` 与 `snapshot.revision` 是两个字段，各自演化 | 客户端读到的 revision 与服务端不一致 → 所有写命令 `stale` | 单一真相：只用 `snapshot.revision` |
| 2 | `applyDelta` 每来一条流式事件就 `revision += 1` | 用户正要点的那张审批卡，因为"期间来了 3 个字"变成 `stale` | revision 只守卫**命令级**状态，流式一致性交给 `seq` |
| 3 | 内核 `session.end` 被当成"会话关闭" | 一轮结束就切断会话 → 多轮对话不可用 | 内核 `session.end` → DHP `turn.end`；`session.end` 只由 `session/close` 产生 |
| 4 | `dhp` 包 import `@syaocode/core` | 浏览器打包时把内核（含 `node:`）一起拖进来 | DHP 与内核解耦，用结构化 `TextBlockLike` |
| 5 | `z.unknown()` 接受 `undefined` | 既无 `method` 也无 `result` 的畸形帧被当成"成功响应" | `.refine(o => 'result' in o)` |
| 6 | `tool.receipt` 未纳入不可丢事件 | 证据链在 UI 侧断链 | 补入 + 测试断言 19 类事件全覆盖 |
| 7 | 本 shell 里 `ELECTRON_RUN_AS_NODE=1` 是**全局设置** | `electron .` 直接以 Node 模式跑，`require('electron')` 返回 undefined，应用"静默不启动" | 启动脚本显式 `env -u ELECTRON_RUN_AS_NODE` |
| 8 | `dev-desktop.mjs` 硬编码 `DesktopCode/node_modules/.bin/electron` | Electron 是 `apps/desktop` 的 devDep，pnpm 隔离布局下根目录没有它 → `spawn ... ENOENT`，应用根本起不来 | 用 `createRequire(appDir/package.json)('electron')` 逐级解析二进制 |
| 9 | 主进程 `spawn` Host 时 `stdio` 没有 `ipc` 槽 | Host 的 ready 帧走 `process.send()`，无 IPC 通道即被静默丢弃 → 窗口永远停在"正在启动本地运行时…" | `stdio: ['ignore','pipe','pipe','ipc']` + `child.on('message')`；另加 30s 未就绪的**大声失败** |
| 10 | 渲染层 `new WebSocket(url, { headers })` | 浏览器 `WebSocket` 第二个参数是**子协议**，传对象直接抛 TypeError；即便不抛也无法带 `Authorization` | 渲染层建裸连接，令牌由主进程 `session.webRequest.onBeforeSendHeaders` 注入（不进 URL、不进渲染层 JS 堆） |

第 7 条尤其值得记：它是**环境**问题，不是代码问题，但表现是"双击没反应"，极难定位。

---

## 7. 与 `../code/` 的关系

- `../code/` 是**只读的内核**。本目录通过 `link:../../../code/packages/*` 引用它。
- 新增能力一律在 `DesktopCode/` 内实现；需要改内核的，先记入 `DesktopDoc/00-基线` §7.3 的缺口清单。
- 本目录的 731 项测试独立运行，不能替代内核回归。
- 2026-11-06 单独复测 `@syaocode/rpc`：21 个测试文件、325 项测试通过；本轮未修改内核。

```bash
cd ../code && corepack pnpm typecheck && corepack pnpm test
```
