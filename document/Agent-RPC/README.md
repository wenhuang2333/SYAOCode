# Agent RPC 治理底座：三大协议统一与实现（文档集）

> 状态：设计提案 v0.1（未实现）  
> 基线：`code/` @ `0ba2a35`，`0.2.0-dev`，339 项测试通过，typecheck 通过  
> 协议事实核验：2026-10-27 ~ 2026-10-28（见 [04-外部事实核验记录.md](04-外部事实核验记录.md)）  
> 适用读者：架构、内核/协议/SDK 工程师、产品与安全负责人

---

## 0. 一页结论

### 0.1 三个协议不在同一层，不能"合并成一个协议"

| 协议 | 所在层 | 它解决的核心问题 | 它**不**解决什么 |
| --- | --- | --- | --- |
| **MCP**（2026-07-28） | Host ↔ Capability | 模型如何发现并调用工具、资源、提示词 | 不定义任务生命周期、不定义跨 Agent 协作、不做审批治理 |
| **A2A**（1.0.0） | Agent ↔ Agent | 独立 Agent 之间如何发现、委派任务、交换产物 | 不规定 Agent 内部如何执行、不规定工具级权限 |
| **ACP**（Agent Client Protocol，v1） | Client/Editor ↔ Coding Agent | 编辑器如何驱动编码 Agent、如何反向提供文件系统/终端/审批 | 不做 Agent 间发现、不做长任务编排 |

三者是**互补的三个"边缘"**，不是三个竞品。把它们在 wire 层强行合并，会同时得罪三个生态的版本节奏，并丢掉各自的关键语义（MCP 的 stateless 扩展性、A2A 的 Task/Artifact、ACP 的 client-owned capability）。

### 0.2 真正可以统一、也必须统一的是"治理面"

当前三个协议都把最关键的事情留给宿主实现：

- 谁批准这次工具调用？批准一次还是永久？
- 这次调用属于哪个租户、哪个预算、哪个策略版本？
- 断线重连后，怎么证明"这件事真的做完了"？
- 一个 A2A 任务里嵌套 MCP 工具调用，再触发 ACP 人工审批，审计链在哪里？

每一家宿主各写一套，语义互不兼容。**这就是 Agent RPC 治理底座的机会：不是第四个协议，而是三个协议共同的"内核"。**

### 0.3 设计答案：一个内核 + 三种边缘

```text
        MCP edge            A2A edge             ACP edge
   (tools/resources)     (tasks/artifacts)   (sessions/approvals)
          │                   │                    │
          └───────────┬───────┴────────────┬───────┘
                      ▼                    ▼
              ┌──────────────────────────────────┐
              │        ARF Core (内核)            │
              │  Canonical IR + Governance       │
              │  Principal / Capability / Task    │
              │  Invocation / Approval / Receipt  │
              │  Policy / Budget / Audit / Evidence│
              └──────────────────────────────────┘
```

**ARF = Agent RPC Fabric**（内部代号；不对外另立标准）。它由三部分组成：

1. **Canonical IR（规范中间表示）**：Session / Task / Invocation 三层作用域，Principal / Capability / Approval / Receipt / Event 六类核心对象。
2. **Governance Pipeline（治理流水线）**：身份 → 策略 → 审批 → 预算预留 → 幂等 → 派发 → 脱敏 → 结算 → 回执 → 审计，十步全部在内核完成，适配器不得绕过。
3. **Protocol Adapters（协议适配器）**：MCP / A2A / ACP 各自做"语义翻译 + 能力协商 + 降级标注"，只做边缘，不做治理。

### 0.4 六个关键设计判断

1. **治理必须先于派发（policy-before-dispatch）**：任何工具/任务调用先过策略与预算，再触达协议端点；适配器没有"直接执行"通道。
2. **审批权威是可委派的（delegated authority）**：MCP 场景内核是审批权威；ACP 场景审批权威在编辑器客户端；A2A 场景在远端任务链上。统一为 `ApprovalAuthority`，并把委派链写进回执。
3. **预算是预留制（reserve-settle）**：先冻结上限，再执行，最后按实际结算；跨 Agent 跳转时预算随委派令牌传递，避免"子 Agent 花超了才发现"。
4. **非幂等工具必须"至多一次"（at-most-once）**：MCP 2026-07-28 明确断流后用新 request id 重发，协议本身不保证幂等；内核用 `Idempotency-Key + 输入哈希 + 结果缓存 + 人工确认` 补齐。
5. **证据是跨协议的一等公民（cross-protocol receipt）**：每次 Invocation 产出一张可验证回执，聚合到 Task 级 Evidence Bundle；这是"Verified Completion"从 CLI 走向平台的基础。
6. **适配器只做"翻译"，不做"决策"**：策略、预算、审批、审计只有一份实现；适配器可以声明"该协议不支持某能力"，但不能私自放行。

### 0.5 落地顺序（建议）

| 阶段 | 人天（单人估算） | 交付 | 退出条件 |
| --- | --- | --- | --- |
| **M0 内核** | ≈ 21 | `@syaocode/rpc` IR + 状态机 + 治理接口 + 黄金样例 | 所有对象有 Zod schema；状态机性质测试通过 |
| **M1 MCP + serve** | ≈ 31 | SDK 选型 PoC；MCP client/server（2026-07-28 + legacy 双形态）、`syao serve`、TaskStore/Approval/Budget/Audit | 真实 MCP server 端到端；治理开销 p95 < 5ms |
| **M2 ACP** | ≈ 15 | ACP server adapter（官方 SDK 包装，编辑器可 spawn）、fs/terminal 反向能力、权限桥 | Zed/Neovim 任一客户端真实跑通"读→批→改→证据" |
| **M3 A2A** | ≈ 14 | A2A client/server adapter（官方 `@a2a-js/sdk`）、AgentCard、Task/Artifact、in-task auth | 与官方 SDK 互通；Task 状态与产物一致 |
| **M4 证据与合规** | ≈ 12 | 跨协议 Receipt/Evidence Bundle、审计链、一致性套件、红队 | 0 critical/high；3 个跨协议场景黄金 trace 稳定 |

> 合计约 **92.5 人天**（单人全职 ≈ 19 周；按兼职 2.5 人天/周 ≈ 37 周），不含产品化 UI 与企业控制面。  
> **SDK 策略（2026-10-28 修订）**：边缘优先用官方 SDK——A2A 用 `@a2a-js/sdk 1.3.0`（无 zod 依赖）、ACP 用 `@agentclientprotocol/sdk 2.0.2`（peer 兼容本仓 `zod 3.25.76`）、MCP 隔离使用 SDK v2 `2.4.0`（其 `zod ^4.2.0` 硬依赖需隔离，PoC 不通过则回退自研最小层）；治理层始终自研。详见 [04 §5](04-外部事实核验记录.md)。

### 0.6 不做什么（anti-roadmap）

- **不发明第四个对外协议标准**：ARF IR 是内部契约；如需公开，只公开 schema 与适配器规范，不争夺标准话语权。
- **不做"协议网关"**：只做反向代理/路由的网关无法提供任务语义、审批与证据，价值会被云厂商的 API Gateway 吞掉。
- **不做多 Agent 编排框架**：ARF 只提供"一次可治理的调用/任务"，编排留给 LangGraph、Temporal、自研 scheduler。
- **不做插件市场**：能力注册表先服务企业内部，不做公开交易。
- **不在 v0.3 前做 Desktop**：先把内核与三个边缘打通，UI 是消费者，不是前提。

---

## 1. 文档地图

| 文档 | 内容 | 读它来解决什么问题 |
| --- | --- | --- |
| [01-协议基线与统一模型.md](01-协议基线与统一模型.md) | 三协议事实基线、差异矩阵、Canonical IR、状态机、映射总表 | "它们到底哪里不同、统一成什么" |
| [02-治理底座架构设计.md](02-治理底座架构设计.md) | 数据面/控制面、十步治理流水线、策略/预算/审批/幂等/审计/证据、威胁模型、SLO | "内核怎么设计、为什么这样设计" |
| [03-工程实现与落地路线.md](03-工程实现与落地路线.md) | 包结构、TS 接口、适配器实现要点、存储、测试、CI、里程碑、任务清单 | "在这个仓库里具体怎么干" |
| [04-外部事实核验记录.md](04-外部事实核验记录.md) | MCP/A2A/ACP 的版本、方法名、状态与 UNVERIFIED 清单 | "文档里的协议断言凭什么可信" |

---

## 2. 关键术语

| 术语 | 含义 | 与协议术语的关系 |
| --- | --- | --- |
| **Principal** | 发起或被委派执行的主体：user / agent / service | MCP 的 client、A2A 的 caller agent、ACP 的 client |
| **Capability** | 一个可被调用的能力：tool / resource / prompt / agent-skill / fs / terminal | MCP 的 tool/resource/prompt；A2A 的 AgentSkill；ACP 的 tool call/fs/terminal |
| **Session** | 一次长期协作的上下文与策略绑定 | ACP 的 session；MCP 2026-07-28 **没有** session；A2A 的 contextId 近似 |
| **Task** | 一个有状态、可中断、可恢复的工作单元 | A2A 的 Task；MCP Tasks 扩展的 task；ACP 的 prompt turn 是 Task 的特例 |
| **Invocation** | 一次具体的、有输入输出的能力调用 | MCP 的 `tools/call`；ACP 的 tool call；A2A 的 Message 内的一次动作 |
| **Approval** | 一次需要人（或策略）裁决的请求 | MCP 的 MRTR `input_required`；A2A 的 `TASK_STATE_AUTH_REQUIRED`；ACP 的 `session/request_permission` |
| **Receipt** | 一次 Invocation 的不可抵赖回执 | 仓库现有的 `ToolReceipt` 的超集 |
| **Evidence Bundle** | 一个 Task 的全部回执、产物哈希、策略与审批记录 | 仓库现有的 Evidence Ledger 的跨协议扩展 |
| **ARF** | Agent RPC Fabric，本设计的内部代号 | 不是对外协议名 |

---

## 3. 与现有文档/代码的关系

- 本文件集是**设计提案**，不修改 `document/SYAOCode/` 下的基线文档；需要同步的基线条目列在 [03 §8](03-工程实现与落地路线.md#8-对现有基线文档的修改建议)。
- 代码侧当前**没有** MCP/A2A/ACP 实现；`08-详细设计说明书.md` DD-9/DD-17 只有 `ProtocolAdapter` 与 `serve` 的雏形。本设计是对 DD-9/DD-17 的扩展，不是既成事实。
- 现有可复用的内核资产：`AgentEvent` 信封（`runId`/`seq`/`causationId`）、`PermissionEngine`（模式/规则/危险命令库）、`ToolReceipt`/`ReceiptStore`、`Redactor`、`FileSessionStore`、`FileStateTracker`、`estimateTokens`、`withRetry`。
- 现有需要先修的 P0（详见 `概览.md` §9 与 `document/产品文档-详细版.md` §0.8）：Redactor 未接线、路径围栏只覆盖写、危险命令 allow 规则忽略 `rule.source`、core 入口泄漏 Node 内置模块、配置权限模式未接入 CLI、`turns` 差一、退出码 3 不可达、会话 append O(n²)。**这些是治理底座的前置条件**，否则"统一治理"会把已有缺陷放大到三个协议。

---

## 4. 需要拍板的五个问题

| # | 问题 | 本设计的建议 | 影响 |
| --- | --- | --- | --- |
| Q1 | ARF 是对外产品还是内部内核？ | **内部内核 + 可选公开 schema**；对外仍讲 MCP/A2A/ACP 兼容 | 决定是否投入标准/社区运营 |
| Q2 | 先做哪个边缘？ | **MCP 优先**（需求最硬、生态最成熟、与 coding agent 最贴） | 决定 M0/M1 的资源与首发场景 |
| Q3 | ACP 做 server 还是 client？ | **先 server**（让编辑器驱动 SYAOCode），client 后置 | 决定与 Zed/Neovim 的集成方式 |
| Q4 | 审批权威默认在哪？ | **本地优先**：无远端 client 时内核自批；有远端时委派并记录链 | 决定安全模型与 UX |
| Q5 | 是否把 Evidence 作为 v1.0 发布门槛？ | **是**，但只要求"关键路径可验证"，不要求全量 | 决定 v1.0 范围与测试成本 |

> 这五个问题不阻塞 M0（IR 与接口），但会阻塞 M1 之后的优先级。建议在 M0 评审时给出结论。
