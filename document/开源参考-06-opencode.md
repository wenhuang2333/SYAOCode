# 开源参考分析 06：opencode（sst 开源 AI coding agent，V2）

| 项 | 内容 |
| --- | --- |
| 参考目录 | `reference/opencode-dev` |
| 项目定位 | 开源 AI coding agent：TUI + Web + Desktop + 后台 service + HTTP server + 可嵌入 SDK + ACP |
| 许可证 | MIT |
| 技术栈 | **Effect 4**（Schema/Layer/Fiber/Stream/HttpApi）+ Bun；TUI 为 OpenTUI + SolidJS；Desktop 为 Electron |
| 版本快照 | V2.0.29（V2 完全重写版；V1 的 Vercel AI SDK + 目录式 JSON 存储仅存遗迹于 `packages/core/src/v1/`） |
| 调研日期 | 2026-10-15 |

> **重要前提**：本地仓库是 V2 重写版，全仓基于 Effect 4 与 Bun，与 2025 年流传的 V1（Vercel AI SDK + 自研 JSON 存储）是两套代码。对 SYAOCODE 最有参考价值的是 **V2 的分层边界（Schema → Core → Protocol → Server → Client → SDK）与「SDK = 内存中执行的 server」设计**，而非 V1 的 AI SDK 用法。opencode 是 TS 生态里与 SYAOCODE 形态最接近的项目（同为 TS agent harness，库/CLI/server 多形态），其契约文件本身就是最好的 API 设计模板。

---

## 一、项目概况与包结构

依赖方向（CONTRIBUTING.md 明文规定）：**Schema → Core → Protocol → Server；Client 只依赖 Schema/Protocol；SDK 组合 Client+Core+Server**。

| 包 | 职责 |
| --- | --- |
| `packages/schema` | 全部 wire/存储契约（Effect Schema），无逻辑 |
| `packages/core` | 领域行为 + 持久化（session/tool/permission/config/mcp/plugin/bus/database） |
| `packages/protocol` | 公开 HTTP API 定义（HttpApi groups + openapi.json，139 个端点） |
| `packages/server` | HTTP server 组装、auth、SSE 事件流 |
| `packages/client` | **从 server 的 HttpApi 代码生成**的 TS 客户端（禁止手改，check 防漂移） |
| `packages/sdk` | 进程内嵌入 host：在内存中执行 server 路由（无监听端口） |
| `packages/cli` / `packages/tui` | CLI 入口 / OpenTUI+SolidJS 终端界面 |
| `packages/ai` | **自研多模态 provider 层**（60+ provider） |
| `packages/plugin` | 插件 API（Promise 版 + Effect 版双入口） |

这一「契约包独立、客户端生成、SDK 与 server 同物」的分层与 SYAOCODE 的 `@syaocode/*`（core/providers/tools/mcp/server/client/cli）几乎一一对应，是 TS 侧最成熟的同形态实证。

---

## 二、与 SYAOCODE 构件的映射总览

| SYAOCODE 构件 | opencode 对应物 | 参考强度 |
| --- | --- | --- |
| serve/attach + @syaocode/client（DD-17） | **SDK=内存 server + 生成客户端 + SSE 事件流** | ★★★（最直接） |
| 权限引擎（DD-5） | Rule{action,resource,effect} + deny 一票否决 + 批量应答语义 | ★★★ |
| bash 命令权限（DD-5 / BR-006） | tree-sitter WASM 解析 + save 前缀通配 + opaque 降级 | ★★★ |
| Agent Loop（DD-2） | 一步一 llm.stream、无内存 tool 循环、步级 outcome 状态机 | ★★★ |
| 上下文压缩（DD-6） | 预留式上限 + 实测 token 锚定估算 + 阶梯收缩 | ★★★ |
| JSONL 会话（DD-7） | SQLite 事件溯源 + seq 游标回放 + inbox 持久化 | ★★ |
| Provider 层（DD-3） | 自研 @opencode/ai + providerOptions 能力化失败 + AI SDK 桥 | ★★★ |
| 内置工具（DD-4） | edit 三级匹配回退/CRLF/BOM/formatter/文件锁 | ★★★ |
| 模型目录 | models.dev 注册表 + 内置快照兜底 | ★★ |
| 插件/配置（DD-10/11） | 双 API 插件 + markdown agent 定义 + 配置热重载 | ★★ |
| 非交互模式（FR-131） | --prompt + SSE 渲染 + json 输出 + 权限自动拒绝反馈 | ★★ |

---

## 三、对 SYAOCODE 各构件的具体参考意义

### 3.1 「SDK = 内存中执行的 server」（映射 DD-17 / FR-152）——本篇最高价值

`packages/sdk` 的 `OpenCode.create()` 用 Effect 把 server 路由转成**内存 Web handler**，再包一个回环 fetch（不监听端口、零网络开销）——**嵌入式 SDK 与 HTTP server 共享同一套 API 契约，仅传输不同**。`packages/client` 则从 `packages/protocol` 的 HttpApi 定义**代码生成**（生成物禁止手改，CI `check:generated` 防漂移），CLI/TUI/SDK 全部走这个客户端——"所有前端都是 server 的客户端"。

**参考意义**：这直接回答了 SYAOCODE 的一个架构命题——`@syaocode/client`（v1.1）与库形态如何不漂移。落地方式：`@syaocode/protocol` 包定义 API（OpenAPI/JSON Schema 单源）→ 生成 `@syaocode/client` → `syao serve` 用同一组 handler 挂 HTTP → 进程内嵌入时同一组 handler 直接函数调用。v1.0 就应把「内核操作面」与「HTTP 面」设计为同构（即便 HTTP 到 v1.1 才暴露），避免库 API 与 server API 两套语义。

### 3.2 权限系统数据模型（映射 DD-5 / BR-001）——另一最高价值

`packages/core/src/permission.ts`：

- **规则模型**：`Rule = { action, resource, effect: allow|deny|ask }`；action 与 resource 都是 **glob**（`*`→`.*`、`?`→`.`，Win32 大小写不敏感、路径反斜杠归一）。
- **求值**：`findLast` 后写的规则赢 + 默认兜底 ask；**任一 deny 命中直接 BlockedError（一票否决）**；用户点过 always 的已保存规则**追加在尾部再评估**。
- **审批语义**：ask 时创建 Request 并发布 `permission.asked` 事件，工具 fiber 挂起等待；应答 = `"once" | "always" | "reject"`——**reject 带反馈走 CorrectedError（反馈回给模型继续）vs 纯拒绝走 DeclinedError 双通道**；always 且有 save 字段则按 project 持久化规则，并**自动放行其他此刻评估为 allow 的 pending ask**；同一 session 的 pending ask 在拒绝时**批量拒绝**。
- **审批请求携带 metadata**：edit/write 审批附带**变更预览 diff**（审批 UI 直接展示）。

**参考意义**：SYAOCODE DD-5 的 PermissionDecision（allow/deny + remember + message）可升级为该模型——① deny 一票否决与 BR-001 一致；② 「reject with feedback」是 SYAOCODE 缺失的能力（拒绝时给模型纠错提示，对应错误体系 9.8 modelMessage 思想在审批面的延伸）；③ 批量放行/拒绝语义（一次 always 影响同类 pending）是 UX 细节但很关键；④ 审批请求带 diff 预览对应 FR-133 diff 展示。

### 3.3 bash 命令权限解析（映射 DD-5 / BR-006）

- `shell/parse.ts`：用 **web-tree-sitter（WASM bash/powershell parser）** 把命令串解析为子命令列表，每条产出 `{ resource: 命令文本, save: "命令前缀 + *"` }（如 `git commit *`）——"总是允许"保存的是**前缀通配**而非精确串；带 ARITY 表识别 cd/ls 参数边界。
- `shell/scan.ts`（1300+ 行手写扫描器）兜底 tree-sitter 覆盖不了的语法；**解析不了的（命令替换/复合命令/heredoc 等 9 种）标记 opaque，整体作为一条不可细分匹配的命令**。
- 一条复合命令的每个子命令**单独匹配、单独可保存**。

**参考意义**：SYAOCODE DD-5 的命令风险分类（按 `&&`/`||`/`;`/`|` 拆片段 + 白名单比对）是字符串级实现；opencode 证明可以上 AST 级（WASM parser 在 TS 生态可用）。建议 SYAOCODE v1.0 保持字符串级（简单可靠），把「AST 解析 + 前缀通配 save + opaque 降级」列为 v1.x 升级路径——**"解析不了就整体 ask"的降级哲学与 SYAOCODE「无法解析的命令一律视为 ask，不尝试猜测」完全一致**。

### 3.4 Agent Loop：一步一调用（映射 DD-2 / FR-002/006）

- **Prompt 先持久化后执行**：`Session.prompt()` 先发布 inbox 事件（durable，投影入库）再唤醒执行；投递时同事务插入可见消息。支持 **queue / steer 双投递模式**（排队 vs 转向注入）。
- **每一步 = 一次显式 `llm.stream` 调用，禁止内存内 tool 循环**（AGENTS.md 明文约束）：每步从重载的历史重建请求；步前先跑压缩检查。
- **步级 outcome 状态机**：`Completed{needsContinuation} | Retry | Continue（断流续跑，注入合成消息） | RecoverFull | Compacted | OutputLimit`——输出上限要连续 3 个 `finish=length` 才报错；max-steps 到限时注入提示消息并把 `toolChoice: "none"`（**保留工具定义以保住 provider 缓存前缀**）。
- **工具并发**：流消费中遇 tool-call 即 fork 工具 fiber（保持 per-source 顺序）；大输出截断落盘；只有用户拒绝留在类型化错误通道。
- **取消**：Fiber 中断模型分层——流中断中断全部工具；最终结算事件不可中断；启动前中断不留记录。
- **执行所有权**：写前 claim，进程死亡保留 claim，**重启时恢复 claimed 的会话**；崩溃遗留的 running 压缩/工具调用结算为 aborted。

**参考意义**：与 SYAOCODE DD-2 高度同构并补强五点——① 「每步重建请求」= 天然可重入（与 goose 状态机殊途同归，且更轻）；② 断流 Continue 的合成消息续跑（对应 SY-PRV-007 流中断重试的补充语义）；③ toolChoice:"none" 保缓存前缀的 max-turns 收尾（BR-010 的优化实现）；④ queue/steer 双模式（FR-008 steering 的字段化）；⑤ 重启恢复 claimed 会话 + 结算僵尸状态（NFR-006 的多进程版本）。

### 3.5 压缩策略（映射 DD-6 / BR-013）

非固定 80% 阈值，而是 `window - max(10% window, 16k)` 的**预留式上限**（RESERVE_MIN=16k）；overflow 时按 `SHRINK_STEPS=[0.7,0.5,0.35]` 逐级收缩；**token 估算以"最近一次 provider 实测 input tokens 为锚 + 之后增量估算"**（比纯本地估算准得多）；触发点在每步请求前。

**参考意义**：① 预留式上限（绝对量保底）优于纯比例（结合 goose 的双阈值思想）；② 「实测锚定估算」直接可抄——SYAOCODE DD-6「用上一轮真实 usage 持续校准」的具体化；③ 阶梯收缩（一次压不够就缩更狠）防压缩反复触发。

### 3.6 Provider 层（映射 DD-3 / FR-010~017）

- 主路径是**自研 `@opencode/ai`**（从 V1 的 Vercel AI SDK 迁出）：Effect Schema-first 的 provider 无关 API；每个 provider 暴露 configure + responses/chat/messages 选择器；**providerOptions 按 model 推断类型、未知字段透传、不支持的字段在网络调用前类型化失败**（UnsupportedOperation）。
- 保留 **`aisdk:` 桥**：任意 `@ai-sdk/*` 的 LanguageModelV3 适配进自有体系——长尾 provider 兜底。
- 模型目录：**models.dev 注册表**（默认源 + **内置提交快照兜底** + digest 缓存 + 后台刷新），解析出 limit/cost（含 cache read/write 与 context 分层计价 tiers）/reasoning_options/tool_call。
- provider 原生压缩能力（OpenAI Responses /responses/compact、Anthropic in-band contextManagement）以 `LLMClient.canCompact()` 能力收窄。

**参考意义**：SYAOCode.md 预研 T2 已决策「内容块 + capabilities + 独立 adapter」，opencode V2 的迁移（AI SDK → 自研）是同决策的**事后验证**；可吸收——① providerOptions 的「按模型推断 + 透传 + 预检失败」API 形态（对应 R-03 抽象泄漏的防御）；② models.dev 作为模型元数据源 + 快照兜底策略（解决模型目录维护成本）；③ AI SDK 桥作为可选 provider 入口（SYAOCODE P1 的 OpenAI Responses/Gemini 可先走桥再原生）。

### 3.7 内置工具细节（映射 DD-4 / FR-030~034 / BR-004/005）

- **edit**：先读后写；**三级匹配回退**（精确 → Unicode 规范化：弯引号/破折号/宽空格 → 行级尾随空白不敏感）；多匹配且非 replaceAll 即失败；**CRLF/LF 混合行尾 LCS 对齐保留**；BOM 保留；写后跑 formatter（LSP）再读回；**按文件路径加锁**防并发写；审批 metadata 附 diff 预览。
- **write**：自动建父目录、BOM 保留、diff 预览、先权限后写。
- **read**：文件/目录统一、默认 2000 行上限、`<line>: <content>` 前缀、图片/PDF 直接送模型、不存在时尝试兄弟目录 alternatePath。
- **shell**：后台任务模式（完成通知合成消息）、默认 2 分钟超时、输出截断落盘、env 注入 AGENT 标识。

**参考意义**：edit 的三级匹配回退直接提升编辑成功率（对应 R-04 编辑失败率风险与 PoC-3 的 95% 目标）；CRLF/BOM/行尾保真、文件锁、formatter 回读都是 SYAOCODE edit 算法（DD-4 六步）可并入的细节。

### 3.8 事件与持久化（映射 DD-2 / DD-7）

- **durable/ephemeral 事件二分**：durable 事件先写 `event` 表（aggregate_id + seq）再分发，投影器同事务更新读模型；流式 delta 也是 durable（用 batching 缓解写放大）；ephemeral 事件只广播。
- `bus.log({aggregateID, after, follow})` 提供游标回放 + 跟随（`GET /api/session/:id/log`）——JSONL tail -f 的等价物。
- SSE `/api/event`：每订阅者 dropping Queue（容量 4096，溢出断开慢消费者）；首事件 server.connected。
- 鉴权：HTTP Basic（固定用户名 + 本地随机密码）或 **HMAC 签名 session token**（30 天 TTL，轮换密码即全部失效、timingSafeEqual）；一次性 pairing link 给浏览器/Desktop。

**参考意义**：① durable/ephemeral 二分是 SYAOCODE 事件分级决策的又一印证（delta 是否落盘可配置：opencode 全 durable + batching，ZCode 全 transient，SYAOCODE 可取中间——delta 默认 ephemeral、可显式开启）；② SSE 慢消费者策略（有界队列 + 溢出断开重连）对应 DD-15 背压设计；③ HMAC token + 密钥轮换全失效 + pairing link 丰富 BR-041 的实现选项。

### 3.9 插件与 agent 自定义（映射 DD-10/11 / FR-090~103）

- 插件双 API（Promise 版 + Effect 版），能力面覆盖 agent/tool/session hook/permission.evaluate 钩子/RPC/per-plugin durable storage。
- agent 定义两通道：config JSON 的 `agents` 表（model/headers/system/mode/permissions/steps）与 **markdown agent 文件**（frontmatter + 正文即 system prompt，`{agent,agents}/*.md` 为子 agent、`{mode,modes}/*.md` 为主模式）；内置 build/plan/general/explore/compaction/title。
- 配置热重载（watch + 100ms debounce + `config.updated` 事件）；指令文件 AGENTS.md 沿目录祖先链向上收集。

**参考意义**：markdown agent 定义（frontmatter + 正文 = prompt）与 SYAOCODE 的三角色自定义（FR-160「可配置模型、提示词、工具集」）契合——SYAOCODE 的角色配置除 JSON 外可提供 markdown 形态；内置 compaction/title 专用小 agent 对应 SYAOCODE ModelRouter 的 fast 角色，但以 agent 形态定义更可组合。

---

## 四、可移植功能清单

| 功能 | 源位置 | 移植到 SYAOCODE | 成本 |
| --- | --- | --- | --- |
| SDK=内存 server + 生成客户端 | `packages/sdk/src/internal/{host,fetch}.ts`、`packages/client/` | 协议/client/server 同构架构 | 高（架构级） |
| 权限 Rule/glob/批量应答/reject-feedback | `packages/core/src/permission.ts`、`util/wildcard.ts` | DD-5 权限引擎 | 低 |
| bash tree-sitter 解析 + save 前缀 + opaque | `core/src/shell/{parse,scan}.ts` | BR-006 命令分类（v1.x） | 中 |
| 步级 outcome 状态机 + 断流 Continue | `core/src/session/runner/{llm,step,max-steps}.ts` | DD-2 循环细化 | 中 |
| 预留式压缩上限 + 实测锚定估算 | `core/src/session/compaction.ts` | DD-6 压缩阈值 | 低 |
| providerOptions 能力化失败 API 形态 | `packages/ai/src/` | DD-3 Provider 接口 | 低 |
| models.dev + 快照兜底 | `core/src/models-dev.ts` | 模型目录数据源 | 低 |
| edit 三级匹配/CRLF/BOM/文件锁/formatter | `core/src/tool/plugin/edit.ts` | DD-4 edit 算法 | 低 |
| inbox queue/steer 双投递 | `core/src/session/inbox.ts` | FR-008 steering | 中 |
| SSE 慢消费者断开 + HMAC token + pairing | `server/src/{event-feed,auth,pairing}.ts` | DD-17 serve 安全 | 低 |
| markdown agent 定义 | `core/src/config/plugin/agent.ts` | FR-160 角色配置形态 | 低 |

## 五、可落实的思路（关联 SYAOCODE 文档条款）

1. **架构决策（新增 ADR）**：`@syaocode/protocol` 单源定义内核操作面与 HTTP 面（OpenAPI/JSON Schema 同源）；`@syaocode/client` 由契约生成并 CI 防漂移；`syao serve`（v1.1）与进程内嵌入复用同一 handler 集。v1.0 先以 TypeScript 接口冻结操作面。
2. **DD-5 修订**：规则模型采用 `{action, resource(glob), effect}` + deny 一票否决 + 兜底 ask；PermissionDecision 增加 `feedback?`（拒绝时回传模型的纠错提示）；always 应答自动放行同类 pending、reject 批量拒绝；审批请求 metadata 携带 diff 预览。
3. **DD-4 edit 算法增强**：三级匹配回退（精确/Unicode 规范化/行级空白不敏感）、CRLF+BOM 保真、按路径文件锁、（可选）写后 formatter 回读；对应 PoC-3 通过率目标。
4. **DD-6 压缩参数**：阈值 = window − max(10%·window, 16k)；估算以最近实测 input tokens 为锚；阶梯收缩 [0.7, 0.5, 0.35]。
5. **DD-2 补强**：断流恢复注入合成 continue 消息（区别于整请求重试）；max-turns 收尾用 toolChoice:"none" 保缓存前缀；steering 消息队列区分 queue/steer 两种合并模式。
6. **DD-3 Provider API**：请求选项采用「按模型推断类型 + 未知字段透传 + 不支持能力预检失败（SY-PRV-006）」；模型元数据接入 models.dev + 内置快照。
7. **DD-17 安全选项**：serve 鉴权支持 HMAC 签名 token（密钥轮换全失效）与一次性 pairing link；SSE 每订阅者有界队列、溢出断开。
8. **FR-160**：角色定义提供 markdown 形态（frontmatter 元数据 + 正文 prompt），与 JSON 配置并存；内置 compaction/title 快速任务显式建模为受限 agent（只读、小模型）。

## 六、不适合照搬与风险

- **Effect 全家桶**：opencode V2 复杂度大头来自 Effect（Layer 图、Fiber 中断语义、双 API 面）。SYAOCODE 保持 Promise/AbortSignal 风格（预研 T1 决策），只借语义（事件溯源、权限语义、步状态机），**不引入 Effect 运行时**——这会与「core 运行时依赖 ≤5、可嵌入、类型简单」的 NFR-011/015 冲突。
- **Bun 绑定**：SYAOCODE 面向 Node 22+（Bun 仅冒烟）。
- **durable 全量 delta**：写放大明显；SYAOCODE delta 默认 ephemeral。
- **60+ provider 广度、多模态（视频/语音/转写）、workerd/企业包**：远超 v1.0 范围。
- **无原子写**：opencode 的 FileMutation 直接写而非 tmp+rename——SYAOCODE 坚持 DD-5/BR 的原子写（*.part + os.replace）不变。
- **规模**：core 68k 行 + tui 62k 行是 30+ 人全职产物；SYAOCODE 聚焦其**契约文件**（schema/protocol 的 .ts 是最好的 API 设计模板）。
- **许可证**：MIT；只借鉴契约形状与语义。

## 七、关键源码索引

| 主题 | 路径（相对 `reference/opencode-dev/`） |
| --- | --- |
| 权限 | `packages/core/src/permission.ts`、`packages/schema/src/permission.ts`、`core/src/util/wildcard.ts` |
| shell 解析 | `packages/core/src/shell/parse.ts`、`shell/scan.ts` |
| Agent loop | `packages/core/src/session/runner/{llm,step,max-steps}.ts`、`session/{execution,inbox,compaction}.ts` |
| 工具 | `packages/core/src/tool/plugin/{read,write,edit,patch,shell,subagent,skill,question}.ts` |
| Provider | `packages/ai/src/{llm,provider}.ts`、`providers/`、`core/src/{models-dev,aisdk}.ts` |
| 持久化/事件 | `packages/core/src/{bus.ts,database/schema.gen.ts}`、`packages/schema/src/session-event.ts` |
| Server/SDK/Client | `packages/protocol/src/api.ts`、`packages/server/src/{routes,auth,event-feed,pairing}.ts`、`packages/sdk/src/internal/{host,fetch}.ts` |
| API 审计 | 根 `V2_HTTP_API_AUDIT.md`、`packages/protocol/openapi.json` |
| 配置/插件/agent | `packages/core/src/config/plugin/agent.ts`、`packages/plugin/src/` |
| 非交互 | `packages/cli/src/run/noninteractive.ts` |
