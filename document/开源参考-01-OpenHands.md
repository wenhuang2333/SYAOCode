# 开源参考分析 01：OpenHands（Agent Canvas 前端仓库）

| 项 | 内容 |
| --- | --- |
| 参考目录 | `reference/OpenHands-main` |
| 项目定位 | OpenHands 自托管"开发者控制中心"前端（Agent Canvas），驱动 OpenHands 内置 agent 或任意 ACP agent |
| 许可证 | MIT（与 SYAOCODE 拟定的 Apache-2.0 兼容） |
| 技术栈 | TypeScript + React 19 + Vite + Zustand + TanStack Query + Electron；Playwright/Vitest/MSW 测试 |
| 规模 | `src/` 约 1400 个 TS/TSX 文件、约 17.6 万行 |
| 调研日期 | 2026-10-15 |

> **重要前提**：本地仓库**不是完整的 OpenHands monorepo**，而是其主仓库中的前端部分，已独立演化为 npm 包 `@openhands/agent-canvas`。Python agent 核心（Agent 循环、llmlib、condenser、runtime 沙箱、EventStream 服务端）位于另一仓库 `OpenHands/software-agent-sdk`，**不在本地**。但 `src/types/agent-server/` 是 Python 侧事件模型的完整 TypeScript 镜像——等于把 OpenHands EventStream 的 wire 契约用 TS 表达了一遍，对 SYAOCODE 的 AgentEvent 设计反而是"异构同构"的绝佳参照。若需 agent 循环本体的一手证据，需另行拉取 software-agent-sdk 仓库。

---

## 一、项目概况

Agent Canvas 是多后端（本地/远程/云）的 agent 控制界面：不执行 agent 动作、不提供沙箱、不持有 LLM 凭证、不跑定时任务——**确定性控制面完全在 Agent Server 一侧，前端只是它的投影**。这一点与 SYAOCODE「内核是权威、CLI/客户端是消费者」的分层（概设 7.1「事件驱动」原则）完全一致。

代码布局：`src/api/`（约 60 个服务适配层）、`src/components/`（路由与功能 UI）、`src/hooks/`（约 130 个 hook）、`src/stores/`（29 个 Zustand store）、`src/types/agent-server/`（**SDK 事件模型镜像，本文档最重要素材**）、`src/mocks/`（MSW）、`tests/e2e/mock-llm/`（mock LLM 测试基建）。

---

## 二、与 SYAOCODE 构件的映射总览

| SYAOCODE 构件 | OpenHands 对应物 | 参考强度 |
| --- | --- | --- |
| AgentEvent 事件流（DD-2） | Action/Observation 判别联合 + BaseEvent + 类型守卫 | ★★★ |
| JSONL 会话恢复/分叉（DD-7） | SessionFrame 信封 + seq 游标 + fork + parent_id | ★★★ |
| 上下文压缩（DD-6） | CondensationEvent「事实日志不动、只改模型视图」 | ★★★ |
| goal/loop 自治（DD-19） | GoalStatus/GoalVerdict + max_iterations 上限 | ★★★ |
| 权限控制面（DD-5） | WAITING_FOR_CONFIRMATION 状态 + respondToConfirmation + security_risk | ★★ |
| 预算与用量（FR-112/166） | usage_to_metrics 按用途分账 + TokenUsage 四桶 | ★★★ |
| ModelRouter（DD-3） | SwitchLLMAction + meta-profile Router | ★★ |
| Skills（FR-101） | microagent→Skills 的 triggers/激活审计/双列表准入 | ★★★ |
| 子 agent（FR-103） | TaskAction/TaskObservation + Planning 子会话 | ★★ |
| serve/attach（DD-17） | 客户端工具模式（action→客户端执行→结果回注） | ★★ |
| 测试基建（11.3） | mock LLM 轨迹服务器 + 零凭证 e2e | ★★★ |

---

## 三、对 SYAOCODE 各构件的具体参考意义

### 3.1 事件流契约（映射 DD-2 AgentEvent）

OpenHands 事件模型的核心结构（`src/types/agent-server/core/`）：

- **顶层联合 `OpenHandsEvent`** = ActionEvent | MessageEvent | ObservationEvent | UserRejectObservation | AgentErrorEvent | ACPToolCallEvent | HookExecutionEvent | CondensationEvent | ConversationStateUpdateEvent | StreamingDeltaEvent 等 16 类。
- **BaseEvent**：`{ id: ULID, timestamp, source: "agent"|"user"|"environment"|"hook" }` —— 用 `source` 四值区分生产者，而非类型层级。
- **Action 与 Observation 成对**：每个 ObservationEvent 带 `action_id` **因果回指**所响应的 ActionEvent；并行 tool call 用 `llm_response_id` 作为同一 LLM 响应内的分组键；ActionEvent 同时保留 `action`（解析后）与 `tool_call`（LLM 原始调用副本，可能含 `security_risk` 等 LLM 附加字段）——**审计时能对照"LLM 原话 vs 内核解析"**。
- **运行时类型守卫**：`type-guards.ts` 提供 `isActionEvent/isCondensationEvent/...` 全套结构性判别，对未知 JSON 做运行时校验而非仅依赖 TS 类型。

**参考意义**：SYAOCODE 的 AgentEvent（DD-2 事件定义节选）可直接吸收四点——① 事件带 `source` 归因；② Action→Observation 因果链字段（对应 SYAOCODE 的 tool_use/tool_result 一一对应 BR-009）；③ 保留原始 tool_call 副本用于审计；④ 为 wire 层（stream-json、serve）配套运行时类型守卫，而不仅是编译期类型。

### 3.2 会话帧协议与恢复（映射 DD-7 / FR-060/061）

- **SessionFrame 信封**（`session-frames.ts`）七种帧：`sync`（声明重放区间）、`durable`（已落盘事件 + `seq` 日志索引）、`transient`（发布但不持久化）、`item_started/item_delta/item_aborted`（流式进度帧，永不重放）、`error`。设计规则："URL 即协议版本，无握手；未知帧类型必须忽略"。
- **恢复 = after_seq 游标**：重连时以 query 参数续传；历史优先走 REST 分页接口预载，WS 只订增量——**"先快照、后增量、按事件 id 去重"的双通道模式**。
- **分叉**：`forkConversation(from_event_id)` + 事件 `parent_id` 构成分叉树。

**参考意义**：这正好是 SYAOCODE DD-7「JSONL 追加日志 + 恢复 + 分叉」在多客户端场景下的传输层答案。`durable`/`transient` 二分对应"哪些事件写 JSONL、哪些只是进度广播"；`seq` = JSONL 行号；`after_seq` 续传 = serve/attach 断线恢复。v1.1 做 serve 时应直接采用此帧语义。

### 3.3 上下文压缩的事件化表达（映射 DD-6 / BR-013）

`CondensationEvent { kind, forgotten_event_ids: EventID[], summary?, summary_offset? }` —— **压缩不是删除历史，而是声明"这些事件 id 从 LLM 视图中遗忘 + 摘要插入位置"**。服务端持有完整事实日志，LLM 拿到的是派生 View。

配套细节：手动压缩的 HTTP ack 只代表"开始"，**完成判定靠事件流**（快照前置 + 等 CondensationEvent + metrics 回落 + 90s 超时，三态结果 compacted/no_change/timeout）。

**参考意义**：SYAOCODE 压缩策略（DD-6 summarize 步骤 5「写入 compaction 条目」）应升级为同型事件：compaction 条目携带被遗忘的事件 id 列表，保证**审计视图（完整日志）与模型视图（压缩后）分离**，且压缩异步操作有三态确认协议。这是「可回放运行」创新方向的直接支撑。

### 3.4 Goal 状态与验收（映射 DD-19 / BR-050）

`GoalStatus { active, status: running|complete|capped|interrupted, iteration, max_iterations, objective, verdict: GoalVerdict | null }`，其中 **`GoalVerdict = { score: 0-1, complete: boolean, missing: string }` 是一个判官对"目标是否可证明完成"的评分**。

**参考意义**：这是 SYAOCODE GoalSpec/GoalReport（DD-19.1）的最接近实现。映射关系：`max_iterations` ≈ maxReplans/续跑上限；`capped` ≈ `budget_exhausted`；`verdict.score/complete/missing` ≈ DP-07 完成度判断题（JEV score 型）的输出。OpenHands 只用 LLM 判官；SYAOCODE 的改进（确定性验收器优先、语义判定只标 `unverified`）是对其缺口的超越，应在设计中坚持。

### 3.5 确认流与风险审计（映射 DD-5 / BR-001/007）

- 流程：服务端确认模式扣下 action → 会话进入 `WAITING_FOR_CONFIRMATION` → 前端展示最近 ActionEvent 及其 **`security_risk`（UNKNOWN/LOW/MEDIUM/HIGH）分级**（HIGH 弹高危警告）→ REST `respondToConfirmation(accept)` → 拒绝产生 `UserRejectObservation { rejection_reason, action_id }` **持久化进事件流**（拒绝来源有二：确认模式或 PreToolUse hook 阻断）。
- 凭证隔离：`RequestSecretAction { name, reason }` —— agent 只能请求 secret，**值从不经过 agent**。

**参考意义**：① "每次裁决（接受/拒绝 + 理由）作为事件入账本"——SYAOCODE 的 permission.request/permission.result 事件（DD-2）已有此设计，OpenHands 验证了其可行性；② security_risk 随事件持久化，是 Evidence Ledger 式审计点，可映射到 SYAOCODE 的 DP-03 风险提升决策点输出；③ OpenHands 只有"会话级开关 + 逐事件应答"，**无 SYAOCODE 规划的 deny>ask>allow 规则优先级与路径围栏**——应保留 SYAOCODE 的确定性控制面，只借鉴其审计形态。

### 3.6 用量分账与预算（映射 FR-112 / FR-166 / BR-048）

`usage_to_metrics: Record<usageId, LLMMetrics>`，key 为任意 id（`"default"`、`"condenser"`、`"profile:<name>:<uuid>"`）——**按用途（主 agent / 压缩器 / 各 profile）分账的度量字典**。`TokenUsage` 含 prompt/completion/**cache_read/cache_write**/reasoning tokens + `context_window` + `per_turn_token`；`LLMMetrics` 累计 cost、response_latencies、token_usages，并对照 `max_budget_per_task`。

**参考意义**：这就是 SYAOCODE 三角色（hyaki/sota/common）成本按角色计量（FR-166、BR-048）的现成模型——OpenHands 已支持多 LLM 实例并存分账，SYAOCODE 只需在其上加 role 维度。`per_turn_token / context_window` 占用率也是 BR-013 压缩阈值（80%）的 UI/监控口径。

### 3.7 模型路由（映射 DD-3 ModelRouter）

`SwitchLLMAction { profile_name, reason }` → `SwitchLLMObservation { active_model }`；meta-profile Router（工具名 `route_task_to_model`）在会话首消息做任务分类路由。

**参考意义**：模型切换本身是**可审计的 Action/Observation 对且带 reason**——SYAOCODE 的 ModelRouter（main/fast/fallback）切换时应发出同型事件进会话日志，而非静默切换。

### 3.8 Skills（映射 FR-101 / DD-11）

- `SkillInfo { triggers?: string[], allowed_tools, disable_model_invocation, type: repo|knowledge|agentskills }`——关键词触发在服务端匹配。
- **激活审计**：`MessageEvent.activated_skills: string[]` 与 `extended_content` 记录"本次消息激活了哪些技能、注入了什么上下文"。
- **准入双列表**：`enabled_skills`（bundled 允许列表）+ `disabled_skills`（用户/项目拒绝列表）。
- 显式调用走 `InvokeSkillAction { name }` 工具。

**参考意义**：与 SYAOCODE DD-11「提示词中只放技能索引、模型按需加载」完全对应，且补强两点——激活审计事件（对应 BR-007 外部内容标记思想）与允许/拒绝双列表准入。

### 3.9 子 agent 与多会话（映射 FR-103 / DD-11）

四层委派：TaskAction 子 agent（`{prompt, subagent_type, description, resume}`，**resume 支持子任务断点续跑**）；Planning 子会话（独立 conversation、独立事件日志与 seq 空间，经 tag 关联父子）；ACP 外部 agent 子进程（JSON-RPC over stdio）；客户端工具委派（agent 发 action → 客户端执行 → 结果 POST 回会话）。

**参考意义**：客户端工具模式是 SYAOCODE serve/attach「宿主侧工具」的现成协议；Planning 子会话的双会话隔离（消息只给 planner、绝不回落 code agent）对 SYAOCODE 的 sota 规划角色独立上下文有直接参照价值。

### 3.10 测试基建（映射 11.3 测试基础设施）

`tests/e2e/mock-llm/scripts/mock-llm-server.py`：OpenAI 兼容服务器内部用 SDK 的 `TestLLM` 播放**脚本化轨迹**；admin API 支持动态切换剧本（`/admin/trajectory/register|activate`）与**回读 agent 发出的全部 completion 请求体**（用于断言）；`ERROR_MAP` 注入 401/429/400/408/503 六类异常。Playwright 编排三进程（mock LLM + 全栈 + auth 静态服），**零真实凭证跑通全链路 e2e**。

**参考意义**：这就是 SYAOCODE 测试计划 11.3 中 MockProvider + "录制回放"的端到端版。SYAOCODE 的 MockProvider（库内）之上，可加一个 `syao mock-llm` 子命令（OpenAI 兼容 mock server + 轨迹剧本 + 请求体回读），用于 CLI 层 e2e 与 CI。LLM 异常六分类归一化（认证/限流/上下文超窗/坏请求/超时/不可用）也与 SY-PRV-* 错误码目录几乎一一对应，可直接对照补齐。

---

## 四、可移植功能清单

| 功能 | 源位置 | 移植到 SYAOCODE | 成本 |
| --- | --- | --- | --- |
| 事件 source 归因 + Action/Observation 因果链 | `src/types/agent-server/core/` | `@syaocode/core` AgentEvent 类型扩展 | 低（纯类型设计） |
| SessionFrame 信封 + after_seq 续传 | `session-frames.ts` | v1.1 `@syaocode/server` 传输协议 | 中 |
| Condensation 事件（遗忘 id + 摘要偏移） | `condensation-event.ts` | DD-6 压缩条目结构升级 | 低 |
| GoalStatus/GoalVerdict 字段集 | `conversation-state-event.ts` | DD-19 GoalReport 状态枚举对照 | 低 |
| usage_to_metrics 按用途分账 | `conversation-state-event.ts` | UsageTracker（DD-12）多 role 维度 | 低 |
| Skills 激活审计 + 双列表准入 | `message-event.ts`、`skills-service.ts` | DD-11 Skills 事件与准入策略 | 低 |
| mock LLM 轨迹服务器模式 | `tests/e2e/mock-llm/` | CLI e2e 测试基建 | 中 |
| 流式槽位（item_started 开槽→delta→durable 精确替换） | `streaming-delta-batcher.ts` | CLI TUI 流式渲染与 JSONL 衔接 | 中 |
| 类型守卫全套 | `type-guards.ts` | wire 层运行时校验模板 | 低 |

## 五、可落实的思路（关联 SYAOCODE 文档条款）

1. **DD-2 事件定义修订**：为 AgentEvent 增加 `source`（agent/user/environment/hook）与 Action→Observation 因果字段；tool.proposed 事件携带 LLM 原始 tool_call 副本（审计用）。
2. **DD-6 压缩策略**：compaction 条目携带 `forgotten_event_ids`；压缩完成判定采用"事件流确认 + 三态结果"，不依赖 HTTP ack。
3. **DD-7 会话日志**：为 v1.1 serve 预留 SessionFrame 语义（durable/transient 分级、seq 游标），JSONL 行号即 seq——v1.0 的 JSONL 格式设计时就应把"哪些事件可跳过重放"想清楚。
4. **DD-19 GoalReport**：状态集对齐 `verified/unverified/blocked/failed/cancelled/budget_exhausted`（SYAOCODE 已有），补 `verdict.missing`（未满足项描述）字段提升报告可读性；DP-07 的 score 输出形状参照 GoalVerdict。
5. **FR-166/BR-048**：UsageTracker 实现为 `Map<role|purpose, Metrics>`，压缩摘要调用单独记账（OpenHands 的 `"condenser"` 桶）。
6. **11.3 测试基建**：新增 `syao mock-llm`（或 `@syaocode/testing/http-mock`）：OpenAI 兼容 + 轨迹剧本 + admin API + 异常注入 + 请求体回读，作为 CLI e2e 的零凭证底座。
7. **模型切换事件**：ModelRouter 切换发出 `model.switched { from, to, reason }` 事件（对应 SwitchLLM 模式），满足 G5 可审计目标。

## 六、不适合照搬与风险

- **本仓库是 React SPA，不是 harness 库**：Zustand/React Query/HeroUI 均 UI 耦合，只能借协议与类型，不能借实现。
- **agent 循环与 condenser 算法本体缺失**：在 software-agent-sdk 仓库（本仓库注释多处引用其 issue 号）；引用文件路径时注意标注"前端镜像"而非实现。
- **确认粒度粗**：无规则引擎与路径围栏，SYAOCODE 的 deny>ask>allow 声明式配置更强，不要被其"会话级开关"带偏。
- **巨型副作用分发器是反面教材**：1400 行的 conversation-websocket-context 单点 switch；SYAOCODE 应做可注册的 typed handler 表。
- **许可证**：MIT，参考思想无障碍；若抄类型定义需保留版权声明（SYAOCODE 原则是不拷贝代码，仅借鉴契约形状）。

## 七、关键源码索引

| 主题 | 路径（相对 `reference/OpenHands-main/`） |
| --- | --- |
| 事件模型镜像 | `src/types/agent-server/core/`（base/、events/、action.ts、observation.ts） |
| 帧协议 | `src/types/agent-server/session-frames.ts` |
| 类型守卫 | `src/types/agent-server/type-guards.ts` |
| WS 消费/seq 游标 | `src/contexts/conversation-websocket-context.tsx`、`src/utils/session-seq-cursor.ts` |
| 压缩等待 | `src/hooks/use-await-context-compaction.ts`、`use-compact-context-action.ts` |
| 确认流 UI | `src/components/shared/buttons/conversation-confirmation-buttons.tsx` |
| Skills | `src/api/skills-service.ts`、`src/types/settings.ts`（SkillInfo） |
| 目标拦截 | `src/hooks/chat/use-goal-interceptor.ts`、`src/stores/goal-store.ts` |
| mock LLM | `tests/e2e/mock-llm/scripts/mock-llm-server.py`、`playwright.mock-llm.config.ts` |
| 架构文档 | `docs/architecture.md`、`docs/ACP_AGENTS.md` |
