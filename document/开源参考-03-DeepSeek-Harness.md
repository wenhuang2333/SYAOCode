# 开源参考分析 03：DeepSeek Harness（dsh）

| 项 | 内容 |
| --- | --- |
| 参考目录 | `reference/deepseek-harness-master` |
| 项目定位 | DeepSeek 官方开源的插件化 agent harness（命令 `dsh`），构建于「一切皆插件」架构（底层 vendored Cordis 框架） |
| 许可证 | MIT |
| 技术栈 | TypeScript（Node 22），Cordis 插件框架，pnpm workspace 约 58 个包组；`native/` 为 Landlock/ flock 原生绑定 |
| 版本快照 | developer preview（0.2.x alpha 系列） |
| 调研日期 | 2026-10-15 |

> SYAOCode.md 附录 B 明确参考对象："参考插件化边界、durable sessions、goal/schedule/preset/guard 的模块分工；不照搬源码或不兼容设计"。另外：`reference/DSH缓存分析+优化器/deepseek-harness/` 内还有一份 dsh 的源码快照（0.2.1-alpha.3），两处内容同源，本篇以 `deepseek-harness-master` 为主。
>
> **安全姿态提示**（其 SAFETY.md 自述）：实验性、未做安全审计；沙箱/审批"降低风险但不保证隔离"。参考时应取其机制设计，不取其安全承诺。

---

## 一、项目概况

**「插件化 harness」的含义**：harness 本体只提供可插拔的骨架——agent 循环（agent-loop）、模型适配器（llm）、工具注册表（tools）、会话日志（session）全部是插件，**没有可打补丁的特权核心**。仓库约定「Plugins, not loop changes」：新行为必须走文档化扩展点，改 loop 本身要更新架构文档。

monorepo 关键包组（与 SYAOCODE 关注点直接相关）：

| 包组 | 职责 |
| --- | --- |
| `packages/core/` | agent/session/tools/system-prompt/scope（内存态核心） |
| `packages/goal/` | session goals（goal + tool-goal + command-goal + goal-round-driver 四分包） |
| `packages/schedule/` | scheduled follow-ups（Host 级定时提醒） |
| `packages/preset/` | agent composition（每个 agent 的子插件组合） |
| `packages/guard/` | loop/tool guards（循环卫生守卫：timeout-policy + repeat-tool-reminder） |
| `packages/session/` | durable sessions（持久化缝 + JSONL 后端 + 投影 + 格式迁移链） |
| `packages/llm/` | provider 中立模型调用 + DeepSeek 适配器 + retry + token-meter |
| `packages/sandbox/` | read-only / workspace-write / danger-full-access 三档沙箱（Linux Landlock、macOS Seatbelt、Windows restricted token） |
| `packages/interaction/` | user-approval（审批缝）、permission-presets、user-questions、commands |

运行形态：`dsh web`（浏览器应用）、`dsh --profile headless "task"`、`--profile sdk`（JSON-RPC stdio）、`--profile acp`。

**能力缝（Capability Seam）三角色**是插件化边界的核心方法学：Service Definition（声明接口）/ Service Provider（实现）/ Consumer（使用）分包，**扩展插件只依赖 Service Definition，绝不依赖具体 Provider**。这一纪律对 SYAOCODE 的包划分（core 定义接口、适配包实现）是直接印证。

---

## 二、与 SYAOCODE 构件的映射总览

| SYAOCODE 构件 | dsh 对应物 | 参考强度 |
| --- | --- | --- |
| goal/loop 自治（DD-19） | goal 四分包：持久相位/激活分离、CAS、预约-准入预算、权威检查 | ★★★（最深入） |
| JSONL 会话（DD-7） | durable session：不可变 generation + lease + torn-tail 修复 + 迁移链 | ★★★ |
| 插件/包边界（概设 7.3） | 能力缝三角色 + 状态/工具/命令/驱动四分包 | ★★★ |
| 权限引擎与审批（DD-5） | user-approval（ask/never + fail-closed）+ permission-presets 捆绑 | ★★ |
| guard（BR-011 循环检测） | 软硬护栏分离（提醒 vs 超时） | ★★★ |
| 三角色 agents（DD-18） | preset = 子插件组合（模型/工具/prompt 组合） | ★★ |
| 事件词汇表（DD-2） | SessionEventMap（turn/step/message/tool/goal/schedule/approval…） | ★★★ |
| CLI 非交互（FR-131/174） | headless profile：NDJSON 事件流、--session-id 续接、退出码 | ★★ |
| 沙箱（P2） | 三档沙箱模式 + native Landlock | ★★ |
| 评测纪律（11 章） | benchmarks 按用户路径组织 + 全合成语料 + 性能门禁 | ★★ |

---

## 三、对 SYAOCODE 各构件的具体参考意义

### 3.1 goal 子系统（映射 DD-19 / FR-170 / BR-050/051）——本篇最高价值

dsh 的 goal 拆成四个包：**goal（状态服务）+ tool-goal（模型工具）+ command-goal（人类 `/goal` 命令）+ goal-round-driver（自动续跑驱动）**。关键机制：

1. **持久相位与运行激活分离**：`GoalPhase`（active/paused/blocked/complete，durable）与 `GoalActivation`（armed/disarmed，**进程本地、永不持久化**）分离。session resume/fork/重启后一律 disarm，必须人工 resume 才重新武装自治——「重启后不自动恢复自治」是安全默认。
2. **CAS 变更 + 全量快照事件**：`GoalRef { id, revision }` 拒绝 stale 覆盖；每次变更追加 `goal/change` durable 事件携带完整 post-mutation 快照；fold 严格校验（拒绝不连续 revision、非法相位迁移）。**会话日志是 goal 状态唯一持久权威**。
3. **预算两阶段计数**：driver 采用「预约（reserve）→ 准入（admitted）」——只有真正被 admit 进入模型历史的 goal-sourced 消息才把 `roundsStarted +1`，取消/竞态不虚耗 maxRuns。
4. **权威检查而非自由工具**：`requireDirectHuman()` 要求当前根 turn 内存在 host 证明的人类消息才能 edit/pause/resume/create；`completionAuthority()` 允许 direct-human 或"恰是当前 goal round"；**模型不能 resume 一个 paused goal**；`blocked` 需连续 3 轮无进展（默认 `blockedAfterConsecutiveRounds: 3`）防止模型过早自报阻塞；block reason 规范为 lower-kebab-case 稳定码。
5. **驱动器竞态纪律**：仅在 agent 整体 idle（含 subagent 后代 settle）时触发；`agent/pre-step` 监听器双重核对；排队前 flush 会话并复查 revision；fail-closed teardown（关准入、disarm 全部 live goal、取消在途工作）。
6. **已知缺口（dsh 自述）**：无独立验收器（complete/blocked 是模型自报 + 工具侧门槛）、预算只计 round 数不计量 token/费用/时长。

**参考意义**：SYAOCODE DD-19 的 GoalSpec 有验收器、有多维预算，恰好在 dsh 的缺口之上；但 dsh 的**状态机细节是源码级模板**：① activation 不持久化（SYAOCODE Loop 恢复语义应照抄：loop 暂停态跨重启后需人工 resume）；② 预约-准入两阶段计数修正 SYAOCODE「续跑上限默认 5 次」的计数语义（只计真正执行的轮次）；③ `blocked` 的连续无进展阈值与稳定 reason 码对应 BR-051「连续失败 3 轮暂停」；④「模型不能自行恢复被暂停的自治」应写入 SYAOCODE 业务规则（对应 BR-051 的补强）。

### 3.2 durable session（映射 DD-7 / FR-060/061 / BR-016）

- **分层**：`core/session`（内存 append-only 事件日志 + 广播）与 `session/session-persistence`（持久化缝：create/open/stat/list/flush）+ `session-persistence-jsonl`（后端）。核心不变式：**"Model-visible means logged"——模型看到的每个输入都必须能从日志重建**。
- **JSONL 后端关键设计**：不可变的 canonical generation 文件名（`session.vN.jsonl.zstd`）；写升级时**独占地发布带版本号的后继文件，绝不重命名/覆盖已提交代**；内核级跨进程单写者租约（POSIX flock via native addon）；zstd 压缩。
- **fail-closed 校验**：`validateStoredEvents` 拒绝未知事件类型（除非 `ignorable: true` 信封标志）；`assertVersion` 拒绝非当前格式版本。
- **崩溃修复**：resume 时通过写句柄追加**合成闭包**——为撕裂的 tool/call 补 `tool/result`（`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 两档）、补 `step/end`、`turn/end {interrupted}`；撕裂尾在首次新 append 前被持久截断。
- **checkpoint 策略**：每次模型请求和顶层工具副作用前 flush（durability barrier；append 是 best-effort）。
- **投影缝**：`session-projection`（`ProjectionDefinition { key, stateSchema, init, apply, wire, stateVersion }` 增量 fold）+ write-behind 检查点缓存供 UI/查询消费。
- **格式迁移链**：`session-format-v0-to-v1 … v3-to-v4` 每包只做一步邻接迁移 + 静态迁移目录。

**参考意义**：这是 SYAOCODE DD-7「JSONL 追加、恢复、锁、损坏隔离」的最完整同类实现，可直接移植的清单——① 合成闭包修复（对应 DD-7「末尾若存在没有 tool_result 的 tool_use，合成 SY-LOOP-003 结果」，dsh 多给了 `TOOL_OUTCOME_UNKNOWN` 的细分）；② 事件 `ignorable` 标志实现「未知非关键事件可忽略、关键事件不兼容失败关闭」（对应 FR-153 的事件兼容规则）；③ 「模型可见 ⟺ 已落日志」作为不变式写进 SYAOCODE 业务规则（BR 族补强，支撑 G5 审计目标）；④ generation 文件 + 独占后继发布，比「单文件追加 + 锁」更能防写放大撕裂（SYAOCODE 可简化为版本化后缀文件）。v1.0 不必建迁移框架，用「schemaVersion + 未知事件拒绝 + ignorable」即可。

### 3.3 事件词汇表（映射 DD-2）

`SessionEventMap`（`packages/core/session/src/types.ts`）：`turn/start`、`turn/end{reason}`、`step/start`、`step/end`、`user/message`（含 **source 归因：user/goal/schedule/tool-goal/repeat-tool-reminder**）、`developer/message`、`system/message`、`assistant/message`（内嵌紧凑流 + usage）、`assistant/attempt`、`tool/call`、`tool/result`、`goal/change`、`schedule/change`、`permission/preset`、`approval/asked/decided` 等。

**参考意义**：① `step` 层（turn 内的模型调用步）是 SYAOCODE 事件粒度中缺失的一层——SYAOCODE 有 turn.start/turn.end，补 step 级（每次模型调用 + usage）有利成本归因；② user 消息的 **source 归因**（人类/goal 续跑/loop 触发/守卫提醒注入）对可审计性价值极高，SYAOCODE 的合成消息（压缩摘要、goal 续跑、循环检测提示注入）都应带 source 标签。

### 3.4 工具管线与 guard（映射 DD-4 / BR-011/021）

- 固定管线：`tools/pre-execute`（可扩展 allow/deny/ask waterfall）→ 注册的**单调 guard**（`ctx.tools.guard()`，返回 reason 即拒绝，**后置监听无法翻案**）→ `tools/execute`（around-dispatch：超时/重试包装）→ `tools/post-execute` → `tools/result`。
- guard 包的两个循环卫生守卫：**timeout-policy**（协作式超时，触发时把结果替换为结构化 `TOOL_TIMEOUT` 错误并恢复上游 signal）与 **repeat-tool-reminder**（advisory 提醒：深度 key 排序后的 canonical 参数串判同、阈值 [3,5,8] 升级、以带 source 标签的 user 消息注入提醒，不否决不改写）——**「提醒模型改道」与「强制终止」分离，软硬护栏各自独立成包**。
- 工具双呈现模式：native function calling 与 PTC 模式（只暴露 `run_code` + 生成 TS/Python SDK）。

**参考意义**：SYAOCODE BR-011（同工具同参数连续失败 3 次注入提示、5 次终止）与 dsh 的 repeat-tool-reminder + 循环终止几乎同构，可直接吸收其 canonical 参数串判同与「注入提醒带 source 标签」设计；「单调 guard + waterfall」两层结构可嵌入 SYAOCODE 工具执行管道（validate → PreToolUse hooks → permission → execute），保证 denial 不可被后置钩子翻案（对应 BR-021 deny 优先）。

### 3.5 权限预设捆绑（映射 DD-5 / FR-041）

`permission-presets`：把沙箱模式与审批策略**捆绑成一个用户选项**（`read-only+ask`、`workspace-write+ask`、`danger-full-access+never`），`/permission` 切换，切换写 durable `permission/preset` 事件；会话创建时从默认值钉死。`user-approval` 缝：policy 只有 `ask | never`（never = headless 确定性拒绝），answerer 缺席/失败 → `unavailable` **fail-closed**；每次审批写 `approval/asked/decided` 审计事件。注意 dsh **没有 allow-list 规则引擎**，粒度是"每请求一次决策"。

**参考意义**：permission-presets 的 UX 捆绑（沙箱档位 × 审批策略 = 一个下拉选项）对 SYAOCODE 的 `--permission-mode`（default/acceptEdits/plan/bypass）是好补充——可在用户级配置提供命名预设组合，且**选择本身作为事件入会话日志**（对应 BR-002 bypass 记录的推广）。fail-closed 审批与 BR-042 一致。

### 3.6 preset 与三角色（映射 DD-18 / FR-160/167）

dsh 的 preset = **每个 agent 的子插件组合**（工具/prompt/skills 组合；模型路由独立在 agent-default-model）。preset 声明即配置行，新增/覆盖 = bundle patch 插一行；注册表带 revision 保留与**激活审计**（imports 失败/缺服务/服务泄漏都拒绝挂载）；会话日志记录所选 preset ID，重启后按该 ID 的当前定义恢复。

**参考意义**：SYAOCODE 的三角色（hyaki/sota/common）+ economy/balanced/max 预设（FR-167）可以映射为「角色定义 = preset（工具集 + prompt + 预算），预设档位 = 角色组合」的两层结构；**会话记录角色/preset ID、恢复时校验定义存在**的语义值得吸收（对应 FR-160 可配置角色）。

### 3.7 headless profile（映射 FR-131/174 / BR-042）

`dsh --profile headless`：`--json` NDJSON 事件流、`--session-id` 续接、退出码语义、**8KiB/32KiB 事件封顶**。

**参考意义**：SYAOCODE stream-json 每行事件的体积上限是需要但未定义的细节——单行封顶（防超长工具结果撑爆管道消费者）应补进 DD-13/FR-174 的实现约束。

### 3.8 评测纪律（映射 11 章测试计划）

benchmarks 按**测量的用户路径**建目录（session-open/session-corpus/agent-continuation/active-stream-reconnect 等，明确"不要镜像包树"）；全合成输入（禁止真实会话数据）；每 case 跑 fresh 子进程 + 私有临时目录；**评审过的中位数预算**不可被环境变量覆盖；HTML 报告随 CI 发布。

**参考意义**：SYAOCODE 的性能基准（NFR-001/002/003、11.5 性能测试）可直接沿用此组织纪律，尤其「按用户路径而非模块树组织」与「全合成语料」。

---

## 四、可移植功能清单

| 功能 | 源位置 | 移植到 SYAOCODE | 成本 |
| --- | --- | --- | --- |
| goal 相位/激活分离 + disarm-on-resume | `packages/goal/goal/src/types.ts` | DD-19 Loop 恢复语义 | 低 |
| 预约-准入两阶段轮次预算 | `packages/goal/goal-round-driver/src/index.ts` | BR-050 续跑计数语义 | 中 |
| goal 权威检查（requireDirectHuman 等） | `packages/goal/tool-goal/src/authority.ts` | 三角色权限边界判定（DD-18） | 中 |
| goal/change CAS + 全量快照事件 + fold 校验 | `packages/goal/goal/src/{domain,fold}.ts` | goal 状态入会话日志的格式 | 低 |
| 合成闭包崩溃修复（TOOL_NOT_STARTED/OUTCOME_UNKNOWN） | `packages/core/session/src/repair.ts` | DD-7 恢复算法 | 低 |
| 事件 ignorable 标志 + 版本 fail-closed | `packages/session/session-persistence/src/storage-contract.ts` | FR-153 事件兼容规则实现 | 低 |
| canonical 参数串重复调用检测 + source 标签提醒 | `packages/guard/repeat-tool-reminder/src/index.ts` | BR-011 循环检测实现 | 低 |
| permission-presets 捆绑 + durable 选择事件 | `packages/interaction/permission-presets/` | 权限模式 UX 层 | 低 |
| step 级事件 + user 消息 source 归因 | `packages/core/session/src/types.ts` | DD-2 事件词汇扩展 | 低 |
| JSONL 不可变 generation + 独占后继发布 | `packages/session/session-persistence-jsonl/src/generation.ts` | DD-7 写升级策略 | 中 |
| 单行事件体积封顶（8K/32K） | `packages/bundle/headless/` | stream-json 实现约束 | 低 |

## 五、可落实的思路（关联 SYAOCODE 文档条款）

1. **BR-051 补强**：新增规则「goal/loop 的运行激活状态（armed/disarmed）不持久化，会话恢复/分叉后自动 disarm，须用户显式 resume」；「模型不得自行 resume 被暂停的 goal/loop」。
2. **BR-050 修订**：续跑计数采用预约-准入两阶段——只有真正进入模型历史的续跑轮次消耗 maxReplans/maxRuns 预算。
3. **DD-7 恢复算法细化**：撕裂 tool_use 的合成结果分两档 `SY-LOOP-003 (not_started)` / `SY-LOOP-003 (outcome_unknown)`；torn tail 首次 append 前截断。
4. **DD-2 事件扩展**：增加 step.start/step.end（每次模型调用 + usage 归因）；所有合成 user 消息带 `source: 'compaction'|'goal_continuation'|'loop_detection'|'steering'` 标签。
5. **DD-13/FR-174 约束**：stream-json 单行事件封顶（如 32KiB），超长内容转 artifact 引用。
6. **BR-011 实现模板**：循环检测用 canonical 参数串（深度 key 排序序列化）判同；3 次注入带 source 标签的提醒、5 次终止（现有规则不变，补实现细节）。
7. **DD-18 角色定义落会话日志**：会话创建时记录角色/preset 定义 ID 与哈希，恢复时校验定义存在且未被篡改，缺失则拒绝并提示。
8. **11 章性能基准组织**：按用户路径（会话打开/长会话续跑/重连/压缩）组织基准目录，全合成语料 + fresh 进程 + 中位数预算门禁。

## 六、不适合照搬与风险

- **Cordis 框架深度绑定**：scoped context、fiber、`!!js` YAML 表达式、HMR、typert 类型化 RPC 是其 Web/GUI 双端专用。SYAOCODE 只取「缝 + 事件 + 可逆注册」思想，用普通 TS 接口实现。
- **profile/bundle/plugin-manager 分发体系**：面向终端用户产品（npm 插件市场），嵌入式库不需要。
- **DeepSeek 专属件**：账号登录适配器、官方上报（dsh_session_log/OTel）、插件包清单上报。
- **schedule 是 Host 级服务**：存独立 storage domain、冷会话恢复交付；SYAOCODE 的 loop 是库内组件（随会话状态落盘），定位不同，只借「只补最新一次 miss、同刻合并一条消息」的语义。
- **native addon 分发**（Landlock launcher + flock 平台包）：SYAOCODE v1.0 应用层围栏即可；flock 租约可用锁文件替代。
- **goal 无验收器、预算单一**：这是 SYAOCODE 的差异化空间（Verified Goal + 多维预算），不要被其简化实现带偏。
- **许可证**：MIT；同样遵循只借设计不拷贝代码。

## 七、关键源码索引

| 主题 | 路径（相对 `reference/deepseek-harness-master/`） |
| --- | --- |
| 插件化架构总览 | `docs/architecture.md`、`AGENTS.md`（Repository layout） |
| goal 四分包 | `packages/goal/{goal,tool-goal,command-goal,goal-round-driver}/` |
| goal 权威检查 | `packages/goal/tool-goal/src/authority.ts` |
| 事件词汇 | `packages/core/session/src/types.ts`（SessionEventMap） |
| 崩溃修复 | `packages/core/session/src/repair.ts` |
| 持久化缝与 JSONL | `packages/session/session-persistence*/src/`（handle/storage-contract/generation/lease） |
| 工具管线 | `packages/core/tools/`（README.md、src/index.ts） |
| guard 两守卫 | `packages/guard/{timeout-policy,repeat-tool-reminder}/src/index.ts` |
| 审批与预设 | `packages/interaction/{user-approval,permission-presets}/` |
| 沙箱 | `packages/sandbox/`、`native/system/` |
| headless | `packages/bundle/headless/README.md` |
| 评测纪律 | `benchmarks/AGENTS.md`、`BENCHMARK.md` |
