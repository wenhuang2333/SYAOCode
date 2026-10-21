# 开源参考分析 07：DSH缓存分析+优化器（DeepSeek 前缀缓存逆向分析与优化项目）

| 项 | 内容 |
| --- | --- |
| 参考目录 | `reference/DSH缓存分析+优化器` |
| 项目定位 | 自定义分析项目（非知名开源项目）：对 DeepSeek Harness（dsh）的 prompt cache（前缀缓存）机制做逆向分析，并用真实生产日志验证「稳定前缀重构」能否把缓存命中率从 ~3–6% 提升到 ~100% |
| 许可证 | 未包含许可证文件（含 dsh 源码快照一份，dsh 本身为 MIT）；**只参考方法与结论，不复制代码** |
| 技术栈 | TypeScript（Node ≥22.6 原生 type-stripping，零依赖）+ Go 双实现；test.js 活端点验证器 |
| 调研日期 | 2026-10-15 |

> 项目三层结构：`deepseek-harness/`（dsh 0.2.1-alpha.3 完整源码快照，与 `reference/deepseek-harness-master` 同源）、`prompt-cache-core/`（自研零依赖剥离模块：TS + Go 双实现的提示词组装/序列化/用量核算纯函数 + 请求体优化器 CLI）、根目录散件（test.js 验证器、两份 hash 命名的真实请求日志、三份优化产物、样本/ 目录）。分析对象是 Claude Code/Cline 经网关发给 DeepSeek V4.1-Flash 的**真实生产请求**（单轮 37–42 万 prompt token）。

---

## 一、项目概况：它回答了什么问题

SYAOCODE 的上下文管理设计（DD-6）中有「对稳定前缀（系统提示词、工具定义、项目指令）启用 provider 的缓存标记」，provider 层有 `capabilities.promptCache: none | explicit | automatic` 协商（FR-014/016），并定了成本目标（NFR-032）。但 SYAOCode.md 对**缓存命中率如何被破坏、如何度量、如何在压缩/恢复时保住缓存**着墨很少——这个项目用真实数据把这块盲区补齐了：

| 指标 | 原始（真实日志） | 优化后（稳定前缀重构） |
| --- | --- | --- |
| prompt_tokens | 417,869 / 372,721（两份日志） | ~45K（易变内容下沉后） |
| 缓存命中率 | **6.42% / 2.79%** | 稳定前缀占比 **0.0% → 100.0%**；活端点重发命中 99.96%+ |
| cache_creation | 0 | —（显式断点 3 处） |
| 单轮成本 | ~$0.055–0.059 | 命中部分按缓存价计费 |

**方法论核心**：静态判据优先于活端点——「同请求逐字节重发命中 100% 不能证明优化有效」（原始请求同字节重发也 100%）；真判据是「稳定头内首个易变字节位置 / 可缓存前缀占比 / 残留污染项计数」这类确定性指标。

---

## 二、与 SYAOCODE 构件的映射总览

| SYAOCODE 构件 | 本项目对应物 | 参考强度 |
| --- | --- | --- |
| DD-6 提示词分段与缓存断点 | 稳定/易变物理分离 + 断点位置规则 + 确定性排序 | ★★★ |
| DD-6 压缩策略（缓存失效盲区） | head-range 压缩 + 摘要调用同路由复用缓存 | ★★★ |
| FR-016/BR-023 用量统计 | 三桶核算（uncached/cacheRead/cacheWrite）+ 命中率 | ★★★ |
| DD-3 Capabilities.promptCache | automatic（DeepSeek 隐式）与 explicit（Anthropic 网关）的双方言实证 | ★★★ |
| NFR-032 成本目标 | 命中率→成本的量化路径 | ★★ |
| 测试（11 章） | verify.ts 七项断言 + 双实现哈希等价 + CI 静态判据 | ★★ |
| CLI 诊断命令 | 日志→优化器 CLI 流水线（可转化为 `syao cache analyze`） | ★★ |

---

## 三、关键发现与对 SYAOCODE 的具体参考意义

### 3.1 杀伤前缀的三类易变内容（映射 DD-6 分段规则）

实测证据（两份真实日志）：

| 易变项 | 位置 | 实测杀伤 |
| --- | --- | --- |
| `x-anthropic-billing-header: cc_version=…` | system **第 0 行** | 两份日志 system 公共前缀只有 **47 字节**——版本号一变整段前缀报废 |
| `Today's date is …` | system 中部 | 一份日志里同时存在昨天的日期和「日期已变更」——**跨 0 点即整段前缀失效** |
| `<total_tokens>N tokens left</total_tokens>` | system 内散落 | 一份日志 **531 处**、另一份 318 处，每轮重盖章，把可缓存前缀截到头部 ~11.5% |

外加：**tools 顺序漂移**（同 agent 两轮工具数组顺序不一致）、**无任何显式缓存断点**（cache_control 计数 0）。

**参考意义**：SYAOCODE DD-6 的五段顺序（基础指令/工具定义/项目指令/技能索引/环境信息）方向正确，但需固化为**硬规则**：

1. cwd、日期、token 预算倒计时、任务 id、临时路径、长随机 id、沙箱/审批策略快照**一律不进缓存前缀段**——统一走「尾部 runtime-context snapshot」，快照用固定引导句（"supersedes earlier snapshots"）让模型只认最新。
2. **预算倒计时折叠**：全量收集取最新值折叠为尾部一行，而非每轮在头内重盖章。
3. 环境信息段（变化频繁）已排在缓存断点之后——正确；但要补充「断点之后的内容也不得包含会被逐轮改写的长文本」。
4. dsh 的 `CONTEXT_ORDERS` 白名单表（`deepseek-harness/packages/core/system-prompt/src/index.ts`：WORKING_DIRECTORY=100、SANDBOX_POLICY=110… 注释明言「进程特定路径与端点不进缓存系统提示」）可作为 SYAOCODE 分段 order 表的蓝本。

### 3.2 确定性序列化（映射 DD-6 / BR 族工程规则）

优化器与 dsh 的组装纪律：section 按 order 升序、**同序按名称 code-unit（非 locale）排序**；tools 按名排序（或配置化 toolOrder 含 rest 槽位，校验重名/未知名）；历史 **append-only**（中途系统更新以 in-history system 消息追加而非改头；工具变更用增量 tool_addition/tool_removal）；相邻同 role 合并；tool_use/tool_result 严格配对（配对破坏 = 前缀破坏）；序列化输出**逐字节确定**。

**参考意义**：这些应写进 SYAOCODE 的序列化层实现约束。特别是 tools 排序——SYAOCODE 的工具注册表（FR-021）若按注册顺序序列化，插件加载顺序变化就会破坏所有用户的缓存；**工具定义按名排序 + 固定 schema 序列化（稳定的 key 顺序）**是必须的。

### 3.3 压缩与会话恢复的缓存保全（映射 DD-6 压缩策略 / DD-7 恢复）

dsh 的 compaction 子系统给出成套答案（`docs/subsystems/compaction.md`、`compaction-basic/README.md`）：

1. **只压缩头部连续区间**（head-range compaction），保留尾部原样——「每个 checkpoint 使被替换区间起点的复用失效；**该区间之前的未变前缀仍可复用**」。
2. **摘要调用本身吃缓存**：摘要请求 = 逐字节重放「system 头 + tools + 被压缩区间原文」+ 尾部压缩指令 → 摘要调用几乎全额命中；反之「换 provider/model 路由、或压缩非头区间，就放弃这份复用」——**摘要调用必须与主调用同 provider/model 路由**（换路由 = 换缓存域）。
3. 摘要以 `surfaceOp: {op:'replace', startSeq, endSeq}` 落地：原始事件保留在日志（shadowed 而非删除），投影层派生模型可见消息——事件日志 append-only + 投影替换。
4. 恢复后首个请求只要重建出与断点前逐字节相同的前缀即继续命中；避免恢复/压缩后改 max_tokens、reasoning_effort 等请求包络；图片引用保持 file_id 稳定。

**参考意义**：这是 SYAOCODE DD-6 压缩策略（summarize 六步）与 DD-7 恢复的关键补强——① 压缩区间必须**从头部的回合边界开始**（DD-6 已写「切分点必须落在回合边界」，需再明确：从最早历史开始、保留最近 N 轮原文，即 head-range）；② 压缩摘要调用（fast 模型）**在缓存角度是反模式**——fast 模型与主模型若不同 provider，摘要请求在新缓存域冷启动。需要在「省钱（小模型）」与「保缓存（同路由）」间做权衡并在文档中记录：**建议同 provider 不同档位模型（同域）或接受摘要冷启动成本**；③ 恢复会话后请求包络参数不变的纪律。

### 3.4 三桶用量核算与命中率监控（映射 FR-016/112 / BR-023 / NFR-032）

- **多形态 usage 读取**：优先 `usage.prompt_tokens_details.cached_tokens`（OpenAI/DeepSeek 形态），兼容 `cache_read_input_tokens` / `cache_creation_input_tokens`（Anthropic 形态）；流式必须 `stream_options.include_usage`。
- **三桶归一**：`{uncachedInput, cacheRead, cacheWrite}`，total 四桶各计一次不重复；`cacheHitRatio = cacheRead / (cacheRead + uncachedInput)`；按 turn 聚合。
- **污染诊断法**：对比同会话相邻两轮请求体的**首个分歧字节位置**（`leading_stable_bytes` 指标）定位污染源。

**参考意义**：① SYAOCODE 的 Usage 事件（DD-2 usage、DD-12 UsageTracker）应含三桶字段与命中率派生指标——这正是 NFR-032 成本对比的数据基础；② provider 适配器（FR-012/015）统一归一多形态 usage 字段（SY-PRV-008 响应解析的一部分）；③ **开发模式可加「前缀分歧诊断」**：相邻请求体 diff 首个分歧点，是压缩/分段回归 bug 的快速定位器。

### 3.5 explicit 与 automatic 双方言的实证（映射 DD-3 Capabilities.promptCache）

- DeepSeek 官方路由：**隐式 KV cache 前缀复用**（dsh wire 类型无 cache_control 字段；「未变的组装前缀有资格复用」）——**automatic 方言需要的不是断点，而是字节稳定性**。
- Anthropic 兼容网关：显式 `cache_control: {type:'ephemeral'}` 断点（优化器打在：末个 tool → 稳定 system 头 → 最新稳定历史轮，rolling）——**explicit 方言**。
- 温度等采样参数**不影响**命中（缓存只看输入前缀）；model/provider 路由变更会换缓存域；工具 schema 变更从首个变化 token 起失效。

**参考意义**：与 goose 的 CacheSemantics 四值模型互相印证。SYAOCODE 的 `promptCache: none|explicit|automatic` 三值可细化为：`explicit{maxBreakpoints}`（断点位置规则如上三处）| `implicit-tolerant/strict`（字节稳定性纪律）| `none`。适配器按方言决定「打标记」还是「保证确定性序列化」。

### 3.6 可转化的工具与测试模式（映射 11 章测试 / CLI 子命令）

- **`syao cache analyze <session-log>`**（新 CLI 诊断命令建议）：对自有会话日志跑易变行扫描 + 前缀占比 + 命中率趋势 + 相邻请求首个分歧字节定位。
- **verify.ts 七项断言**可直接改写为 SYAOCODE 上下文管理模块单测：确定性排序、易变内容不泄漏进头、in-history 更新不改头、无能力时合并、增量工具更新、配对校验、三桶合计。
- **双实现哈希等价**：TS/Go 对同一输入比对稳定头 sha256——「缓存性能等价」可以只比头哈希，是极省的回归判据（SYAOCODE 单实现场景可用于「序列化器改动前后前缀不变」检查）。
- **CI 静态判据**：`稳定头内首个易变字节位置 / 可缓存前缀占比 / 残留污染项计数` 三指标进 CI，防提示词模板回归。

---

## 四、可移植功能清单

| 功能 | 源位置 | 移植到 SYAOCODE | 成本 |
| --- | --- | --- | --- |
| 易变行正则清单（VOLATILE_LINE 族） | `prompt-cache-core/ts/optimize-request.ts` | DD-6 分段实现的黑名单（配置化） | 低 |
| 预算倒计时折叠 + runtime-context snapshot 模式 | 同上 + dsh `system-prompt/src/index.ts` | 环境信息段实现方式 | 低 |
| 三桶 usage 归一 + cacheHitRatio + 按轮聚合 | `prompt-cache-core/ts/usage.ts`、dsh `token-meter/turn-usage.ts` | DD-12 UsageTracker | 低 |
| 多形态 usage 兼容读取 | `test.js:74-80` | provider 适配器（FR-016） | 低 |
| SECTION/CONTEXT order 白名单表 | dsh `packages/core/system-prompt/src/index.ts` | DD-6 分段 order 表蓝本 | 低 |
| head-range 压缩 + 摘要同路由复用 | dsh `docs/subsystems/compaction.md` | DD-6 压缩策略修订 | 低 |
| 相邻请求首个分歧字节诊断 | 本项目核心诊断手法 | 开发者诊断工具 / CI 判据 | 中 |
| 七项序列化断言测试 | `prompt-cache-core/ts/verify.ts` | 上下文模块单测 | 低 |
| `syao cache analyze` 子命令 | 优化器 CLI 流水线 | CLI 诊断命令（P1） | 中 |

## 五、可落实的思路（关联 SYAOCODE 文档条款）

1. **DD-6 分段规则硬化**（转化为 BR）：新增业务规则「缓存断点之前的分段不得包含逐轮变化内容（日期、cwd、预算余量、任务 id、临时路径、版本号类 header）；此类内容统一进入断点之后的 runtime-context 快照段，快照带『取代先前快照』引导句；预算倒计时以最新单值呈现」。
2. **序列化确定性**（转化为 BR/NFR）：工具定义与提示词分段序列化必须逐字节确定（名称 code-unit 排序、JSON key 顺序固定、历史 append-only、tool_use/tool_result 严格配对）；配套 CI 静态判据（稳定头首个易变字节位置 = 无）。
3. **DD-6 压缩策略修订**：明确 head-range 语义（从最早回合边界压缩、保留最近 N 轮原文）；压缩摘要调用的路由决策显式化——同 provider 同域优先，并在成本报表中把摘要调用单独列示（is_compaction 标记，吸收 goose ledger 思想）。
4. **DD-7 恢复纪律**：会话恢复后重建的前缀须与断点前逐字节一致；恢复后不修改请求包络参数（max_tokens、reasoning_effort）。
5. **DD-3 Capabilities 细化**：`promptCache` 按方言建模（explicit{maxBreakpoints}/implicit-strict/implicit-tolerant/none）；适配器按方言选择「打断点」或「保证确定性」。
6. **DD-12/FR-016**：Usage 事件与报表含三桶 + cacheHitRatio；`/cost`（FR-137）展示缓存节省；provider 适配器归一多形态 usage 字段。
7. **测试计划增补**：上下文模块单测并入七项序列化断言；性能基准增加「相邻轮前缀分歧字节 = 0」判据；PoC-5（hyaki 保真）之外的 PoC 增补「缓存命中率基线」项（M2 建立基线时一并记录）。
8. **CLI（P1）**：`syao cache analyze <session>` 诊断命令（易变行扫描/前缀占比/命中率趋势/分歧定位），服务 NFR-032 的成本观测。

## 六、不适合照搬与风险

- **无许可证文件**：项目本身未声明许可证——**只参考方法学与数据结论，不复制任何代码**（正符合 SYAOCODE R-15 许可合规风险条的既定原则）；其内嵌的 dsh 快照为 MIT，同样只借设计。
- **优化器输出的 Anthropic 形态请求**是为兼容网关构造的实验产物，非生产形态；SYAOCODE 不需要「日志改写器」，需要的是**在源头（组装层）就不产生污染**。
- **样本局限**：两份日志来自特定网关与模型（DeepSeek V4.1-Flash via 网关）；缓存 TTL/分片、最小前缀长度等机制细节项目自认盲区（tool.md §5），落地前须按 SYAOCODE 的 WP-0 流程用目标 provider 复测。
- **reasoning_content 未序列化**造成的 token 差异（373K→45K 的一部分）是两端共同取舍，不是缓存收益本身——引用数字时注意口径。
- **TS 实现的双重编码 bug**（分块数组 user content 的 JSON.stringify）提示：移植时以 Go 版语义为准，或重写。

## 七、关键文件索引

| 主题 | 路径（相对 `reference/DSH缓存分析+优化器/`） |
| --- | --- |
| 方案文档 | `prompt-cache-core/README.md`、`prompt-cache-core/tool.md` |
| 活端点验证器 | `test.js`（命中率口径/实验设计/判定阈值） |
| 原始日志 | `df4ca21e717c32830bc20e4e8767e83c.json`、`f8acfb2d8440cd717e50e0e99aebcb53.json` |
| 优化产物/样本 | `request_body*.optimized*.json`、`样本/{raw,u1,u2,gou1}.json` |
| TS 核心 | `prompt-cache-core/ts/{types,assembly,serialize,usage,verify,optimize-request}.ts` |
| Go 核心 | `prompt-cache-core/go/{types,assembly,serialize,usage,promptcache_test}.go` |
| dsh 组装出处 | `deepseek-harness/packages/core/system-prompt/src/index.ts`（SECTION_ORDERS/CONTEXT_ORDERS/renderPrompt） |
| dsh 序列化/用量 | `deepseek-harness/packages/llm/llm-deepseek/src/{serialize,translate,models}.ts`、`packages/llm/token-meter/src/turn-usage.ts` |
| dsh 压缩×缓存 | `deepseek-harness/docs/subsystems/compaction.md`、`packages/compaction/compaction-basic/README.md` |
