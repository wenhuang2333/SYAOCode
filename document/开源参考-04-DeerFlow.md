# 开源参考分析 04：DeerFlow 2.0（字节跳动深度研究框架）

| 项 | 内容 |
| --- | --- |
| 参考目录 | `reference/deer-flow-main` |
| 项目定位 | 开源 super agent harness：编排 sub-agents、memory、sandbox、可扩展 skills（"Deep Exploration and Efficient Research Flow"） |
| 许可证 | MIT（ByteDance 及社区） |
| 技术栈 | Python 3.12 后端（FastAPI + LangGraph create_agent）+ Next.js 16/React 19 前端；后端约 75 万行、前端约 9.8 万行 |
| 调研日期 | 2026-10-15 |

> **重要前提**：本地副本是 **DeerFlow 2.0（2026-02 地面重写版）**，官方声明与 v1 不共享代码。经典的 planner/researcher/coder/reporter 多节点研究图在 2.0 已不存在（v1 维护在 `main-1.x` 分支）。2.0 的形态是「**单 Lead Agent（模型↔工具循环）+ 约 20 层中间件链 + task 工具委派子 agent + goal 续跑外环**」。这对 SYAOCODE 反而更有价值：2.0 的 goal 循环、验收检查器、事件流契约、证据引用与 SYAOCODE 的 goal/loop、验收器、AgentEvent、Evidence Ledger 高度同构，且它是一个「研究型 agent」对「编码型 harness」的互补视角。

---

## 一、项目概况

- **服务拓扑**：Nginx → Gateway API（FastAPI + 内嵌 LangGraph 兼容运行时）+ 前端 + 可选 Provisioner。
- **包边界**：`backend/packages/harness/deerflow/`（可独立发布的 agent 框架包：orchestration/tools/sandbox/models/MCP/skills/memory）与 `backend/app/`（网关与 IM 渠道）。单向依赖规则「app imports deerflow, deerflow never imports app」由 CI 测试强制。
- **前后端契约**：`contracts/` 目录存放 12 个跨语言 JSON 契约（运行事件流、子 agent 状态、goal、知识来源等），pytest 契约测试与前端读取同一份 JSON。

**架构核心**：没有显式的多节点图。`create_deerflow_agent()` 按 `RuntimeFeatures` 声明式组装中间件链（ThreadData→Uploads→Sandbox→DanglingToolCall→Guardrail→ToolErrorHandling→DurableContext→SystemMessageCoalescing→Summarization→Todo→Title→Memory→ViewImage→SubagentLimit→LoopDetection→TokenBudget→ModelContentCompatibility→Clarification），所有"分支逻辑"都在中间件的 `wrap_model_call`/`wrap_tool_call`/`after_model` 钩子里实现。

---

## 二、与 SYAOCODE 构件的映射总览

| SYAOCODE 构件 | DeerFlow 对应物 | 参考强度 |
| --- | --- | --- |
| goal/loop 自治（DD-19） | GoalState + 独立小模型评估器 + 无进展签名检测 + 续跑外环 | ★★★ |
| 验收器 / Evidence Ledger（DD-18/19） | acceptance checklist（确定性）+ tool receipts + 引用核验 三层 | ★★★ |
| 事件流契约（DD-2 / FR-174） | `contracts/run_event_stream_contract.json`（冻结契约 + 加法演进） | ★★★ |
| 确定性控制面（概设 7.2） | 守卫中间件超限时「剥离 tool_calls + 强制 finish」的优雅收敛 | ★★★ |
| 人机交互 ask_user（FR-038） | ask_clarification 工具 + END 中断 + 结构化应答回传 | ★★★ |
| 子 agent 委派（FR-103） | task 工具 + SubagentExecutor + delegations 台账 + 限额 | ★★★ |
| 三角色 sota 评审（DD-18 REVIEW） | goal evaluator（独立小模型）+ receipt verification | ★★ |
| 上下文压缩（DD-6） | Summarization 中间件 + 记忆注入保系统提示静态（缓存友好） | ★★ |
| serve/attach 事件订阅（DD-17） | SSE + seq + Last-Event-ID + stream_replay_gap | ★★★ |
| provider 层（DD-3） | thinking 方言适配 + reasoning 契约 + 模型目录 | ★★ |

---

## 三、对 SYAOCODE 各构件的具体参考意义

### 3.1 Goal 循环三件套（映射 DD-19 / BR-050）——本篇最高价值之一

DeerFlow 2.0 的 goal 实现（`agents/goal_state.py`、`runtime/goal.py`、`runtime/runs/worker.py`）：

- **状态**：`GoalState { objective, status:"active", continuation_count, max_continuations(默认8), no_progress_count, max_no_progress_continuations(默认2), last_evaluation }`——**双刹车**：总续跑上限 + 无进展续跑上限。
- **评估器**：图跑完后由**独立小模型（非 thinking）**判定 `GoalEvaluation { satisfied, blocker, reason, evidence_summary, relied_on_assumption }`。评估只看**可见对话证据**（最近 30 条可见消息 + 工具结果缩短摘要，12000 字符预算裁剪），严格 fail-closed："工具成功 ≠ 内容正确；没证据就是 missing_evidence"。
- **无进展检测**：以「最新可见 assistant 文本的 SHA-256 签名」为键判断轮间是否有实质变化——**防止 LLM 改写措辞导致误判有进展**。
- **续跑**：仅 `blocker=goal_not_met_yet` 且未达两个上限才续；续跑注入隐藏 `<goal_continuation>` 消息（`hide_from_ui: true`）；stand_down 原因码 11 个（契约化）；达成写 `goal_outcome` 通道（**仅清 goal 的那次 checkpoint 可写，客户端不可写**）。

**参考意义**：SYAOCODE DD-19 的验收器（确定性优先、语义 judge 次之）之上，DeerFlow 补了三块可直接吸收：① **无进展签名检测**（对应 BR-050「低置信/验收失败视为未完成」的实现层——用内容签名而非模型自述判断进展）；② **双刹车预算**（maxReplans + maxNoProgressReplans 两个独立上限）；③ **goal_outcome 单写者通道**（裁决结果只能由运行时写入，客户端/模型不可伪造）。`relied_on_assumption`（依赖了什么假设）字段也值得进 GoalReport。

### 3.2 三层证据验证（映射 DD-18 Evidence Ledger / FR-164）——本篇另一最高价值

DeerFlow 的证据体系分三层：

1. **tool receipts**：每次工具执行由中间件打 stamp，子 agent 报告中的动作断言必须引 `[rN tool_name]` 执行回执；
2. **引用核验**：父 agent 侧 `verify_receipt_citations`（`receipt_verification.py`）**交叉核验**子报告中的回执引用是否真实存在；
3. **确定性 acceptance checklist**：lead 给 `task` 工具传 `acceptance_criteria`（≤20 条），完成分支由确定性代码检查 `file:<path> exists|non-empty`、`file_written:<path>`、`tests_passed:<command>`（含 shell 结构感知的命令归因、退出码标记解析、pytest/go/maven/gradle/cargo/unittest 摘要形状匹配，**无法证明即 UNVERIFIED fail-closed**），裁决写入 `subagent_acceptance_verdict` 并入 `delegations` 台账。

外加**知识来源契约**（`knowledge_sources.v1.json`）：RAG/检索类工具在 ToolMessage artifact 携带结构化来源（id/provider/title/excerpt/url），前端**只接受 excerpt 与锚点都真实出现在工具结果文本中的来源**（防幻觉引用）。

**参考意义**：这正是 SYAOCODE「Evidence Ledger：每个关键事实、计划步骤、文件变更和验收结果都链接来源」创新方向的完整落地样板。映射：`EvidenceReceipt`（DD-18.2）≈ acceptance verdict；`SourceRef` ≈ knowledge_sources 条目 + tool receipt stamp；「摘要中的事实必须可回溯」（BR-046）≈ receipt citation 核验。SYAOCODE 的验收器叶子类型（command/file_exists/file_contains/custom，DD-19.1）与 DeerFlow 的 `tests_passed:` 命令归因谱系可互补——建议吸收其「命令摘要形状匹配」降低 tests_passed 的误判。

### 3.3 事件流契约先行（映射 DD-2 / FR-174 / NFR-031）

`contracts/run_event_stream_contract.json`：冻结事件名 + 8 个 category（trace/message/outputs/error/middleware/context/subagent/workspace）+ 记录 schema（thread_id/run_id/**seq 严格递增**/event_type/category/content/metadata）+ **兼容规则：消费者必须忽略未知事件与未知字段，只允许加法演进** + 显式 known_gaps 清单（诚实记录当前契约的缺陷）。SSE 断连用 `Last-Event-ID` 续传，恢复不了时发 `stream_replay_gap` 事件让客户端重置。

**参考意义**：SYAOCODE 的 stream-json envelope（FR-174）与 serve 事件订阅（FR-150）应采用同一套纪律：契约 JSON 单源（测试与客户端读同一份）、seq 严格递增、加法演进、known_gaps 显式记录。「补不上就发 gap 事件让客户端全量重置」比假装续传更诚实。

### 3.4 守卫中间件的优雅收敛（映射概设 7.2 确定性控制面 / BR-010）

Guard 类中间件（loop_detection/token_budget/safety/subagent_limit）超限时的动作不是抛异常，而是**剥离该 AIMessage 的 tool_calls、强制 finish_reason="stop"**，让循环自然收敛；停止原因聚合为 `loop_capped/token_capped/safety_capped/...`。

**参考意义**：SYAOCODE 的预算终止（BR-010「预算用尽即停止发起新的模型调用」）与循环检测（BR-011 5 次终止）可采用同款「优雅收敛 + 聚合原因码」而非硬异常——模型收到一个自然结束的回合，历史保持合法，报告里有清晰 stopReason。这直接优化 DD-19 GoalReport.stopReason 的语义。

### 3.5 人机交互：ask_clarification 模式（映射 FR-038 ask_user / DD-17 权限请求）

- 模型调用 `ask_clarification` 工具 → 中间件拦截，生成带 `artifact.human_input_request`（request_id、question、结构化表单字段，支持 text/select/multi_select 等，字段数 ≤16、序列化 ≤16KB）的 ToolMessage → `Command(goto=END)` **优雅中断整轮**；`after_model` 还会丢弃同一条 AIMessage 里的兄弟工具调用（防止问题未答时副作用先执行）。
- 用户回答以隐藏消息 + `additional_kwargs.human_input_response`（request_id 关联）回传续跑；request_id 确定性生成（`clarification:{tool_call_id}`），重试替换而非追加。
- 非交互渠道降级：注入"proceed-without-clarification"指令——低风险可逆则最小假设继续并在终答声明假设；高风险不可逆则输出结构化 BLOCKED。
- **run-context 信任边界**：`non_interactive` 等内部标志仅内部认证调用方可注入，客户端伪造会被清洗。

**参考意义**：SYAOCODE 的 ask_user（FR-038）与权限请求（DD-5 PermissionHandler）可统一为「请求 id + 结构化 payload + 中断 + 应答回传」的协议形态；「兄弟工具调用丢弃」「重试替换不追加」「非交互降级文案策略」三个细节直接可用；「内部标志防客户端伪造」对应 DD-17 的鉴权设计。

### 3.6 子 agent 委派台账（映射 FR-103 / FR-169 / DD-11）

- lead 在一条 AIMessage 里发多个 `task` 调用即并行；`SubagentLimitMiddleware` 按 `max_concurrent`（启动冻结，默认 3）截断超额、按 `max_total_per_run`（默认 6）对照 **`delegations` 台账**（上限 50 条，含 receipt_verdict/acceptance_verdict/stop_reason，终态不可回退）限制总量。
- 每个子 agent 在隔离事件循环跑自己的 create_agent 图（不恢复）；事件以 `values|<ns>` 命名空间发布；结构化结果走 ToolMessage additional_kwargs（11 个键：status/stop_reason/result_brief+sha256/token_usage 等）。
- 路由政策写进 prompt："并行延迟/专家技能/上下文隔离收益 > 启动/重复发现/状态冲突代价才委派"。

**参考意义**：`delegations` 台账 = SYAOCODE 子 agent 的"结构化摘要回传 + 用量汇总"（DD-11）的字段化版本；「台账终态不可回退」「并发容量启动冻结」两个纪律值得写入；委派收益/代价的政策表述可直接进 SYAOCODE 的路由决策文档（DP-01）。

### 3.7 前后端契约与双客户端形态（映射 DD-17 / 概设「一个内核多个客户端」）

- **Gateway（SSE/JSON/RunManager/断连重连）与嵌入式 sync 客户端（进程内、原生对象）刻意不合并**——文档明确论证两种形态的服务语义不同，强行 DRY 会互相污染。
- 三层 stream_mode：`values`（节点级全量快照）、`messages`（token 级增量）、`custom`（自定义事件）；标准 LangGraph SDK 客户端可直连网关。

**参考意义**：这是 SYAOCODE「库形态（@syaocode/* 嵌入）与 CLI/serve 形态分层」的现成论据；v1.0 进程内直连、v1.1 serve 的事件语义分开定义，不强行统一传输。

### 3.8 模型层细节（映射 DD-3 / FR-016）

`create_chat_model` 的 thinking 方言适配（openai_extra_body/anthropic native/vllm 双拼写/ollama）、声明式 reasoning 契约（必思考模型强制开、不支持强制关、受限 effort 词表映射）、流式 chunk-gap 超时默认 240s（推理模型首 chunk 慢）、ModelConfig 元数据与 provider kwargs 分离。

**参考意义**：thinking/reasoning 差异是 SYAOCODE capabilities 协商（FR-014/016、BR-015）最繁琐的部分，DeerFlow 的「方言适配器 + 声明式契约」组合可作为 TS 侧 transform 的需求清单来源。

---

## 四、可移植功能清单

| 功能 | 源位置 | 移植到 SYAOCODE | 成本 |
| --- | --- | --- | --- |
| GoalState 双刹车 + 评估器证据预算 | `agents/goal_state.py`、`runtime/goal.py` | DD-19 GoalSpec/GoalReport 扩展 | 低 |
| 无进展 SHA-256 签名检测 | `runtime/goal.py` | BR-050 实现细节 | 低 |
| goal_outcome 单写者通道 | `agents/goal_state.py` | GoalReport 防伪造 | 低 |
| acceptance checklist（file/tests_passed 命令归因） | `subagents/acceptance_checks.py` | DD-19 验收器实现 | 中 |
| tool receipts + 引用核验 | `agents/middlewares/{tool_receipt,receipt_verification}.py` | Evidence Ledger（DD-18.5） | 中 |
| 事件流契约 JSON 单源 + known_gaps | `contracts/run_event_stream_contract.json` | FR-174/NFR-031 契约管理方式 | 低 |
| 守卫优雅收敛（剥 tool_calls + 聚合原因码） | `backend/AGENTS.md` guardrail caps 节 | BR-010/011 终止语义 | 低 |
| ask_clarification 中断/应答/降级协议 | `agents/middlewares/clarification_middleware.py` | FR-038 + DD-17 权限请求协议 | 中 |
| delegations 台账 + 限额 | `subagents/status_contract.py`、ThreadState | DD-11 子 agent 回传字段化 | 低 |
| SSE Last-Event-ID + stream_replay_gap | `backend/docs/STREAMING.md` | serve 事件订阅恢复 | 低 |

## 五、可落实的思路（关联 SYAOCODE 文档条款）

1. **DD-19.1 GoalSpec 扩展**：新增 `maxNoProgressReplans`（独立于 maxReplans 的无进展上限，初值 2）；评估器输入预算化（可见消息窗口 + 字符上限）；GoalReport 增加 `assumptions[]`（依赖的假设）与 `progressSignature` 字段。
2. **DD-19.2 运行循环**：无进展判定用最新 assistant 内容签名对比；续跑注入的 `<goal_continuation>` 消息带 source 标签（结合 dsh 的归因设计）；goal 裁决结果作为单写者事件（客户端 API 不可写）。
3. **验收器增强**：`tests_passed` 型验收器吸收命令摘要形状匹配（pytest/go/cargo 等输出模式），无法证明时返回 UNVERIFIED 而非 FAIL（对应 BR-050「未验证不能报确定完成」）。
4. **Evidence Ledger 落地（DD-18.5）**：三步走——① 每次工具执行事件带 receipt stamp（序号 + 工具名 + 结果哈希）；② hyaki 的 Brief 中事实条目引用 receipt（`[rN]` 形态），内核核验引用存在性（BR-046 的机械化）；③ Result 的 receipts 与 acceptance verdict 合并持久化。
5. **FR-174/NFR-031**：stream-json 契约抽成独立 JSON Schema 文件入库，测试与文档同源；显式维护 known_gaps；seq 严格递增 + gap 事件。
6. **预算/循环终止语义**：SY-LOOP-001/002/004 触发时优先「剥离待执行 tool_calls + 正常收尾 + stopReason 聚合码」，而非直接中断历史。
7. **FR-038 协议化**：ask_user 与 permission.request 共用「request_id + 结构化 payload + 超时 + 一次性应答」信封；非交互降级文案分低风险（最小假设继续 + 声明）/高风险（BLOCKED）两档。

## 六、不适合照搬与风险

- **体量与耦合**：75 万行后端、IM 渠道/DB 迁移/多实例租约等生产运维面远超可嵌入 TS 库的目标；只取契约与守卫语义。
- **LangChain/LangGraph 生态绑定**：中间件 API、langchain-openai 补丁层（thinking 方言）是 Python SDK 缺陷的 workaround；TS 侧应原生建模（统一 reasoning 参数归一，而非方言补丁层）。
- **单 Lead Agent 单体**：2.0 用一个大 prompt + 巨型中间件链；SYAOCODE 的三角色显式分工在可审计性上更清晰（这也与 SYAOCode.md「三角色分工而非泛化多 Agent」的差异化主张一致），不要跟随「单 agent + 提示工程」路线。
- **v1 深度研究专用件**（planner JSON 计划人工编辑、reporter Markdown 报告）本地不存在；如需该模式参考需另取 `main-1.x` 分支，且其阻塞式 HITL 与 SYAOCODE 自治 goal 定位不同。
- **许可证**：MIT；只借契约形状与算法思路，不移植代码。

## 七、关键源码索引

| 主题 | 路径（相对 `reference/deer-flow-main/`） |
| --- | --- |
| 总架构 | `docs/ARCHITECTURE.md`、根 `AGENTS.md`、`backend/AGENTS.md` |
| agent 工厂/中间件链 | `backend/packages/harness/deerflow/agents/{factory.py,lead_agent/agent.py}` |
| 状态 schema | `agents/thread_state.py` |
| goal 循环 | `agents/goal_state.py`、`runtime/goal.py`、`runtime/runs/worker.py` |
| HITL 澄清 | `agents/middlewares/clarification_middleware.py`、`agents/human_input.py` |
| 子 agent | `tools/builtins/task_tool.py`、`subagents/{executor,status_contract,report_contract,acceptance_checks}.py` |
| 证据/引用 | `agents/middlewares/{tool_receipt,receipt_verification}.py`、`contracts/knowledge_sources.v1.json` |
| 事件契约 | `contracts/run_event_stream_contract.json`、`backend/docs/{STREAMING,RUN_EVENT_STREAM}.md` |
| 模型层 | `models/factory.py`、`models/reasoning.py` |
| 前端流消费 | `frontend/src/core/threads/hooks.ts`、`core/citations/sources.ts` |
