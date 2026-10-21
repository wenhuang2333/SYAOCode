# 开源参考分析 05：goose（Block/AAIF 开源 AI Agent，Rust）

| 项 | 内容 |
| --- | --- |
| 参考目录 | `reference/goose-main` |
| 项目定位 | "native open source AI agent — desktop app, CLI, and API"，Rust 实现的通用 Agent，15+ provider、MCP 连接 70+ 扩展 |
| 许可证 | Apache-2.0（现隶属 Linux 基金会 AAIF） |
| 技术栈 | Rust 2021（tokio + rmcp 官方 MCP SDK + clap + sqlx + axum）；桌面端 **Electron + React**（已非 Tauri） |
| 版本快照 | workspace 1.55.0；GDK 系列 crate 为 0.1.0-alpha |
| 调研日期 | 2026-10-15 |

> 本地快照与网上多数旧文章描述的 goose（goose-server + Tauri + JSONL 会话）已有重大演进：goose-server crate 已删除，会话已迁 SQLite，桌面端迁 Electron，并以 **ACP（Agent Client Protocol）** 作为 CLI/桌面共享内核的边界。本篇以本地源码为准。goose 是同类产品中工程化最成熟的 Rust 实现，其 crate 划分对 SYAOCODE 的包划分、其状态机 loop 对 agent 循环设计有直接参考价值（需做 Rust→TS 形态转换）。

---

## 一、项目概况与 crate 全景

| Crate | 职责 | 对 SYAOCODE 的映射 |
| --- | --- | --- |
| `goose`（单体核心） | agents/状态机/扩展管理、config、permission、session(SQLite)、scheduler、recipe、security、hooks、skills、ACP server | 拆包前的"core+一切"，反面与正面并存 |
| `goose-agent` | **GDK Agent Loop**：通用状态机引擎（machine.rs）、Operation/Inference trait、AgentEvent、subagent 泛型 | `@syaocode/core` 的 loop 引擎 |
| `goose-provider-types` | Provider trait、ModelConfig、Conversation/Message、ProviderError、**prompt 缓存语义**、canonical 模型注册表、GooseMode | `@syaocode/providers` 的类型层 |
| `goose-providers` | 各家 provider 实现 + **声明式 YAML provider**（40+ 家） | provider 实现集 |
| `goose-context-management` | 对话压缩独立库：summarize + **结构化摘要** | `@syaocode/core` 的 context 模块 |
| `goose-mcp` | 内置 MCP server 集合（独立 stdio 进程 `goose mcp <name>`） | 内置工具的 MCP 化 |
| `goose-cli` | REPL + 子命令 | `syao` CLI |
| `goose-sdk`/`goose-sdk-types` | ACP 线协议类型 + uniffi 绑定（Python/Kotlin） | `@syaocode/protocol` + 多语言绑定 |
| `goose-roaming` 等 | iroh P2P 跨设备、下载管理、本地推理 | SYAOCODE 范围外 |

关键架构事实：**内核（goose 核心 + ACP server）多客户端（CLI/desktop/npm 包/uniffi 移动端）**，且以协议（ACP stdio/HTTP）而非 FFI 作为第一边界。goose 正在把单体 `goose` 逐步抽成 GDK alpha crate——**SYAOCODE 一开始就该按 GDK 边界切包**，避免先做单体再拆（goose 的 session 模块 5271 行单体是拆分困难的实证）。

---

## 二、与 SYAOCODE 构件的映射总览

| SYAOCODE 构件 | goose 对应物 | 参考强度 |
| --- | --- | --- |
| Agent Loop（DD-2） | **可重入状态机**（Operation 流水线，每步从持久化会话重建） | ★★★ |
| 权限引擎（DD-5） | 五值 Permission + 持久策略 + 参数哈希 store + 审批即消息 | ★★★ |
| MCP 集成（DD-8） | MCP-first 四类扩展配置（内建工具也 MCP 化） | ★★★ |
| 上下文压缩（DD-6） | 阈值 + 主动/被动双触发 + 结构化摘要 + 工具对摘要 | ★★★ |
| Provider 缓存语义（DD-3/DD-6） | CacheSemantics 按 (provider,model) 声明缓存方言 | ★★★ |
| goal/loop（DD-19） | recipe（参数化模板 + 响应 schema + 重试 + 子目标） | ★★ |
| 会话持久化（DD-7） | SQLite + 双可见性消息 + usage_ledger | ★★ |
| serve/attach + Desktop（DD-17） | ACP stdio/HTTP + Electron spawn `goose serve` | ★★★ |
| 错误体系（第 9 章） | ProviderError 每变体对应状态机处理动作 | ★★ |
| 工程实践（DD-14） | release-plz/GDK 独立发版、MCP 回放测试、自检 recipe | ★★ |

---

## 三、对 SYAOCODE 各构件的具体参考意义

### 3.1 可重入状态机 Loop（映射 DD-2 / FR-002/005/006）——本篇最高价值

goose 不用 while 循环，而是**状态机引擎**（`crates/goose-agent/src/machine.rs`）：`StateMachine` 持有有序 `steps: Vec<Step>`（Operation 或 Inference），`step()` 依序询问每个 op——**第一个返回 Applied 的 op 胜出**并返回 effects；全部 NotApplicable 才落到 Inference（LLM 调用）。`run()` 循环 = `load session → step → apply effects`，**每一步都从持久化会话重新加载**，op 在消息上记录已做过的决策（meta）。

goose 的流水线顺序：`SlashCommand → ToolApproval → Skill → Recipe → ToolExecution → RemainingToolCalls → Subagent → Steer → BangShell → Compaction → ToolPairCompaction → Doctor → Project → Retry → EmptyResponse → StopHook → ExitOnError → MaxTurns → Inference`。

**参考意义**：这一形态对 SYAOCODE 的价值——① **崩溃/取消后可从任意点重建**（对应 NFR-006 异常退出后会话可恢复）；② 审批挂起可恢复（审批 op 下次加载时重新看到 pending 状态）；③ 每个 op 独立可测试（goose 有 state_machine_api 测试）。TS 形态转换：`Operation` 接口（`check(session): Applied|NotApplicable` + `apply(): Effect[]`）+ 联合类型 Effect，保留「step 返回 Applied/NotApplicable + effects」语义即可，不需要 Rust 泛型。SYAOCODE DD-2 的循环伪代码可重构为该管道形态，把 BR-011 循环检测、BR-013 压缩、审批等待都变成 op。

### 3.2 工具调用调度（映射 FR-004 / BR-008/009）

`ops_toolcalling.rs`：所有 Execute 调用**并行 dispatch**（PreToolUse hooks → 执行 → PostToolUse hooks 包装），流合并按完成顺序消费，最终**合批为一条消息的 ToolResponse 块集合**；只执行"曾被广告给模型"的调用（防幻觉工具名）；取消时对未应答调用统一写"Tool call was interrupted"。

**参考意义**：「只执行曾广告过的工具」是 SYAOCODE 工具校验（FR-022）之外的一道便宜防线；「取消统一回填」（BR-009）与 SYAOCODE 已有设计一致，可确认方向。

### 3.3 权限三件套与审批即消息（映射 DD-5 / BR-001）——另一最高价值

- **五值决策枚举**：`Permission { AlwaysAllow, AllowOnce, Cancel, DenyOnce, AlwaysDeny }` + `PermissionConfirmation{PrincipalType}`。
- **持久化策略两层**：`permission.yaml`（三类列表 always_allow/ask_before/never_allow，**分 user 与 smart_approve 两个 principal 域**，文件锁原子写）+ `tool_permissions.json`（**blake3 哈希工具参数**区分"同类调用不同上下文"，支持过期时间）。
- **审批即消息**：审批请求/应答作为 `ActionRequiredData::ToolConfirmation` 消息**写进会话历史**（user_only 可见性）——崩溃可恢复、多客户端天然共享审批状态；应答经 `submit_tool_confirmation()` 或转发给 ACP harness provider。
- **模式**：`GooseMode = Auto / Approve / SmartApprove / Chat`（Chat 模式工具调用被直接跳过并回执）。
- **SmartApprove 判官**：用一个只读工具让模型判定哪些请求只读，工具请求 JSON 显式标注 "UNTRUSTED TOOL REQUEST DATA" 防注入；工具的 `read_only_hint` annotation 自动升级策略。
- **Inspector 链**：SecurityInspector（注入扫描：规则 + ML 分类器双通道）→ EgressInspector → AdversaryInspector（LLM 红队审查）→ PermissionInspector → RepetitionInspector，链式巡检 pending 调用。
- **环境变量黑名单**：31 个危险 env（PATH/LD_PRELOAD/NODE_OPTIONS 等）拒收。

**参考意义**：① 「审批事件进会话日志」与 SYAOCODE DD-2 的 permission.request/result 事件一致，但 goose 更进一步——**审批是消息流的公民**（serve/attach 场景下多客户端可直接看到并应答），SYAOCODE 可采纳为「权限请求持久化为会话事件 + 待答队列」的双形态；② 参数哈希的"总是允许"粒度（同工具不同参数不同授权）是 remember 语义的精细化，值得进 DD-5；③ SmartApprove 的"显式标注不可信数据 + 注入防护提示"是 BR-007 的实现参照（对应 SYAOCODE DP-05 注入检测决策点）；④ inspector 链形态 = SYAOCODE 的 PreToolUse hooks 可组合实现（注入扫描、外发检测、重复熔断各自独立）。

### 3.4 上下文压缩配方（映射 DD-6 / BR-013）

- **阈值**：`min(比例阈值 0.8, 绝对 token 上限 225k/context_limit)`——双条件防"比例到了但绝对量还很大"。
- **主动**（下一次推理前触发）+ **被动**（ContextLengthExceeded 错误触发，同轮限 2 次）双触发。
- **结构化摘要** `StructuredSummary { user_intent, files, errors_and_fixes, pending_tasks, current_work, next_step }`（宽松反序列化 + 模板渲染）；旧消息标记 agent-invisible（**用户侧仍可见**——审计保留）；**逐字保留最近一条纯文本用户消息**并携带 turn-context。
- **工具对分批摘要**：每批 10 个旧 tool request/response 对单独摘要，cutoff 随 context_limit 缩放（10-500 clamp）。
- `provider.manages_own_context()` 逃生门（provider 自管上下文时跳过）。

**参考意义**：与 SYAOCODE DD-6 summarize 策略高度同构，可直接吸收四点——① 结构化摘要字段集（对应 BR-013 保留结构化状态：待办/已改文件/最初目标——goose 多了 errors_and_fixes 与 next_step，值得并入）；② 双阈值；③ 被动触发上限（对应 SY-PRV-004 触发压缩重试一次的加强版）；④ 「压缩只隐藏 agent 视角，用户视角历史完整」的双可见性（与 OpenHands Condensation 同一思想）。

### 3.5 CacheSemantics 缓存方言（映射 DD-3/FR-016、DD-6 缓存断点）

`goose-provider-types/src/cache_semantics.rs`：`CacheSemantics = ExplicitBreakpoints(上限4) | ImplicitTolerant | ImplicitStrict | Uncached` 按 (provider, model) 声明式选择；anthropic 格式在 system/tools/消息尾插 `cache_control` 断点（20 块回看窗口），混合方言（OpenRouter/LiteLLM）单独处理。

**参考意义**：这是 SYAOCODE `capabilities.promptCache: none|explicit|automatic` 协商（FR-014/016）的**工程化升级版**——不止声明能力，还声明**方言**（explicit 有断点数上限；implicit 分严格/宽容两档）。建议 SYAOCODE Capabilities 的 promptCache 字段细化为该四值模型，provider 适配器各自声明。

### 3.6 MCP-first 扩展系统（映射 DD-8 / FR-071 / 概设 ADR-06）

四类 `ExtensionConfig`：**Stdio**（标准 MCP stdio server）、**Builtin**（随二进制捆绑的 MCP server，进程内 duplex 直连或容器内跑）、**Platform**（进程内实现 McpClientTrait 接口，可访问 agent 内部——developer 的 shell/edit/tree 工具就是这种）、**StreamableHttp**（含 UDS/OAuth）。统一面：tools/prompts/resources/**instructions（注入系统提示）**；工具名 `key__tool` 前缀；`available_tools` 白名单过滤；tools/list_changed 版本化缓存；ExtensionLease 会话租约生命周期。

**参考意义**：SYAOCODE 的内置工具（read/edit/bash）可采纳「Platform 进程内 MCP-like client」形态——内置工具与 MCP 工具走**同一个 Tool 接口与执行管线**（对应 SYAOCODE 已有的 mcp__server__tool 命名与统一权限管线，goose 证明可以推得更彻底：连内置工具也是一等扩展）。`instructions` 注入能力（扩展可贡献系统提示片段）是 SYAOCODE 插件能力面（FR-091）的好补充。

### 3.7 recipe → goal/loop 映射（映射 DD-19）

`Recipe`：`title/description/instructions|prompt/extensions/settings{provider,model,temperature,max_turns}/parameters（用户填参，minijinja 模板）/response{json_schema}/sub_recipes/retry{RetryConfig}`；YAML/JSON 双格式 + 校验器 + deeplink；`RecipeOperation` 在流水线中应用 recipe 上下文；**`recipe__final_output` 工具强制按 response schema 产出**；scheduler 按 cron 跑 recipe（创建 Scheduled 会话）。

**参考意义**：recipe = goal 的**静态参数化形态**。SYAOCODE 的 `/goal`（DD-19）可补「目标模板」层：用户保存常用目标（objective + 验收器 + 预算 + 模型档位）为可复用模板；`response.json_schema` 对应 SYAOCODE 验收器的 `custom verifier` 思路——**让产出物本身受 schema 约束**是验收之外的第二重确定性收口。

### 3.8 多客户端与 Desktop（映射 DD-17 / 路线建议）

CLI 与 Desktop 都链接同一 goose 核心；Desktop 的 Electron main `spawn goose serve`（axum HTTP + auth）并以 `@aaif/goose-acp` npm 包管理二进制；`goose acp`（stdio）与 `goose serve`（HTTP）两个入口；ACP server 内 `AgentManager` 管多会话；还能把外部 ACP agent（Claude Code/Codex）**反向包装成 provider**。

**参考意义**：与 ZCode 的 app-server 模式互为印证（协议第一边界、宿主 spawn 内核、桌面是薄客户端）；「外部 ACP agent 包装为 provider」是 SYAOCODE P2 阶段（ACP/A2A）可借鉴的聚合形态。gooseServe 的**就绪探测**（spawn 后探测健康再连）是 Desktop 接入的必要细节。

### 3.9 会话与记账（映射 DD-7 / FR-112）

SQLite（WAL）三表：sessions（含 usage/recipe/model_config/parent_session_id）、messages（JSON 列、`userVisible` 可查询）、**usage_ledger（每模型每调用记账，含 cost_source、is_compaction 标记）**；消息带 `user_visible/agent_visible` 双可见性；子 agent = 独立 Session（SessionType::SubAgent + parent_session_id）。旧 JSONL 自动导入。

**参考意义**：usage_ledger 的「每次调用一行、标记是否压缩调用」比按轮聚合更适合成本审计（对应 FR-112/166）；SYAOCODE 保留 JSONL 为主，但**用量事件应含调用目的标记**（main/compaction/title/subagent），吸收 ledger 思想。

---

## 四、可移植功能清单

| 功能 | 源位置 | 移植到 SYAOCODE | 成本 |
| --- | --- | --- | --- |
| Operation 状态机 + 可重入 step | `crates/goose-agent/src/{machine,operation}.rs` | DD-2 循环重构为管道 | 中高 |
| 审批即消息（ActionRequired 入会话） | `crates/goose/src/agents/ops_tool_approval.rs` | DD-5 + DD-17 待答队列 | 中 |
| 参数哈希权限 store + 过期 | `crates/goose/src/permission/permission_store.rs` | DD-5 remember 精细化 | 低 |
| Inspector 链（注入/外发/重复） | `crates/goose/src/agents/tool_inspection.rs`、`security/` | PreToolUse hooks 预设实现 | 中 |
| 结构化摘要字段集 + 双阈值 + 工具对摘要 | `goose-context-management/src/structured.rs`、`crates/goose/src/context_mgmt/mod.rs` | DD-6 压缩策略 | 低 |
| CacheSemantics 四值方言 | `goose-provider-types/src/cache_semantics.rs` | DD-3 Capabilities 细化 | 低 |
| MCP 四类扩展配置 + instructions 注入 | `crates/goose/src/agents/extension.rs`、`extension_manager/` | DD-8 + FR-091 | 中 |
| recipe 模板 + final_output schema 收口 | `crates/goose/src/recipe/`、`agents/final_output_tool.rs` | goal 模板层 + 验收补充 | 中 |
| usage_ledger 记账粒度 | `crates/goose/src/session/session_manager.rs` | DD-12 UsageTracker | 低 |
| 只执行曾广告过的工具 | `ops_toolcalling.rs`（request_was_advertised） | 工具校验附加防线 | 低 |
| 声明式 YAML provider（40+ 家） | `goose-providers/src/declarative/` | 长尾 provider 接入方式 | 中 |

## 五、可落实的思路（关联 SYAOCODE 文档条款）

1. **DD-2 循环形态决策**：v1.0 可先按现有伪代码实现（简单循环 + 明确的阶段函数），但把「审批等待、压缩、循环检测、steering 注入」建模为可独立测试的阶段函数；v1.1 serve 需要挂起恢复时，再演进为 goose 式可重入管道（从 JSONL 重建）。ADR 记录该演进路径。
2. **DD-5 扩展**：PermissionDecision 的 remember 语义增加参数哈希维度（`remember: session + paramsHash`），"总是允许"默认对同参数生效；权限请求事件持久化为可应答的待答项（serve 多客户端可见）。
3. **BR-007/DD-5 实现**：提供三个内置 PreToolUse hook 预设——注入扫描（规则库起步）、外发检测（secret 模式复用脱敏器）、重复调用熔断（BR-011），用户可组合启用。
4. **DD-6 修订**：压缩摘要结构化为 `{userIntent, files, errorsAndFixes, pendingTasks, currentWork, nextStep}`；阈值 = min(80%, 绝对上限)；被动压缩（SY-PRV-004 后）限 2 次；压缩后用户视图保留完整历史（事件标记法）。
5. **DD-3 Capabilities**：`promptCache` 细化为 `none | explicit{maxBreakpoints} | implicit-tolerant | implicit-strict`，适配器声明方言。
6. **goal 模板**：`/goal` 支持保存/加载目标模板（objective + acceptance + budget + preset），模板可带 response schema；`syao goal run --template <name>`。
7. **DD-12 用量事件**：每次模型调用带 `purpose: main|compaction|title|subagent:<role>` 标记，成本报表按 purpose 分列（配合 OpenHands 的分账字典思想）。
8. **内置工具一等扩展化**：read/edit/bash 与 MCP 工具统一 Tool 接口与执行管线（SYAOCODE 已部分如此），进一步允许内置工具组可被配置禁用/替换（对应 FR-135 --disallowed-tools 的深层语义）。

## 六、不适合照搬与风险

- **SQLite 会话**：goose 因多进程并发与查询需求迁移 SQLite；SYAOCODE v1.0 以 JSONL 为审计基石，保留 JSONL、借鉴其可查询字段与 ledger 设计即可；预留 JSONL→SQLite 导入路径。
- **Electron desktop**：goose 从 Tauri 迁到 Electron 是其生态选择；SYAOCODE 按路线建议维持 Tauri 2 方向，只抄「宿主 spawn 内核 + 就绪探测 + 薄客户端」拓扑。
- **审批双通道**（本地状态机 vs PermissionRouting 转发外部 harness provider）：为聚合 Claude Code/Codex 的特例，SYAOCODE 不做 harness 聚合则不需要。
- **LLM 权限判官/AdversaryInspector**：有延迟与成本，作可选增强（对应 SYAOCODE 的 JEV shadow 思路——先影子后启用），不进 v1.0 核心。
- **Rust 特有设施**（OnceCell 懒启动、fs2 文件锁、uniffi）：TS 侧分别对应懒 await 单例、原子写临时文件+rename、napi/wasm 绑定，只转换不照搬。
- **状态机泛型与 wasm32 兼容层**：TS 中大幅简化。
- **许可证**：Apache-2.0；遵循只参考设计不移植代码。

## 七、关键源码索引

| 主题 | 路径（相对 `reference/goose-main/`） |
| --- | --- |
| 状态机引擎 | `crates/goose-agent/src/{machine,operation,events,subagent}.rs` |
| 流水线装配 | `crates/goose/src/agents/state_machine_builder.rs`、`state_machine/ops_*.rs` |
| 工具调度 | `crates/goose/src/agents/state_machine/ops_toolcalling.rs` |
| 权限 | `goose-provider-types/src/permission.rs`、`crates/goose/src/config/permission.rs`、`permission/{permission_judge,permission_store,permission_inspector}.rs` |
| Inspector/安全 | `crates/goose/src/agents/tool_inspection.rs`、`security/` |
| 上下文压缩 | `crates/goose/src/context_mgmt/mod.rs`、`goose-context-management/src/{structured,summarize}.rs` |
| 缓存语义 | `goose-provider-types/src/cache_semantics.rs` |
| 扩展系统 | `crates/goose/src/agents/{extension.rs,extension_manager/,platform_extensions/}` |
| 会话/记账 | `crates/goose/src/session/{session_manager,legacy}.rs` |
| recipe | `crates/goose/src/recipe/{mod,template_recipe,validate_recipe}.rs`、`agents/final_output_tool.rs` |
| ACP/serve | `crates/goose/src/acp/{server.rs,transport/}`、`ui/desktop/src/gooseServe.ts` |
| 工程实践 | `AGENTS.md`、`RELEASE.md`、`release-plz.toml`、`.github/workflows/`、`Justfile` |
