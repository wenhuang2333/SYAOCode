# 开源参考分析 02：ZCode（zai-org AI 编程工作台）

| 项 | 内容 |
| --- | --- |
| 参考目录 | `reference/ZCode-main` |
| 项目定位 | 一个仓库同时交付桌面应用（Electron）、Web 界面与终端 Agent CLI/TUI 的 AI 编程工作台 |
| 许可证 | Apache-2.0（与 SYAOCODE 拟定许可证相同，借鉴阻力最小） |
| 技术栈 | TypeScript monorepo（Node 24 + pnpm + Turbo），Vite、Electron 41、Hono、Vitest + WebdriverIO |
| 版本快照 | v3.15.1（README 记录 2026-10-10 更新）；约 7500 个 .ts + 944 个 .tsx 源文件 |
| 调研日期 | 2026-10-15 |

> SYAOCode.md 附录 B 明确将 ZCode 列为参考对象："参考 CLI/TUI/Web/Desktop 共享 runtime 与客户端的架构方向"。本篇是该方向的正面调研结论。

---

## 一、项目概况

三层结构：

- **`apps/zcode-cli/`** —— Agent 内核本体，自身是嵌套的独立 pnpm monorepo（30 个子包）：`@zcode/core`（业务状态机）、`@zcode/contracts`（跨边界契约，零业务依赖）、`@zcode/adapters`（外部 I/O）、`@zcode/bootstrap`（composition root，唯一允许组装 core+adapters 的地方）、`@zcode/tui`、`@zcode/cli` 及 15 个官方插件包。
- **`packages/`** —— 客户端与服务层：`desktop`（Electron）、`web`、`server`（HTTP/WS）、`services`（业务服务与持久化）、`rpc`（自研 VS Code 风格 IPC 框架）、`client`（Agent 客户端 SDK）、`shared`（协议类型，含 zcode-protocol 与 v4）、`provider`/`provider-node` 等。
- **`harness/`、`scripts/`、`docs/`**（500+ 篇按特性组织的设计文档）与架构治理配置。

四层内核架构（`apps/zcode-cli/docs/design/v2/architecture.md`）：**contracts → core → adapters → bootstrap**。core 只依赖 contracts，不 import provider SDK/SQLite/fs/process.env；全部外部 I/O 在 adapters；bootstrap 是唯一组装点。这一分层与 SYAOCODE 概设 7.2 的「core 不依赖任何 @syaocode/* 包，仅定义接口」完全同构，且多了 contracts（纯契约包）这一层，值得吸收。

---

## 二、与 SYAOCODE 构件的映射总览

| SYAOCODE 构件 | ZCode 对应物 | 参考强度 |
| --- | --- | --- |
| serve/attach + 一核多客户端（DD-17、ADR-13） | `zcode app-server --stdio` + TUI/Web/Desktop 三客户端 | ★★★（最直接） |
| AgentEvent / 事件溯源（DD-2） | SessionEvent 分类 + InMemory store + SQLite 持久层 | ★★★ |
| 权限引擎（DD-5） | PermissionService + PermissionBroker 分离 | ★★★ |
| 工具系统（DD-4） | ToolEntry 三类声明 + 执行生命周期 + resultBudget | ★★★ |
| Provider 层（DD-3） | contracts/core/adapters 分层 + AI SDK 作 adapter + 流式重试 spec | ★★★ |
| 上下文/内存治理 | 瞬态事件 turn-window 淘汰（真实内存事故驱动） | ★★★ |
| MCP（DD-8） | core 不 import MCP SDK、adapters 持有、双时代协议协商 | ★★ |
| 包划分与工程治理（DD-14） | architecture-policy.yaml + AST 检查 + knip + 400 行上限 | ★★★ |
| Desktop（路线建议·Tauri） | Electron + utilityProcess Host（拓扑可平移） | ★★ |

---

## 三、对 SYAOCODE 各构件的具体参考意义

### 3.1 「内核即协议 server」的一核多客户端模型（映射 DD-17 / ADR-13）

ZCode 的核心决策：**入口即协议**。`zcode app-server --stdio` 让 CLI 本体成为唯一事实源：

- **TUI**：进程内直连（经 bootstrap 注入的受限回调进 core，订阅 `SessionEventSink`）；
- **Desktop**：Renderer ←MessagePort RPC→ 每窗口一个 Host 进程（Electron `utilityProcess.fork()`）← **stdio NDJSON** → `app-server` 子进程；
- **Web**：浏览器 ←WebSocket `/ws`→ Hono server → 同一 agent service spawn 的进程。

服务端独占 session、模型、模式、消息与运行态；客户端只保留滚动/焦点/草稿等展示态。

**参考意义**：这正是 SYAOCODE ADR-13「内核可嵌入也可服务化，CLI 默认进程内运行」的完整落地样板。SYAOCODE v1.0 的 TUI 进程内直连 + v1.1 的 `syao serve/attach` 可以沿用同一拓扑；协议面先冻结为 NDJSON + schema 校验。DD-17 的 HTTP API 草案之外，应补一份「stdio NDJSON 帧协议」作为 Desktop/宿主接入的第一形态（比 HTTP 更早可用）。

### 3.2 V4「命令收件箱 + 权威投影」读写分离（映射 DD-17 / FR-151/153）

ZCode Protocol V4（`packages/shared/src/zcode-protocol-v4/`）：

- **读路径**：客户端订阅 `conversation/<sessionId>` topic，`subscribe(topic, baseSeq, baseLogEpoch)` → 基线可续接 `delta(fromSeq, toSeq]`，失效则全量 `ConversationSnapshot` + 后续 delta；客户端只按 seq 连续应用，有 gap 就重新订阅收敛。
- **写路径**：所有用户意图走 `v4/command` 信封（稳定 `commandId`、`clientId`、可选 `baseRevision` 做 CAS；重试复用原 commandId）；CLI 侧 CommandInbox 做幂等/epoch/CAS 裁决；ACK 为 `accepted|rejected|stale|duplicate|noop|failed`，**最终状态以带 sourceCommandId 的权威 projection 回流为准**——不允许客户端乐观状态成为事实。
- **两种 delivery profile**：`desktop-continuous`（实时链路）与 `web-remote-replayable`（快照/缺口恢复链路），共享同一投影但恢复语义不得互相扩散。

**参考意义**：这是 attach 模式下多客户端（CLI + Desktop）一致性的成熟答案，直接回答了 SYAOCODE FR-151「多个客户端可观察同一会话、一个权限请求只能有一个有效应答者」的实现路径：命令幂等 id + 服务端裁决 + 权威投影回流。v1.1 只需取其骨架（subscribe/snapshot/delta + command inbox + CAS + interaction request 反向通道），不必复制其 50+ 命令面。

### 3.3 传输无关 RPC 与服务方法级权限（映射 DD-17 / BR-041）

- `packages/rpc` 的核心抽象 `IMessagePassingProtocol { send, onMessage }`——传输无关，Electron IPC/MessagePort/WebSocket/子进程 socket 皆可接；一套服务定义（`ServiceCollection` + `services.exposeOnChannelServer`）跑在任意传输上。
- 连接分级：`/ws` 永远是 replayable 角色；`/ws/host` 必须先以一次性 capability token 才能以 trusted-host 接入，非信任连接对敏感服务方法**强制拒绝**；每个连接套 `ConnectionScope`（connectionId + clientMode + role）控制订阅替换与隔离。
- **workspaceKey 进程隔离**：`workspaceIdentity || workspacePath` 作为唯一身份 key，一个 key 最多一个 agent 进程。

**参考意义**：BR-041「serve 默认只绑定回环、令牌鉴权」之外，ZCode 补了三块：连接角色分级（对应 SYAOCODE 的 attach 只读观察者 vs 应答者）、方法级最小权限覆盖、按工作区隔离进程。SYAOCODE serve 的多工作区管理（FR-150 范围外但 Desktop 需要）可照此设计。

### 3.4 SessionEvent 事件溯源 + 双存储（映射 DD-7 / FR-060）

- 事件分类：session/turn/message（model_request/model_streaming/model_complete/model_error）/tool（tool_call_scheduled/started/result/error）/permission（permission_requested/resolved/denied）/state（compact_boundary/rewind_triggered/checkpoint_created）/subagent/system，事件带 sessionId/turnId/traceId/sequenceNumber。
- **双存储**：进程内 `InMemorySessionEventStore` 负责 seq 分配；SQLite 持久层三表 `session/message/part`（文本、reasoning、tool、patch、compact 都是 part）——「可索引字段做列、业务 shape 放 JSON」。
- **瞬态事件保留策略（turn-window 淘汰）**：瞬态事件集（model_streaming、tool_call_progress 等）按 turn 分桶，turn 结束后滞后一个 turn 淘汰 + 120s 时间兜底；sealed turn 的 model_request 瘦身（去 messages 补 messageCount）。这是**真实内存事故驱动**的设计（spec 记录了 214 轮 99 次 compact 堆从 102MB 涨到 264MB 的案例）。
- 冷恢复：从持久化消息合成事件（`transcript-hydration.ts`）；rewind 不删历史、追加新状态；fork 走 parent_id。

**参考意义**：SYAOCODE 的 JSONL 会话应吸收两点——① **事件分级（durable vs transient）**：流式 delta 类事件不进 JSONL（或单列 transient 文件），避免日志无限膨胀（对应 NFR-003 十万条事件恢复 ≤3s 的保障手段）；② 「事件是事实、消息是投影」的双轨思想可与 JSONL 并存：JSONL 为审计事实源，内存/查询投影可重建。

### 3.5 PermissionService/PermissionBroker 分离（映射 DD-5 / BR-001/021）

- **PermissionService**（同步）：按 mode + tool capability + project rules 做 allow/ask/deny 判定。
- **PermissionBroker**（异步）：与客户端协商，请求带完整审计字段（requestId/trace 链/toolName+input/mode/ruleId/reason/riskLevel/sideEffectScope），返回 `allow|deny|modify|escalate` + 可选 `permissionUpdates`（project 级新增规则，即"本项目始终允许"）；**无 broker 默认 fail-closed deny**（headless 不悬挂）；`ask` 不是错误态；权限事件全部落事件流。

**参考意义**：与 SYAOCODE 权限引擎高度同构，补强两点：① `modify`（审批时替换完整工具输入）是 SYAOCODE PermissionDecision 枚举没有的能力；② 「审批响应带回规则更新」（对应 DD-5 的 `remember: once|session|project`）的字段化设计。fail-closed 默认与 BR-042「非交互 ask 一律 deny」一致。

### 3.6 工具契约的三类声明（映射 DD-4 / FR-020）

ToolEntry 分三段：模型可见投影（name/description/capability/inputSchema/outputSchema，Zod 单源派生 provider 中立 JSON Schema）+ runtime 声明（readOnly/destructive/**sideEffectScope: none|workspace|git|network|system|session|userInteraction**/concurrentSafe/timeout/cancellation/**resultBudget**）+ 权限声明（riskLevel/needsApproval/denyPriority）。执行生命周期：`parseInput → backfillObservableInput → validateInput → checkPermissions → call → recordState → serializeResult → renderProjection`；scheduler 按 sideEffectScope 决定并发；**大结果落 ToolArtifactStorePort、模型只收摘要 + 引用**。

**参考意义**：`sideEffectScope` 枚举比 SYAOCODE 的 risk 五档（read/write/exec/network/meta）对并发调度更直接可用；`resultBudget` 超限 artifact 化是 BR-012 截断规则的升级版（截断 → 落盘引用）。建议 SYAOCODE Tool 接口（DD-4）吸收这两个字段。

### 3.7 Provider 层与流式重试（映射 DD-3 / BR-014）

- 分层：contracts（ModelCapability + provider 中立 request/result）→ core（模型 loop，不 import SDK）→ adapters（**Vercel AI SDK** 作为运行时依赖）→ bootstrap（工厂）。所有 provider 差异集中在 `ProviderTransform`（消息清洗、tool call id、cache marker、reasoning 参数）。
- **流式错误重试 spec**（`docs/design/v2/model/stream-error-retry.md`）：retry budget 分档；"retry-safe 前奏事件"暂存（start/空 delta 失败即丢弃）；非空 text/reasoning/tool_call 是可见边界，越界失败交给 core stream recovery（从断点新开请求并丢弃 partial tail）；SSE 用事件间隔 idle timeout（默认 600s，重试递增）而非总超时；声明式 `selectionFallback` 模型降级**必须先收口已接受工具**。
- 用量：`ModelUsage` 归一化（含 cache read/write、reasoning）；`model_usage` 表是唯一计费事实源。

**参考意义**：这是全网少见的细粒度流式恢复 spec，SYAOCODE DD-3 的「流中断且尚无已提交的工具调用时可重试」条款可以细化为 ZCode 的三层语义（前奏丢弃/可见边界/recovery anchor）。「AI SDK 作为可选 adapter 而非 core 依赖」的取舍与 SYAOCODE「模型中立、零运行时依赖偏好」一致。

### 3.8 架构治理工具链（映射 DD-14 / NFR-021）

`architecture-policy.yaml`（模块清单 + 全局规则 maxFileLines:400 / forbidCycles / forbidDeepImports + 带 reason 的例外白名单）+ `scripts/architecture/`（TypeScript AST 解析 import 图做检查，进 pre-push）+ `dependency-graph.mmd`（自动生成的文件级依赖图）+ `knip`（未使用依赖/导出检测）+ **spec-first 流程**（行为改动先改 spec，spec 记录"实现核对"日期与验证 case 矩阵）。

**参考意义**：SYAOCODE 作为多包库 + CLI，NFR-021（循环依赖为 0）需要机械化保障。这套「policy 即配置、检查进 pre-push」的投入产出比极高，可在 M0（WP-0.3 workspace/CI/质量门）直接引入。

---

## 四、可移植功能清单

| 功能 | 源位置 | 移植到 SYAOCODE | 成本 |
| --- | --- | --- | --- |
| app-server stdio 接入模型 | `apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md` | `syao serve --stdio`（v1.1）+ Desktop sidecar | 中 |
| 命令收件箱 + 权威投影 | `packages/shared/src/zcode-protocol-v4/{command,snapshot}.ts` | attach 多客户端一致性协议 | 中高 |
| 传输无关 RPC 抽象 | `packages/rpc/src/protocol.ts` | `@syaocode/server` 传输层（MessagePort/WS/stdio 复用） | 中 |
| 瞬态事件 turn-window 淘汰 | `docs/design/v2/session-event-store-retention.md` | JSONL 会话的内存治理与 NFR-003 保障 | 低 |
| PermissionBroker 契约（modify/规则更新） | `docs/design/v2/permission-broker.md` | DD-5 PermissionDecision 扩展 | 低 |
| ToolEntry 三类声明 + resultBudget | `packages/contracts/src/tools/` | DD-4 Tool 接口扩展 | 低 |
| 流式重试三层语义 | `docs/design/v2/model/stream-error-retry.md` | DD-3 withRetry 细化 | 低 |
| architecture-policy + AST 检查 | `architecture-policy.yaml`、`scripts/architecture/` | 仓库工程治理（M0 引入） | 中 |
| workspaceKey 进程隔离 | `docs/zcode-protocol.md` | serve 多工作区管理 | 低 |

## 五、可落实的思路（关联 SYAOCODE 文档条款）

1. **DD-17 补 stdio 形态**：serve 除 HTTP/SSE 外定义 `syao serve --stdio`（NDJSON 帧、LF 分帧、stdout 严格协议通道、console 改道 stderr、EOF 状态机），作为 Desktop（Tauri sidecar）与编辑器宿主的最低成本接入方式。Desktop 阶段（路线建议的 Tauri 2）可用 sidecar/utility process 等价替换其 Electron Host 拓扑，协议边界不变。
2. **FR-151 实现路径**：attach 客户端命令一律带幂等 commandId + 服务端裁决 + 权威投影回流；只读观察者与应答者以连接角色区分（对应 BR-041 的令牌分级）。
3. **DD-2/FR-060 事件分级**：AgentEvent 定义 transient 子集（text.delta/tool.progress 类不落 JSONL），`--verbose` 或调试模式可选落盘；防止长会话 JSONL 膨胀拖垮 NFR-003。
4. **DD-4 Tool 接口**：新增 `sideEffectScope` 与 `resultBudget` 字段；工具大输出走 artifact 存储 + 摘要引用。
5. **DD-5 扩展**：PermissionDecision 增加 `modify`（替换输入后重新走校验与权限判定）；审批响应可携带规则更新（remember 的字段化）。
6. **DD-14 工程门禁**：M0 建立 architecture-policy（模块清单 + 依赖方向 + 文件行数上限 + 例外白名单），用 AST import 检查进 pre-push；配合 knip 与 API Extractor（已在 NFR-008）。
7. **provider 能力差异建模**：把 DeepSeek/GLM 等模型的 reasoning 兼容特判改造为「capabilities 标志 + 可插拔 transform」，不按 modelId 前缀分支（ZCode 的反面教训）。

## 六、不适合照搬与风险

- **双协议并存是演进包袱**：legacy zcode-protocol（4339 行）与 V4 并存，spec 明令旧面只减不增。SYAOCODE 应从第一天只定**一个版本化 envelope**（schemaVersion + seq），吸取教训。
- **深度 provider 兼容特判**（按模型名写死 reasoning 回放规则）：如上，改为能力建模。
- **巨型企业特性**：插件商店、飞书群协作、off-peak 任务、订阅配额、手机远控 relay 等与 harness 内核无关。
- **超大文件反例**：`zcodeAgentService.ts` 6530 行、`desktop/src/host/index.ts` 3103 行——service 聚合层失控的教训；SYAOCODE 的 `maxPublicMethods` 类约束应更早执行。
- **Electron 而非 Tauri**：进程模型不可直接照搬，但「每窗口一个 Host、Host 持 agent 子进程、renderer 只走 RPC」的拓扑与 UI 框架无关。
- **许可证**：Apache-2.0 与 SYAOCODE 相同；即便如此仍遵循「只参考思路不拷贝代码」原则（R-15）。

## 七、关键源码索引

| 主题 | 路径（相对 `reference/ZCode-main/`） |
| --- | --- |
| 内核四层架构 | `apps/zcode-cli/docs/design/v2/architecture.md` |
| app-server 协议 | `docs/design/v2/zcode-protocol-agent-server.md`、`packages/bootstrap/src/app/create-app.ts` |
| V4 协议 | `packages/shared/src/zcode-protocol-v4/{command,snapshot,transport}.ts`、根 `docs/zcode-protocol.md` |
| RPC 框架 | `packages/rpc/src/protocol.ts`、`packages/services/src/accessor.ts` |
| 会话持久化 | `docs/design/v2/session-persistence.md`、`session-event-store-retention.md` |
| 权限 | `docs/design/v2/permission-broker.md`、`packages/contracts/src/interfaces/permission.port.ts` |
| 工具契约 | `packages/core/src/tool/types.ts`、`packages/contracts/src/tools/contract.ts` |
| 流式重试 | `docs/design/v2/model/stream-error-retry.md` |
| MCP | `apps/zcode-cli/docs/design/v2/mcp.md`、`packages/adapters/src/mcp/` |
| 桌面进程模型 | `packages/desktop/src/host/index.ts`（文件头注释）、`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` |
| 治理 | `architecture-policy.yaml`、`scripts/architecture/`、`knip.json` |
