# 四、软件需求规格说明书（SRS）

## 4.1 引言

**目的**：定义 SYAOCode v1.0 的功能需求（FR）与非功能需求（NFR），作为设计、开发、测试与验收的唯一依据。

**读者**：开发者、测试者、插件作者、库使用者。

**产品形态**：一组 npm 包。核心是可嵌入的库，CLI 只是库的一个使用者。

| 包 | 职责 |
| --- | --- |
| `@syaocode/core` | 类型、agent 循环、事件、权限、上下文、会话、钩子、错误体系 |
| `@syaocode/providers` | 各模型接口适配器 |
| `@syaocode/tools` | 内置工具集 |
| `@syaocode/mcp` | MCP 客户端（及可选服务端） |
| `@syaocode/acp` | ACP 服务端与协议适配层 |
| `@syaocode/plugin` | 插件加载与生命周期 |
| `@syaocode/otel` | OpenTelemetry 集成 |
| `@syaocode/testing` | MockProvider、录制回放、评测工具 |
| `@syaocode/cli` | 参考命令行应用（Ink） |
| `syaocode` | 聚合入口，便于一行安装 |
| `@syaocode/decision` | DecisionProvider、问题模型、决策点框架与回放接口；JEV adapter 为 optional peer/subpath |
| `@syaocode/server` | 本地服务 API 与协议定义（v1.1） |
| @syaocode/client | 服务客户端 SDK，供 attach、Desktop 与第三方使用（v1.1） |
| `@syaocode/desktop` | Desktop 客户端（第二阶段，v1.0 不含） |
| `@syaocode/agents` | 三角色（hyaki、sota、common）编排、交接协议、预算统计与预设档位 |

**术语**：Agent 循环＝模型调用与工具执行的往复；Provider＝模型接口适配器；Harness＝包裹模型的运行框架；ACP＝Agent Client Protocol；MCP＝Model Context Protocol。

## 4.2 总体描述

**用户类别**：应用开发者（嵌入库）、CLI 终端用户、插件作者、MCP/ACP 生态方。

**运行环境**：Node.js 22 LTS 及以上；Linux、macOS、Windows；Bun 为兼容目标。

**依赖假设**：模型服务可通过 HTTPS 访问；用户自行提供密钥。

**优先级定义**：P0＝v1.0 必须；P1＝v1.0 应当；P2＝可推迟到 v1.x。

## 4.3 功能需求（FR）

以下 FR 描述「库提供的能力」。验收标准默认为：对应编号的测试用例（TC-nnn）通过，TC 编号与 FR 编号同号。

### 4.3.1 Agent 核心

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-001 | 提供 `createAgent(config)` 工厂，返回独立实例，支持多实例并存 | P0 |
| FR-002 | 实现 agent 循环：模型调用、工具执行、结果回填，直到无工具调用或满足终止条件 | P0 |
| FR-003 | 以 `AsyncIterable<AgentEvent>` 暴露类型化事件流，并提供 `await agent.run()` 便捷方法 | P0 |
| FR-004 | 同一轮内相互独立的工具调用可并行执行，结果顺序确定 | P0 |
| FR-005 | 支持 `AbortSignal` 中断，中断后会话状态一致、历史合法 | P0 |
| FR-006 | 终止条件：最大轮次、token 或费用预算、总超时、显式停止 | P0 |
| FR-007 | 循环检测：同工具同参数重复失败达阈值时干预或终止 | P1 |
| FR-008 | 运行中支持用户消息注入（steering）与排队 | P1 |

### 4.3.2 Provider 与模型

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-010 | 定义统一 Provider 接口与内部消息模型（内容块：文本、图片、tool\_use、tool\_result、thinking） | P0 |
| FR-011 | 内置 Anthropic Messages 适配器 | P0 |
| FR-012 | 内置 OpenAI Chat Completions 适配器，兼容 DeepSeek 等同类接口 | P0 |
| FR-013 | 内置 OpenAI Responses 与 Gemini 适配器 | P1 |
| FR-014 | Provider 通过 `capabilities` 声明特性，内核自动启用或降级 | P0 |
| FR-015 | 流式输出、指数退避重试、限流与超时处理 | P0 |
| FR-016 | 支持 prompt caching 标记、thinking/reasoning 内容的保留与回传、token 与费用用量统计 | P0 |
| FR-017 | Provider 注册表与模型路由（主模型、小模型、回退模型） | P1 |

### 4.3.3 工具系统与内置工具

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-020 | Tool 定义接口：Zod schema、描述、风险级别、只读标记、并发安全标记 | P0 |
| FR-021 | 工具注册表，名称唯一并支持命名空间 | P0 |
| FR-022 | 参数校验失败时返回结构化错误，便于模型自我纠正 | P0 |
| FR-023 | 工具结果截断与分页 | P0 |
| FR-024 | 工具执行超时与取消 | P0 |
| FR-025 | 工具可返回多模态内容（文本、图片） | P1 |
| FR-030 | `read`：支持行范围、图片与 PDF 文本 | P0 |
| FR-031 | `write`：整文件写入 | P0 |
| FR-032 | `edit`：唯一匹配替换，先读后写校验，外部修改检测 | P0 |
| FR-033 | `apply_patch`：补丁格式的多处编辑 | P1 |
| FR-034 | `glob`、`grep`：遵循 .gitignore | P0 |
| FR-035 | `bash`：超时、输出截断、后台任务、工作目录保持 | P0 |
| FR-036 | `web_fetch`、`web_search`：后端可插拔 | P1 |
| FR-037 | `todo`：任务清单，状态注入上下文 | P1 |
| FR-038 | `ask_user`：向用户提问并等待回答 | P1 |

### 4.3.4 权限与安全

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-040 | 权限引擎：allow / ask / deny 规则，按工具名与参数模式匹配 | P0 |
| FR-041 | 权限模式：default、acceptEdits、plan（只读）、bypass（需显式启用） | P0 |
| FR-042 | 路径围栏：工作区外访问需确认 | P0 |
| FR-043 | 命令风险分类（只读、写、危险）与危险命令拦截 | P0 |
| FR-044 | 权限请求通过可注入的 `PermissionHandler` 回调完成，库不假设任何 UI | P0 |
| FR-045 | 敏感信息脱敏（日志、事件、会话、错误） | P0 |
| FR-046 | 外部内容（网页、工具结果、MCP 返回）打上「不受信」标记 | P1 |
| FR-047 | 文件检查点与回滚 | P1 |

### 4.3.5 上下文与会话

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-050 | 模块化系统提示词组装（基础、环境、项目指令、工具说明），各段可覆盖 | P0 |
| FR-051 | 读取项目指令文件（默认 AGENTS.md，兼容 CLAUDE.md 等，可配置） | P0 |
| FR-052 | token 估算与上下文窗口监控 | P0 |
| FR-053 | 自动与手动上下文压缩 | P0 |
| FR-054 | 旧工具结果清理策略 | P1 |
| FR-055 | 跨会话持久记忆（用户级、项目级） | P2 |
| FR-060 | JSONL 追加式事件日志持久化 | P0 |
| FR-061 | 会话恢复、继续、分叉 | P0 |
| FR-062 | `SessionStore` 接口可替换（文件、内存、自定义） | P0 |
| FR-063 | 会话导出为 Markdown 或 JSON | P2 |

### 4.3.6 协议与互操作

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-070 | MCP 客户端支持 stdio 与 Streamable HTTP；协议版本/能力协商封装在 adapter 内 | P0 |
| FR-071 | MCP tools/list 与 tools/call 映射为 SYAOCode Tool；统一命名 `mcp__{server}__{tool}`，工具调用仍走本地权限管线 | P0 |
| FR-072 | MCP resources 与 prompts 的发现和读取，prompts 可映射到斜杠命令 | P1 |
| FR-073 | HTTP MCP 鉴权配置：自定义请求头与 OAuth；令牌进入密钥引用/密钥链，不写入项目文件或会话 | P1 |
| FR-074 | 处理工具列表变更通知与缓存失效；未完成刷新前不调用已撤销工具 | P1 |
| FR-075 | MCP 连接生命周期：启动超时、重连策略、健康状态与优雅关闭 | P0 |
| FR-076 | MCP Tasks 扩展、elicitation/MRTR 等高级能力以 capability/extension 方式可选实现 | P2 |
| FR-077 | 将 SYAOCode 自身暴露为 MCP Server | P2 |
| FR-080 | ACP server：独立协议适配包；会话、流式更新、权限请求、取消与客户端委托能力 | P2 |
| FR-081 | 抽象 Protocol / Transport 接口，允许新增 ACP/A2A/自有客户端协议 | P1 |
| FR-082 | 预留 A2A 适配接口，不承诺 v1.0 互操作 | P2 |
| FR-083 | 解析 `AGENTS.md`，并提供对 `CLAUDE.md` 等常见项目指令文件的可配置兼容 | P0 |

**MCP 版本策略**：当前开发基线以 MCP 2026-07-28 规范及对应 TypeScript SDK v2 为目标；应把协议版本、扩展能力和 SDK 版本记录到兼容矩阵。旧版 2025-11-25 server 可以通过兼容适配层接入，但不把已弃用的 legacy HTTP+SSE、旧 Tasks、Roots/Sampling/Logging 作为新功能的默认基础。具体行为在 M0 按官方规范逐项验证。

### 4.3.7 插件、钩子与子 agent

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-090 | 插件清单 manifest：名称、版本、引擎版本范围、能力、所需权限 | P1 |
| FR-091 | 插件可贡献工具、命令、钩子、provider、MCP 配置、技能 | P1 |
| FR-092 | 插件生命周期：发现、校验、加载、启用、禁用、卸载 | P1 |
| FR-093 | 插件错误边界：单个插件失败不影响宿主 | P1 |
| FR-094 | 插件 API 版本协商 | P1 |
| FR-095 | 插件脚手架 `create-syaocode-plugin` | P2 |
| FR-100 | 生命周期钩子（SessionStart、PreToolUse、PostToolUse、PreCompact、Stop 等），可阻断与改写输入 | P1 |
| FR-101 | Skills：按需加载的指令包 | P1 |
| FR-102 | 自定义斜杠命令 | P1 |
| FR-103 | 子 agent：独立上下文、受限工具集、可并行 | P1 |

### 4.3.8 可观测、配置与 CLI

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-110 | OpenTelemetry trace 与 metrics | P1 |
| FR-111 | 结构化日志，logger 可注入 | P0 |
| FR-112 | 会话级用量与费用聚合 | P0 |
| FR-120 | 分层配置（默认、用户、项目、环境变量、代码），Zod 校验 | P0 |
| FR-121 | 密钥管理：环境变量、可选系统密钥链，永不写入会话文件 | P0 |
| FR-130 | 参考 CLI：交互式终端界面 | P0 |
| FR-131 | 非交互模式（`-p`）与 JSON / stream-json 输出 | P0 |
| FR-132 | 斜杠命令、会话选择器、权限确认交互 | P1 |
| FR-133 | 文件修改 diff 展示 | P1 |

### 4.3.9 决策层（v0.3 修订）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-140 | 定义 `DecisionProvider` 与 Choice/Score/Noul 判定输入输出；结果包含答案、概率（若 provider 提供）、版本、耗时与错误元数据 | P0 |
| FR-141 | 可选 JEV adapter：配置 endpoint/model/credential reference；启动时验证配置但不强制需要 JEV 密钥 | P0 |
| FR-142 | 提供 deterministic provider 与 MockProvider；LLM judge adapter 为可选降级/对照，不是 JEV 不可用时的必经收费路径 | P0 |
| FR-143 | 决策点注册表：问题构造、状态白名单、阈值、模式、动作映射、失败策略与评测版本均须显式声明 | P0 |
| FR-144 | 决策点支持 off/shadow/enforce；默认 off，shadow 由用户显式启用；未评测的点不得启用 enforce | P0 |
| FR-145 | v1.0 内置 DP-01 请求路由、DP-03 风险提升、DP-07 完成度辅助建议（不替代确定性验收）；DP-08 失败语义分诊及注入检测经评测后再开放，安全基线始终由确定性规则保障 | P0 / P1 |
| FR-146 | 每次决策输出 `decision` 事件并持久化决策点、输入摘要哈希、provider/model 版本、概率、阈值、动作、耗时与降级标记 | P0 |
| FR-147 | 超时、重试、429、熔断与恢复探测；安全类失败回退 ask/deny；其他类别回退 deterministic default | P0 |
| FR-148 | `syao decision report/replay` 校准报告；生成混淆矩阵、成本、延迟、覆盖率和用户覆盖记录 | P1 |
| FR-149 | 低置信级联：规则 → JEV/其他 judge → sota/主 LLM → 用户；高风险权限决策最终只能由权限引擎与用户控制 | P1 |

**决策边界**：JEV 不能读取任意主模型 chain-of-thought，不对文件和命令拥有执行权限，也不能将 `deny` 改成 `allow`。对安全风险判断，模型结果只能收紧动作或要求更多确认。对完成度判断，所有非确定性结果均需在报告中标为“语义判断”，不得伪装成测试证明。

### 4.3.10 CLI 命令与交互（v0.3 修订）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-134 | 入口：`syao` 进入 TUI；`syao "prompt"` 带初始提示；`syao -p/--print` 与 `syao exec` 非交互；支持 stdin 管道、`@path` 文件引用、`!command` 受权限管线约束的 shell 入口、`/` 斜杠命令 | P0 |
| FR-135 | 参数：`--model`、`--permission-mode`、`--allowed-tools`、`--disallowed-tools`、`--add-dir`、`--max-turns`、`--max-budget-usd`、`--output-format`、`--input-format`、`--verbose`、`--agent`、`--agents-preset`、`--mcp-config`、`--cwd` | P0 |
| FR-136 | 子命令：`mcp`、`config`、`doctor`、`resume`、`agents`；插件、serve/attach、复杂决策报告按阶段开放 | P0 / P1 |
| FR-137 | 内置斜杠命令：`/help`、`/model`、`/permissions`、`/compact`、`/clear`、`/resume`、`/rewind`、`/mcp`、`/status`、`/cost`、`/agents`、`/goal`、`/exit`；高级扩展按 P1 开放 | P0 |
| FR-138 | 按键：Esc 中断；Ctrl+C 安全退出；Ctrl+R 历史搜索；Tab/Shift+Tab 模式切换需显示当前模式且不得隐式放宽权限 | P1 |
| FR-139 | `/goal` 设定目标与验收条件；`/loop` 在 P1 版本提供受上限约束的定时/条件循环；`/init` 生成可审阅的项目指令文件 | goal P0；loop/init P1 |
| FR-173 | `syao --version`、`--help`、`doctor` 可在无 Provider key 时运行；`doctor` 检查 Node、工作区、配置、权限、Provider 和 MCP，但不得打印密钥 | P0 |
| FR-174 | 非交互 stdout 只输出所选协议数据；提示、调试、进度默认写 stderr；`stream-json` 每行是一条具 schemaVersion 的事件 | P0 |

**推荐命令形态**：主入口使用 `syao`，npm 包名为 `syaocode`；可提供 `syaocode` 与 `sy` 二级别名，但文档和脚本统一使用 `syao`。不要同时让多个二进制成为不同的产品行为实现。

### 4.3.11 服务化与 Desktop 就绪（v0.3 修订）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-150 | `syao serve`：本地服务暴露会话、AgentEvent 订阅、取消、权限请求、状态与报告 | P1 |
| FR-151 | `syao attach <url>`：TUI 连接服务；多个客户端可以观察同一会话，但一个权限请求只能有一个有效应答者 | P1 |
| FR-152 | `@syaocode/client`：服务客户端 SDK，供 attach、Desktop 与第三方使用 | P1 |
| FR-153 | 服务协议带版本协商；发布 JSON Schema/OpenAPI；未知非关键事件可忽略、关键事件不兼容必须失败关闭 | P1 |
| FR-154 | 默认只绑定回环地址/本地套接字；远程监听需显式配置与令牌；请求鉴权、权限审计、连接来源限制 | P1 |
| FR-155 | Desktop 就绪度清单：会话、diff、权限提示、多工作区、设置、取消、恢复、离线状态和数据目录迁移 | P2 |

### 4.3.12 三角色 agents、/goal 与 /loop（v0.3 修订）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-160 | 内置 hyaki、sota、common 三角色；可配置模型、提示词、工具集、预算和权限上限 | P0 |
| FR-161 | AgentOrchestrator 按任务规模、风险、预算与显式用户设置分流；小任务直达 common | P0 |
| FR-162 | hyaki 对长输入分块、并行摘要与层级归并；Brief 含引用、精确字面量、未确定项；原文可回读 | P0 |
| FR-163 | sota 输出结构化 Plan：步骤、依赖、验收器、风险、所需权限、预算和停止条件；默认只读 | P0 |
| FR-164 | common 按步骤执行，记录 diff、命令结果、测试证据；连续失败或偏离计划时请求重规划 | P0 |
| FR-165 | Brief/Plan/Result/EvidenceReceipt 交接 schema 版本化与校验；交接只携必要上下文，不默认转交完整历史 | P0 |
| FR-166 | 按角色统计 token、费用、耗时、重规划次数、验收率；支持总预算和角色上限 | P0 |
| FR-167 | `economy/balanced/max` 预设与用户自定义角色；配置必须显示“模型档位不代表安全权限” | P0 |
| FR-168 | hyaki 低保真时回读原文；common 连续失败时升到 sota；Provider 不可用时按显式回退链切换 | P1 |
| FR-169 | 长输入分块可并行；文件写入默认经一个执行协调器串行化，避免多个角色竞争修改同一文件 | P1 |
| FR-170 | `/goal`：用户指定目标、验收条件、预算、最长轮次/时长；验收器优先、语义 judge 次之、未验证则不能报告“确定完成” | P0 |
| FR-171 | `/loop`：按固定间隔或事件条件重复运行，具备 `maxRuns`、`until`、`timeout`、每轮与总预算、取消与暂停 | P1 |
| FR-172 | loop/后台任务状态落盘，提供暂停/恢复/查看/终止命令；连续失败、授权缺失或预算耗尽时必须停下并输出报告 | P1 |

## 4.4 非功能需求（NFR，工具库视角）

| ID | 类别 | 需求 | 验证方式 |
| --- | --- | --- | --- |
| NFR-001 | 性能 | 导入核心包冷启动 ≤ 150ms（不含 provider SDK 初始化） | 基准测试 |
| NFR-002 | 性能 | 单次循环迭代的库自身开销 P95 ≤ 20ms；事件分发 ≤ 1ms | 基准测试 |
| NFR-003 | 性能 | 10 万条事件的会话恢复 ≤ 3s，流式读取，峰值内存 ≤ 200MB | 压力测试 |
| NFR-004 | 并发 | 同进程 ≥ 20 个 agent 实例并行且无状态串扰 | 并发测试 |
| NFR-005 | 可靠性 | 单个工具、插件、MCP 失败不使宿主崩溃，错误均归入 SyaoError 体系 | 故障注入 |
| NFR-006 | 可靠性 | 异常退出后会话可恢复，至多丢失最后一条未完成事件 | 崩溃测试 |
| NFR-007 | 可靠性 | 所有网络与子进程调用具备超时与取消，无悬挂句柄与资源泄漏 | 句柄泄漏检测 |
| NFR-008 | API 稳定 | 遵循 SemVer，公共 API 面由 API Extractor 报告锁定，破坏性变更仅随主版本 | CI 报告比对 |
| NFR-009 | 类型 | TypeScript strict，公共 API 零 `any`，完整 `.d.ts`，含类型测试 | 类型测试 |
| NFR-010 | 类型 | 事件与错误使用可辨识联合，支持穷尽检查 | 类型测试 |
| NFR-011 | 可嵌入 | 导入无副作用；不接管 stdout、stderr 与进程信号；IO 经注入的 FileSystem、Shell、Clock、Logger、HttpClient 抽象 | 嵌入示例与静态检查 |
| NFR-012 | 可嵌入 | 核心包不依赖 UI 库；无全局单例状态 | 依赖检查 |
| NFR-013 | 模块 | ESM 优先，类型随包发布，CJS 项目可经 Node 22 的 require(esm) 使用 | 集成测试 |
| NFR-014 | 兼容 | Node ≥ 22；三平台 CI 全绿；Bun 冒烟通过 | CI 矩阵 |
| NFR-015 | 依赖 | core 运行时依赖 ≤ 5；无 postinstall；依赖许可证白名单 | 依赖审计 |
| NFR-016 | 体积 | core ≤ 150KB gzip（不含 provider SDK）；`sideEffects: false`，子路径导入可 tree-shake | 体积预算检查 |
| NFR-017 | 安全 | 默认最小权限；密钥不落盘；脱敏覆盖率经测试证明 | 安全测试 |
| NFR-018 | 供应链 | 锁文件、npm provenance 发布、CI 依赖审计 | CI |
| NFR-019 | 可观测 | 关键路径均有事件与 trace；默认不上传任何遥测 | 评审与测试 |
| NFR-020 | 可测试 | core 行覆盖率 ≥ 80%、分支 ≥ 70%；提供 MockProvider 与录制回放 | 覆盖率报告 |
| NFR-021 | 可维护 | 循环依赖为 0；圈复杂度 ≤ 15；lint 无告警 | 静态检查 |
| NFR-022 | 文档 | 每个公共导出有 TSDoc，每个包有 README 与可运行示例 | 文档检查 |
| NFR-023 | 国际化 | 错误含稳定 code，message 默认英文，提供 zh-CN 消息表 | 单元测试 |

### 4.4.1 v0.3 新增非功能需求

| ID | 类别 | 需求 | 验证方式 |
| --- | --- | --- | --- |
| NFR-024 | 性能 | 决策服务调用设超时（初值 1500ms，WP-0 校准）；超时即按类别回退；记录决策层对总延迟与费用的影响，不以牺牲安全换取延迟 | 基准测试与影子遥测 |
| NFR-025 | 可靠性 | 决策服务不可用、超时或返回非法时，主循环不阻塞、不崩溃；连续失败触发熔断 | 故障注入 |
| NFR-026 | 隐私 | 外发状态仅含白名单字段并经脱敏；默认不含文件全文与主模型推理；可整体禁止外发 | 安全测试与字段审计 |
| NFR-027 | 性能 | CLI 从启动到可输入 ≤ 500ms；MCP 连接异步建立，不阻塞输入 | 启动基准 |
| NFR-028 | 兼容 | 服务协议带版本号并支持协商；同一主版本内向后兼容；AgentEvent schema 随之版本化 | 合约测试 |
| NFR-029 | 安全 | serve 默认仅绑定回环地址或本地套接字，需令牌鉴权，令牌文件权限 0600 | 安全测试 |
| NFR-030 | 可重放 | 决策日志包含重放所需的全部输入摘要，相同模型版本与阈值下离线重放结果可复现 | 回放测试 |
| NFR-031 | 稳定性 | `-p` 的 json 与 stream-json 输出 schema 版本化，退出码按 BR-042 固定 | 合约测试与快照 |
| NFR-032 | 成本 | economy 档在内部评测集上的总成本较「全程 sota」基线目标下降 ≥ 25%，通过率下降 ≤ 5 个百分点；M2 建立基线后再确认，不达标不得宣称省成本 | 评测对比 |
| NFR-033 | 可追溯 | hyaki 摘要中的关键事实均带可回溯引用，抽检回读一致率 ≥ 95%，植入事实保留率 ≥ 90% | 抽检与摘要保真评测 |
| NFR-034 | 无人值守 | 所有已交付的 goal/loop 运行 100% 受预算、轮次与时长上限约束，达限必停并生成报告（对应版本未交付的功能不作为该版本阻塞项） | 边界与故障测试 |
| NFR-035 | 交接 | 交接物 schema 校验失败率 ≤ 1%，失败自动重试一次；角色编排额外延迟（不含模型调用）P95 ≤ 50ms | 合约测试与基准测试 |

## 4.5 外部接口与约束

- **模型接口**：v1.0 优先一个 OpenAI-compatible Provider 与一个原生 Provider；其他官方 API 按 `Provider` adapter 扩展。
- **协议接口**：MCP 客户端（v1.0）、SYAOCode 本地服务协议（v1.1）、ACP/A2A（v1.x 规划）。
- **文件与进程**：通过 FileSystem、Shell 抽象访问，默认实现基于 Node。
- **约束**：许可证 Apache-2.0；不内置任何密钥；默认不收集遥测。

* **决策服务接口**：JEV 作为可选适配器接入；优先验证官方 SDK 与 REST 契约，endpoint、字段和定价在 WP-0 锁定；其他决策模型按 `DecisionProvider` 接入。

## 4.6 验收总则

全部 P0 需求对应测试用例通过；NFR 达标；内部评测集通过率 ≥ 60%；高风险项均有已落实的应对措施。

---
