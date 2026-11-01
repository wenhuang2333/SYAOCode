# SYAOCode Desktop

> SYAOCode 的桌面端实现。内核复用 `../code/` 的 `@syaocode/*` 包，**不改一行内核代码**。

设计与规格文档：[`../DesktopDoc/`](../DesktopDoc/README.md)（26 份，约 20 万字）。

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
corepack pnpm test             # 91 个测试

# ① 只跑 Host（调试 DHP 协议最方便，不需要窗口）
corepack pnpm dev:host
#    输出：[host] ready url=ws://127.0.0.1:<port> workspace=...

# ② 跑完整桌面应用
corepack pnpm build && corepack pnpm dev:desktop

# ③ 打包（产出到 apps/desktop/release/）
corepack pnpm package:dir      # 不生成安装包，用于快速验证 asar/资源
corepack pnpm package:mac
```

### 数据目录

默认 `~/.syaocode`。用 `SYAOCODE_HOME` 覆盖（**这是本项目实现的 OI-D-07**）：

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

接真实模型：`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。

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
| DHP 协议：26 个错误码、版本协商、命令信封六态 ACK、三条投影铁律 | ✅ 已实现 + 23 测试 |
| Host：会话/事件环/补洞、审批代理（超时 fail-closed、结算幂等、敏感项降级）、配置分层、工作区围栏、差异 | ✅ 已实现 + 40 测试（含 8 个真实 WebSocket 端到端） |
| 客户端：连接、抖动重连、投影 store（断档重订阅、抑制过期 delta） | ✅ 已实现 + 10 测试 |
| UI：时间线、Composer（IME 组合保护）、审批卡片、状态栏、i18n | ✅ 已实现 + 9 测试 |
| Electron 壳：窗口、托盘、单实例、Host 守护、窄 preload、CSP | ✅ 已实现 + 9 静态断言 |
| 应用启动 → Host ready → 渲染层建会话 → 流式渲染 | ✅ 实测通过（见下） |
| 内嵌终端（PTY） | ⛔ 未接（`terminal/*` 方法已在协议里，Host 侧未实现） |
| 治理面可视化（任务/预算/审计链） | ◐ 接口存在，`governance/*` 返回占位数据（ARF Fabric 未装配） |
| 多轮 steer | ⛔ 明确返回 `rejected` + 原因（不静默丢弃） |
| 自动更新 / 签名公证 | ⛔ 未做（配置骨架在 `electron-builder.yml`） |

实测记录（macOS，Electron 44.10.1）：

```
[host] info dhp: listening {"host":"127.0.0.1","port":52567}
[host] ready url=ws://127.0.0.1:52567 workspace=.../apps/desktop
[main] window ready-to-show
```

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

第 7 条尤其值得记：它是**环境**问题，不是代码问题，但表现是"双击没反应"，极难定位。

---

## 7. 与 `../code/` 的关系

- `../code/` 是**只读的内核**。本目录通过 `link:../../../code/packages/*` 引用它。
- 新增能力一律在 `DesktopCode/` 内实现；需要改内核的，先记入 `DesktopDoc/00-基线` §7.3 的缺口清单。
- 内核的 1055 个测试与本目录的 91 个测试**互不影响**。

```bash
cd ../code && corepack pnpm typecheck && corepack pnpm test   # 内核仍然全绿
```
