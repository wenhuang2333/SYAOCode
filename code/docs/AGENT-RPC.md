# Agent RPC 治理底座（ARF）实现说明

> 落地对象：`document/Agent-RPC/`（01 协议基线与统一模型 / 02 治理底座架构设计 / 03 工程实现与落地路线 / 04 外部事实核验记录）
> 代码基线：`code/` @ `0.3.0-dev`
> 状态：M0 内核 + M1 治理流水线 + 三个协议边缘（自研最小 wire 层）已实现并通过测试

---

## 1. 一句话

**一个内核 + 三种边缘**：`@syaocode/rpc` 是唯一的治理实现（身份 → 策略 → 审批 → 预算 → 幂等 → 派发 → 结算 → 回执 → 审计），`@syaocode/protocols` 只做 MCP/A2A/ACP 的语义翻译与降级标注，CLI/TUI 通过 `/rpc`、`/peer`、`/call`、`/serve`、`/approve` 操作整套治理面。

```
        MCP edge            A2A edge             ACP edge
   (tools/resources)     (tasks/artifacts)   (sessions/approvals)
           │                   │                    │
           └───────────┬───────┴────────────┬───────┘
                       ▼                    ▼
               ┌──────────────────────────────────┐
               │   @syaocode/rpc  (ARF Core)      │
               │   Canonical IR + 十步治理流水线   │
               └──────────────────────────────────┘
                       ▲
                  CLI / TUI / SDK
```

---

## 2. 包结构

| 包 | 职责 | 依赖 |
| --- | --- | --- |
| `@syaocode/rpc` | Canonical IR、十步治理流水线、策略/审批/预算/幂等/回执/审计/注册表/身份、存储与事件日志、fabric 组装 | `@syaocode/core` + `zod` |
| `@syaocode/protocols` | MCP / A2A / ACP 适配器（JSON-RPC 2.0 自研最小层） | `@syaocode/rpc` |
| `syaocode`（CLI） | `serve`/`call`/`rpc`/`mcp` 子命令 + `/rpc` 等交互指令 | `@syaocode/rpc`、`@syaocode/protocols` |

**硬约束**（由 `scripts/check-rpc-boundaries.ts` 与 `check-core-purity.ts` 强制）：

1. `@syaocode/rpc` 与 `@syaocode/core` **永不** import 任何协议 SDK，也不 import `node:`；
2. `@syaocode/protocols` 不得 import `node:`，不得 import `core/src/agent.ts`，不得直接调用 `Tool.execute`；
3. 适配器只能拿到 `AuthorizedInvocation`，没有任何原始工具/端点句柄（不变量 I13）。

### 2.1 文件地图（`packages/rpc/src`）

| 文件 | 内容 |
| --- | --- |
| `ir/types.ts` | Principal / Capability / Session / Task / Invocation / Approval / Receipt / Event / Artifact / Obligation / PolicyBundle |
| `ir/schemas.ts` | Zod schema（唯一运行时真源，ADR-07）+ `canonicalJson` |
| `ir/states.ts` | Task/Invocation/Approval 状态机 + 转移表 + 三协议状态映射表 |
| `ir/ids.ts` | ID 生成、capability id 构造/解析、`mcp__<server>__<tool>` 规则 |
| `ir/errors.ts` | `CanonicalError` + 重试矩阵 + JSON-RPC 错误映射 + CLI 退出码 |
| `governance/contracts.ts` | **冻结接口**：PolicyEngine / ApprovalBroker / BudgetLedger / IdempotencyStore / ReceiptStore / AuditStore / CapabilityRegistry / IdentityService / EventLog / 各类 Store / Dispatcher / ProtocolAdapter |
| `governance/dispatcher.ts` | **十步流水线** |
| `governance/policy.ts` | 规则组合算法 + `createPermissionPreset`（包装 core `PermissionEngine`） |
| `governance/policy-bundle.ts` | 策略包 revision 计算、分层合并、过期判定 |
| `governance/approval.ts` | 审批 Broker：CAS 单赢家、超时 fail-closed、recheck 8 轮、敏感项不可记忆 |
| `governance/budget.ts` | 层级账户、预留/结算/释放、崩溃恢复、超限冻结 |
| `governance/idempotency.ts` | requestHash / key 组合 / new-replay-in_flight-conflict |
| `governance/receipts.ts` | 回执哈希链 + Evidence Bundle 封存与校验 |
| `governance/audit.ts` | 租户级审计哈希链 + checkpoint + verify |
| `governance/registry.ts` | 能力注册表与路由（信任→健康→成本） |
| `governance/identity.ts` | Principal 认证、委派令牌签发/校验（逐跳衰减） |
| `governance/redactor-bridge.ts` | 统一脱敏入口 |
| `runtime/stores.ts` 等 | 内存实现（可插拔，接口在 contracts.ts） |
| `runtime/fabric.ts` | `createFabric()`：装配整套治理面并对外暴露统一 API |

---

## 3. 十步治理流水线

实现顺序采用 02 §4.3 的**推荐顺序**（与文档 ASCII 图不同）：

| # | 步骤 | 关键语义 | 代码 |
| --- | --- | --- | --- |
| 1 | Normalize | 空 capabilityId → `invalid_request`，不派发 | `dispatcher.ts` |
| 2 | Authenticate | Principal/Tenant 缺失 → `unauthenticated`（I1） | 同上 |
| 3 | Resolve | 只认注册表；远端自述不得覆盖（I4/G7） | `registry.ts` |
| 4 | Idempotency | 在预算之前：重放不得重复冻结预算 | `idempotency.ts` |
| 5 | Authorize | 无 PolicyDecision 不得派发（I2）；无法满足的 obligation → `unsupported_obligation` | `policy.ts` |
| 6 | Approve | `ask` 无审批不得派发（I3）；超时/取消/非法响应一律 deny | `approval.ts` |
| 7 | Reserve | 先预留后派发，沿祖先链冻结（I6） | `budget.ts` |
| 8 | Dispatch | **唯一的副作用出口**，只接收 `AuthorizedInvocation` | `fabric.ts` executor |
| 9 | Settle | 按实际用量结算，释放差额；结算幂等 | `budget.ts` |
| 10 | Receipt + Audit | 每条终态路径恰好一张回执（I5）+ 一条审计 | `receipts.ts` / `audit.ts` |

### 3.1 与文档的差异（有意为之）

| 差异 | 原因 |
| --- | --- |
| 幂等检查放在预算**之前** | 02 §4.3 明确推荐；避免重放重复预留预算 |
| `ReceiptStore.put` 接收不含 `hash`/`prevHash` 的回执，由 store 封链 | 只有 store 知道链头；调用方无法伪造 `prevHash` |
| `SecretRedactor` 是结构化接口而非 core 的 `Redactor` 类 | 内核依赖形状而非类身份，宿主可注入自己的实现 |
| `maxPerInvocationUsd` 只在估算**缺失**时生效 | 显式给出的估算不得被静默钳制，否则调用方可低报绕过账本 |
| 决策缓存 key 覆盖 risk/dataClass/sideEffect/visibility/trustTier | 能力属性变化后不得复用旧决策 |

---

## 4. 不变量与测试映射

02 §3.2 的 13 条不变量对应的测试：

| ID | 不变量 | 测试 |
| --- | --- | --- |
| I2 | 没有 PolicyDecision 不得派发 | `dispatcher.test.ts`「denies without dispatching」 |
| I3 | `ask` 没有 Approval 不得派发 | 「never dispatches an `ask` without an approval」 |
| I4 | 协议注解不得提升策略结果 | `policy.test.ts`「explicit deny veto」；`fabric.test.ts`「never takes the effective risk from the peer annotation」 |
| I5 | 每个 Invocation 恰好一个终态 + 一张回执 | 「issues exactly one receipt」 |
| I6 | 预算先预留后派发，余额不为负 | 「reserves the budget before dispatching」/「refuses … exhausted」 |
| I8 | 所有查询按 tenantId 过滤 | `fabric.test.ts`「keeps tenant isolation on task reads」 |
| I9 | 审批单赢家；超时/取消 = deny | `approval.test.ts`「single-winner」/「fails closed」 |
| I10 | 非幂等结果未知不得自动重试 | `dispatcher.test.ts`「marks an unknown outcome as indeterminate」 |
| I13 | 适配器不得直接执行工具 | `scripts/check-rpc-boundaries.ts` + 适配器合约测试 |

---

## 5. 外部事实核验更正（重要）

> **2026-10-28 复核修订**：本节初版把 **v1 包名** `@modelcontextprotocol/sdk` 当成了 MCP 官方 SDK 的全部，据此得出"无 2.x 版本线 / 不支持 2026-07-28 modern 时代"的结论。该结论**不成立**：v2 使用**新的包名**发布。下表为实测更正；完整证据见 `document/Agent-RPC/05-实现评估与结论.md §6`。

| 文档断言 | 实测结果（2026-10-28） | 处置 |
| --- | --- | --- |
| 「MCP 官方 SDK v2 `2.4.0`」 | **存在**，但不在旧包名下。`@modelcontextprotocol/sdk` 是 **v1 线**（latest `1.32.2`）；v2 拆为 `@modelcontextprotocol/server@2.4.0`、`/client`、`/core`、`/node` 等；`@modelcontextprotocol/server@2.4.0` 的 `dependencies` = `{zod: ^4.2.0, @modelcontextprotocol/core: 2.4.0}` | 结论修正：SDK 存在；仍选择自研（见下） |
| 「MCP SDK 的 zod 是 `^3.25 \|\| ^4.0`，无强制嵌套」 | 那是 **v1** 的区间。**v2** 的 `@modelcontextprotocol/core@2.4.0` 硬依赖 `zod ^4.2.0` → 与本仓 `zod 3.25.76` 会**嵌套第二份 zod** | 隔离成本确实存在 |
| 「MCP SDK 不支持 2026-07-28 modern 时代（`server/discover`/`resultType`/`_meta` 命中数为 0）」 | **该断言不成立**。下载 `@modelcontextprotocol/server@2.4.0` tarball 实测：`server/discover` **148** 处、`resultType` **226** 处、`io.modelcontextprotocol/protocolVersion` **4** 处、`2026-07-28` **844** 处 | 结论修正：v2 **支持** modern 时代 |
| 「A2A 官方 `@a2a-js/sdk 1.3.0`（无 zod 依赖）」 | 属实（唯一运行时依赖 `jose`）。但：**无 stdio 传输**（仅 HTTP/JSON-RPC/gRPC）；TS 处理器接口是 camelCase，wire 方法名是 PascalCase；状态需 `taskStateToJSON` 序列化 | 保留：本地 stdio 场景自研更合适 |
| 「ACP 官方 `@agentclientprotocol/sdk 2.0.2`，peer 兼容本仓 zod」 | 属实且最干净：**零运行时依赖**，peer-only `zod ^3.25.76 \|\| ^4.0.0`；`./` = v1 稳定，v2 在 `./experimental/v2` | 保留：自研以保证零外部依赖面 |

> **结论（修正版）**：三个边缘采用自研最小 JSON-RPC 层的**决定保留**，但理由改为：
> 1. **零传递依赖**：不引入 express/hono/grpc/protobuf 等 peer，构建完全自洽；
> 2. **完全可控**：可精确实现 2026-07-28 的无状态语义与 MRTR，不受 SDK 的 era/默认行为影响；
> 3. **避免双 zod**：v2 SDK 会嵌套 `zod ^4.2.0`。
>
> 代价是 wire 细节需自行维护，故保留 `packages/protocols/test/drift.test.ts` 钉住方法名/字段清单。
>
> **两条必须记住的红线**：
> - drift 基线目前是**实现自身的常量**，只能发现"改坏了"，**不能发现"基线钉错了"**（已发现 MCP 错误码、A2A 版本错误码两处钉错）。升级规范时必须对照 `document/Agent-RPC/04` 手工复核，并逐步换成从官方 SDK/规范快照生成的 fixture。
> - 若将来引入任一官方 SDK，`zod` 解析值必须 **≥ 3.25.0**（v1 SDK 与 ACP SDK 运行时 `import 'zod/v4'`；MCP v2 直接要求 `zod ^4.2.0`）。本仓 `^3.24.0` 的声明区间本身不足，lockfile 的 `3.25.76` 是唯一保障——建议把声明提升为 `^3.25.76`。

### 5.1 v0.4 审计后的修复状态

审计报告：[`document/Agent-RPC/05-实现评估与结论.md`](../../document/Agent-RPC/05-实现评估与结论.md)。下表只记录**已在本仓代码中修复并有测试**的项。

| 审计项 | 状态 | 证据 |
| --- | --- | --- |
| P0-1 身份与租户（I1） | 已修 | 入口调用 `IdentityService.authenticate`；强制 `principal.tenantId === ctx.tenantId === session.tenantId`；`fabric.call` 拒绝跨租户 principal。`test/p0-governance.test.ts` V3 三例 |
| P0-2 预算真实化 + 原子预留（I6） | 已修 | 无 estimate 时预留保守上限（不再是 `$0`）；`reserve/settle/release` 按根账户串行化，消除 check-then-write TOCTOU；session 账户挂到 tenant 账户下；`recoverExpired` 先查回执再决定结算或释放。V1/V2 三例 |
| P0-3 非幂等重试门（I10） | 已修 | 失败时记录 `{retryable, sideEffect, outcome}`；`indeterminate` 或 `non_idempotent` 失败返回 `conflict` 而非重跑。`idempotency.test.ts` 四例 |
| P0-4 obligation 硬约束 | 已修 | `require_approval` 在 `allow` 决策下同样强制审批；无法满足的 obligation（sandbox/network_allowlist/delegation_limit）→ `unsupported_obligation` 且不派发。V5 三例 |
| P0-5 审批绑定 | 已修 | 审批记录绑定 `capabilityId + inputHash`；`decide` 校验租户、authority、过期；适配器只拿到 `ApprovalRequester`（无 `decide`）。NEG 三例 |
| P0-6 脱敏全出口（I7） | 已修 | 事件、回执、错误、输出、`lossy`、artifacts 统一过 redactor；`secret` 类能力在无 redactor 时**拒绝执行**。NEG 一例 |
| P0-7 幂等键 | 已修 | 先分配 `invocationId`，用 `derivedKey(task.id, invocationId)`，删除常量 `'pending'`。V4 一例 |
| P0-8 拒绝路径回执（I5） | 已修 | 策略拒绝、审批拒绝、预算不足、obligation 不支持、超时、deadline 已过 六条路径都写终态回执；`outcome:'denied'`/`'timed_out'` 可达。两例 |
| I8 查询租户过滤 | 部分修复 | 任务/会话/预算/审批/注册表 `get`/事件流/evidence seal/审计列表均已按租户过滤；`AuditStore.list` 无 filter 时由 fabric 强制注入租户 |
| 其他（`inputHash` 覆盖脱敏后输入、真实 timing、`deadlineAt` 强制、事件先脱敏后落盘） | 已修 | 见 `dispatcher.ts` |

### 5.1.1 P1 协议合规（已修 + 已用官方 SDK 验证）

| 审计项 | 状态 | 证据 |
| --- | --- | --- |
| P-H1 MCP 保留错误码钉错 | 已修 | 按 04 M18 重钉：`HeaderMismatch -32020`、`MissingRequiredClientCapability -32021`、`UnsupportedProtocolVersion -32022`；MRTR 的 `inputRequired`/`requestStateInvalid` 移出保留区到 `-32010/-32011` |
| P-H2 A2A 错误码到不了 wire | 已修 | `CanonicalErrorShape.wireCode` + `defaultWireCode()`，`toShape()` 携带数字码；**独立探针**实测：TaskNotFound `-32001`、PushNotSupported `-32003`、VersionNotSupported `-32009`、MethodNotFound `-32601`、InvalidParams `-32602`，且**无一项退化为 `-32603`** |
| P-H3 A2A 版本错误码 | 已修 | `-32009` 双向映射（`a2aError({code:-32009})` → `version_mismatch`），断言不等于 `-32022` |
| P-H4 A2A 私有流式帧 | 已修 | 删除 `notifications/stream`；改为规范 SSE（`text/event-stream`，事件体为 Task/Message/TaskStatusUpdateEvent/TaskArtifactUpdateEvent），快照先行、终态事件收尾 |
| P-H5 ACP 取消语义 | 已修 | `session/cancel` → `stopReason:'cancelled'`（取消优先于 handler 返回值）；pending `session/request_permission` 一律回 `{outcome:'cancelled'}` |
| P-H6 MCP HTTP 强制头 | 已修 | `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`（+`Mcp-Param-*`）由 body 推导并校验，不匹配 → HTTP 400 + `-32020` |
| P-H7 ACP 反向 fs 围栏 | 已修 | 围栏上移到 `AcpAdapter.invoke`：先校验 sessionId 归属，再 `realpath` 归一后比对 workspace roots（`/repo-evil` 这类词法绕过被拒） |
| P-H8 MCP OAuth/PRM | 已明确标注不支持 | `mcp-oauth-prm-unsupported` 进 `lossy`；401/403 对端 → `unauthenticated` fail-closed，不半实现 |
| 两个 server 零测试 | 已修 | 新增 3 个 wire 套件共 **57 项**：`mcp-server.wire`（22）、`a2a-server.wire`（20）、`acp-server.wire`（15） |
| drift 基线自指 | **已修（关键）** | 新增 `fixtures/mcp-wire-snapshot.json`，由 `scripts/gen-wire-fixture.ts` **从官方 tarball `@modelcontextprotocol/server@2.4.0` 生成**（非本项目常量）；`test/drift-external.test.ts` 比对实现与外部快照，并强制"已声明的 gap 必须仍是真的"。**该外部基线立刻发现了两处实现缺口**：`subscriptions/listen` 与 `notifications/message`（已作为 `knownGaps` 显式登记） |
| 与官方 SDK 真实互通 | **已达成（MCP / A2A / ACP 三协议）** | `scripts/interop-mcp-official.mjs`（官方 `@modelcontextprotocol/client@2.4.0` → **8/8**）、`scripts/interop-a2a-official.mjs`（官方 `@a2a-js/sdk@1.3.0` → **5/5**：AgentCard 发现、版本 1.0 协商、`SendMessage` 被诚实拒绝）、`scripts/interop-acp-official.mjs`（官方 `@agentclientprotocol/sdk@2.0.2` → **6/6**：initialize、session/new、`session/prompt` → `end_turn`、6 条 `session/update`） |

> **真实互通发现并修掉的 4 个 MUST 级缺陷**（自指测试全部漏过）：
> 1. HTTP 响应体写成 stdio `Content-Length` 帧 → 任何真实 peer 解析失败（`SyntaxError: Unexpected token 'C'`）；
> 2. `tools/list`/`resources/list`/`prompts/list` 缺 `resultType` 判别符（modern 规范要求）；
> 3. 上述列表结果缺 `ttlMs`/`cacheScope` 缓存提示，工具缺 `inputSchema`；
> 4. 内置 local 工具的 provider `ttlMs: 60_000` 使其 60 秒后变成 `down` 并被路由过滤（`no provider … satisfies the route constraints`）。
>
> 这 4 项均已补 wire 回归测试。

> 真实互通合计发现并修掉 **6 个**自指测试漏过的缺陷：MCP 的 HTTP 体写了 stdio 帧、列表缺 `resultType`、列表缺 `ttlMs`/`cacheScope` 与工具缺 `inputSchema`、内置工具被 TTL 判死；A2A 的**完全没有 AgentCard**（官方客户端无法发现边缘）、`A2A-Version` 走 HTTP 头却从 body 读（把每个真实客户端当成版本不支持）。
>
> 仍未完成（**不要在对外材料中宣称**）：MCP `subscriptions/listen` 与 `notifications/message`（已登记 `knownGaps`）、A2A 保留键覆盖、ACP `session/update` 其余 9 类变体、审计留存策略（retention/轮转/多进程并发）、`detailHash`、吞吐未测。
>
> **多进程写入是当前最高风险**：文件 store 没有跨进程写锁，"读全量→改→重写全量"会在两个进程同时写同一租户目录时丢更新、覆盖预算、把审计链写出分叉。完整设计见 [`document/Agent-RPC/06-多进程写入与审计留存设计.md`](../../document/Agent-RPC/06-多进程写入与审计留存设计.md)，排期见 `07` 的 WP-1。**在 WP-1 完成前，本项目只能宣称"单进程可用"。**

### 5.2 对外口径（截至本版本）

| 现在可以说 | 现在不能说 |
| --- | --- |
| ARF 内核骨架与三边缘已落地，门禁全绿，治理开销 p95 < 1ms | "协议完全合规"、"可用于生产" |
| 十步流水线、审批 CAS、SHA-256 审计链、回执链已实现并通过单元/红队/P0 回归测试 | "生产级可治理底座" |
| 单机/单租户场景下策略、审批、预算、回执可用（P0 已修） | "跨组织联邦治理" |
| 三协议均与**官方 SDK** 实测互通（8/8、5/5、6/6） | "已通过第三方认证/一致性测试套件"、"吞吐达标"（只测了延迟） |
| 主 agent 路径（`syao -p` / TUI / ACP `session/prompt`）已接入 ARF；治理记录跨进程可读 | "企业级审计留存"（本地文件、无 retention/轮转） |
| **实验性预览（experimental preview）** | "已通过外部互通验证"（互通是自测探针，非第三方认证） |

---

## 6. 降级词汇表（`lossy`）

每个适配器必须在 `capabilities().lossy` 与每次调用的 `InvokeResult.lossy` / `Receipt.lossy` 上声明无法表达的语义（ADR-R10：**可降级但不静默**）。UI 与审计必须展示它们。

### 6.1 MCP 2026-07-28

| 标记 | 含义 |
| --- | --- |
| `mcp-no-session` | 协议无会话，Session 由内核自持有（G1） |
| `mcp-no-server-initiated-request` | 服务端不得主动发请求，审批只能走 MRTR（G1） |
| `mcp-task-extension-optional` | Tasks 是官方扩展，非核心；长任务跟踪不保证（G2） |
| `mcp-annotations-untrusted` | `ToolAnnotations` 只是提示，绝不进入有效风险判定（G8） |
| `mcp-legacy` | 对端无 `server/discover`，回落 legacy 时代（**每次调用**记录） |
| `mcp-mrtr-unsupported` | 对端不支持 MRTR，无法在协议内表达"等待审批" → fail-closed |
| `mcp-task-not-awaited` | 服务端返回 `resultType: task`，内核未等待其终态 |

MRTR 的 `requestState` 在**两侧**都做逐字节校验且一次性使用；未知/被篡改/被重放 → `-32021` fail-closed；审批被拒时对端调用次数**恰好为 1**（不重试）。

### 6.2 A2A 1.0

| 标记 | 含义 |
| --- | --- |
| `a2a-remote-task-opaque` | 远端不暴露内部工具调用，每次调用都标注（G3） |
| `a2a-no-approval-options` | 无标准审批选项结构（G4） |
| `a2a-weak-session` | `contextId` 只是弱会话 |
| `a2a-agent-card-untrusted` | AgentCard 是自述，能力 ≠ 授权（G7） |
| `a2a-expired-maps-to-failed` | ARF `expired` 映射为 `TASK_STATE_FAILED`（reason=timeout） |
| `a2a-push-notifications-unsupported` | 未实现 push webhook |

跨租户读取一律返回 `TaskNotFound (-32001)`，**不返回 403**，避免泄露任务存在性。

### 6.3 ACP v1

| 标记 | 含义 |
| --- | --- |
| `acp-no-task-state` | 协议无任务状态机，prompt turn 映射为 Task（G5） |
| `acp-no-artifacts` | 无 Artifact 概念，diff/content 映射为产物（G5） |
| `acp-no-denied-outcome` | 无 `denied` 结果：拒绝必须表达为 `selected` + `reject_*`，否则 `cancelled` |
| `acp-fs-client-owned` | 文件系统归客户端所有，反向调用必须过治理（G6） |
| `acp-client-capability-missing` | 客户端未声明该能力 → `unsupported_capability`，**绝不回退本地 fs** |
| `acp-replay-on-load-only` | 只有 `session/load` 重放历史，`session/resume` 不重放 |

---

## 7. 命令面

命令命名原则：**短、可记、动词化**。治理面统一挂在 `/rpc` 之下，协议边缘统一挂在 `/peer` 之下。

### 7.1 交互指令（TUI / REPL）

| 指令 | 用法 | 说明 |
| --- | --- | --- |
| `/rpc` | `/rpc [tasks\|task <id>\|approvals\|approve <id> [once\|session\|always]\|deny <id>\|budget\|audit\|policy <capabilityId>\|status]` | **治理控制台**：无参数＝总览面板（任务/审批/预算/审计/适配器/策略版本） |
| `/peer` | `/peer [list\|add <id> <url\|command>\|remove <id>\|ping <id>]` | 协议边缘：MCP server / A2A agent / ACP client 注册、能力数、健康、`lossy` 降级提示 |
| `/call` | `/call <capabilityId> [json]` | 发起一次受治理调用，输出结果、回执 ID、成本、审批与降级轨迹 |
| `/serve` | `/serve [mcp\|acp\|a2a] [--stdio\|--http] [--port N]` | 协议服务状态/端点/token；无参数＝当前状态面板 |
| `/approve` | `/approve <id> [once\|session\|always\|deny]` | 按 ID 裁决待批审批（`/rpc approve` 的快捷方式） |
| `/mcp` | 同 `/peer` | 兼容旧名，保留为 `/peer` 的别名 |

### 7.2 子命令

| 命令 | 说明 |
| --- | --- |
| `syao serve --mcp\|--acp\|--a2a [--stdio\|--http] [--port N] [--host H]` | 启动协议服务；默认只监听 `127.0.0.1`，非回环地址无 token → `SY-SRV-002` |
| `syao call <capabilityId> [--input @file\|json] [--json]` | 受治理调用，输出回执 |
| `syao rpc <tasks\|task\|approvals\|approve\|deny\|budget\|audit\|policy\|status> [--json]` | 治理运维 |
| `syao mcp <list\|add\|remove>` | MCP server 配置管理 |

### 7.3 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 一般错误 |
| 2 | 参数/配置/协议格式错误 |
| 3 | 权限拒绝（含审批被拒） |
| 4 | 限额（预算/轮次/时长） |
| 5 | 未验证（`indeterminate`） |
| 6 | 验证失败 |
| 7 | **能力/协议不可用**（`unsupported_capability`、`version_mismatch`、`capability_not_found`） |
| 130 | 中断 |

映射实现在 `@syaocode/rpc` 的 `CanonicalError.exitCode`。

---

## 8. 快速上手

```bash
cd code

# 全量校验
corepack pnpm typecheck
corepack pnpm test
corepack pnpm lint

# 交互：进入 TUI 后用治理控制台
corepack pnpm start
#   /rpc status          → 治理总览
#   /peer list           → 协议边缘与能力
#   /call local://tools/read {"path":"README.md"}
#   /rpc audit           → 审计链校验
```

```ts
// 嵌入式 SDK
import { createFabric } from '@syaocode/rpc';
import { nodeRuntime } from '@syaocode/node';

const fabric = createFabric({
  runtime: nodeRuntime(),
  tenantId: 'acme',
  workspaceRoots: [process.cwd()],
  policy: { defaultEffect: 'deny', rules: [
    { id: 'read-repo', priority: 10, effect: 'allow', match: { capabilities: ['mcp://github/tool/get_*'], risk: ['read'] }, source: 'org' },
    { id: 'write-ask', priority: 20, effect: 'ask',  match: { capabilities: ['mcp://github/tool/*'], risk: ['write'] }, source: 'org' },
  ]},
  budget: { tenantLimitUsd: 20, sessionLimitUsd: 2 },
});

const result = await fabric.call({ capabilityId: 'mcp://github/tool/get_issue', input: { number: 42 } });
console.log(result.outcome, result.receiptId);
const bundle = await fabric.evidence.seal(result.taskId);
```

---

## 9. 已知边界与未实现项

> **2026-10-30 更新**：本表下方"持久化"一行已过时——CLI 现在默认使用文件 store 并跨进程可读（C-4）。**但文件 store 没有跨进程写锁**：同一租户目录只能由**一个进程**写。多进程写入协议见
> [`document/Agent-RPC/06-多进程写入与审计留存设计.md`](../../document/Agent-RPC/06-多进程写入与审计留存设计.md)，排期见 `07` WP-1。**在该 WP 完成前，不得宣称多进程安全。**

| 项 | 状态 |
| --- | --- |
| 持久化存储（JSONL/SQLite/Postgres） | 内核提供**内存实现** + 完整接口；`packages/rpc/src/runtime/file-stores.ts` 提供文件实现（tasks/sessions/approvals/budget/idempotency/receipts/audit/events，加载时校验回执链与审计链），CLI 默认启用、跨进程可读。**限制：无跨进程写锁、无 retention/轮转、`writeAll` 非原子**，因此只支持单进程写；设计见 `06` |
| **MCP 端到端（真实对端）** | **已跑通，双向**：① SYAOCode 作 MCP **client** 调用外部真实 MCP server（`mcp add` → 发现 1 个能力 → `call mcp://demo/tool/echo` 返回 `echo:{"msg":"hi"}` + 回执）；② SYAOCode 作 MCP **server**（`syao serve --mcp --stdio`）被第三方 client 驱动：`server/discover`（supportedVersions `2026-07-28` / ttlMs / cacheScope / serverInfo）→ `tools/list`（6 个受治理工具）→ `tools/call read`（真实文件内容） |
| A2A / ACP 适配器 | 实现完整；**已用官方 SDK 实测互通**（A2A `@a2a-js/sdk@1.3.0` 5/5；ACP `@agentclientprotocol/sdk@2.0.2` 6/6，见 §14）。**未做**：真实第三方编辑器（Zed/Neovim）的长期联调、真实跨组织 A2A 对端 |
| AgentCard 签名（JWS/Ed25519） | 结构已预留（`signatures` 字段与 `lossy` 标注），签名算法未实现 |
| OAuth 2.1 / PRM 发现 | 未实现（属协议侧传输安全，ARF 只做其上的治理） |
| MCP Tasks 扩展的长任务跟踪 | 状态映射已就绪（`TASK_TO_MCP`），扩展方法未实现 |
| 企业控制面（策略分发/审计聚合/多租户 SSO） | 按 anti-roadmap 不做 |
| 性能基准（p95 < 5ms） | **已实测**：十步流水线 300 次调用 p50=0.078ms / p95=0.115ms / p99=0.137ms；幂等重放 p95=0.029ms；策略解释 p95=0.013ms（`packages/rpc/test/bench.test.ts`，内存存储、无网络）。**远低于 02 §15 的 5ms 目标** |
| 跨协议黄金 trace | **3/3 稳定**：S1（ACP 编辑器：读→批→写→证据）、S2（A2A 远端 opaque 委派 + 预算结算）、S3（MCP MRTR 补输入 + 幂等重放），见 `packages/rpc/test/golden.test.ts` |
| 红队用例 | **11/11 通过**（02 §14.3 的可内核化子集），见 `packages/rpc/test/redteam.test.ts` |
| 边缘故障隔离 | 02 §16「Adapter 不可用」已落实：`mount()` 是**事务性**的（发现失败即回滚，不留毒化条目），`discover()` 对单个边缘失败**降级不抛错**，`status()` 报 `health: degraded` + `unavailable` + `reason`。一个不可达的 peer 不会让整个能力目录不可用 |

---

## 10. 与基线文档的关系

本实现**不修改** `document/SYAOCode/` 下的基线文档。建议的同步项见 `document/Agent-RPC/03 §9`，其中与本次实现直接相关的两条：

- `09-错误体系`：已新增 `A2A` 错误域，并填充预留码 `SY-MCP-006`、`SY-SRV-004`；
- `08-详细设计说明书`：DD-9/DD-17 应并入本实现的 `@syaocode/rpc` + `@syaocode/protocols`，避免两套服务协议。
