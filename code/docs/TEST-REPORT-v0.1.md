# SYAOCode v0.1 测试报告

- **版本**：v0.1.0（内部版，对应 WBS M0+M1，未发布；含交互式 CLI、权限三档与 TUI 渲染稳定性增量）
- **日期**：2026-10-16（权限三档增量更新；TUI 渲染稳定性与 /permission 增量）
- **环境**：macOS (darwin 25.5.0, arm64) / Node v24.15.0 / pnpm 12.11.2 / TypeScript 5.7 / Vitest 3.2
- **结论**：✅ 全部通过 —— typecheck 0 错误、**211/211** 单元与合约测试（含 13 项管道式 REPL 冒烟）、10/10 评测任务。测试过程累计发现并修复 25 项缺陷（§4）。

> 增量（权限三档）：新增 `strict` 权限模式（core 引擎一级模式：一切操作含读取都需确认）；CLI 新增 `--YAO`（读取免确认，写/删/执行需确认）与 `--SI`（文件增删改查读全免确认）档位参数，二者互斥；无参数启动默认严格档；优先级 `--permission-mode > 档位 > 用户配置 > strict`；REPL 横幅与 `/permissions` 显示当前档位。修复 macOS realpath（/var vs /private/var）导致临时目录工作区被判越界的缺陷。

> 增量（渲染稳定性 + `/permission`）：新增 `/permission` 指令（三档直接切换，`/permissions` 与之参数互通）；指令联想改为**全量列表 + 行内中文简介 + 视窗滚动**；TUI chrome 改为**逐行差分渲染 + synchronized update**，实测消除移动选择与空闲时的终端闪烁（§8）。修复光标定位 off-by-one（落在框底边框而非输入行，经 pyte 交叉验证，§4 #25）。

## 1. 测试范围与结果总览

| 验证项 | 结果 | 数量 |
| --- | --- | --- |
| TypeScript 严格检查（`strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`） | ✅ 0 错误 | 5 包 |
| 单元/合约测试（vitest） | ✅ 全部通过 | **211 通过 / 0 失败**（core 59、providers 19、tools 18、testing 9、cli 106） |
| 评测集（G1 种子，确定性 MockProvider 驱动真实内核） | ✅ 全部通过 | **10/10** |
| 错误码注册表治理检查 | ✅ 通过 | 79 码、zh-CN 齐全、可重试 14、fatal 3、DEC-007 空缺保持 |
| CLI 冒烟（真实进程） | ✅ 通过 | 交互式 + 非交互共 13 项；TUI pty 冒烟 2 项 |

## 2. 各包测试明细

### 2.1 `@syaocode/core`（58 项）

- **错误体系（09 章验收）**：注册表 78 码唯一且格式合法；SY-DEC-007 空缺保持（序号不复用）；每个 active 码有 zh-CN 消息且无孤立项；fatal 集恰为 {CTX-002, ACP-001, INT-001} 且均不可重试；可重试集合与登记表一致；`SyaoError` 序列化为固定 7 字段；`is()` 用 Symbol 品牌判定（不依赖 `instanceof`/`name`，多副本安全）；`wrap()` 对非 SyaoError 装箱为 SY-INT-001；未注册码构造时即刻抛错。
- **权限引擎（FR-040~044）**：deny>ask>allow 优先级（BR-001）；default 模式读允许、写无审批器时按 deny（SY-PERM-005）；审批器拒绝 → SY-PERM-002；plan 模式仅放行只读（含分类为只读的 bash 命令）；acceptEdits 放行工作区内写、拒绝工作区外（SY-PERM-003）；bypass 全放行；危险命令库（rm -rf 根/家目录、mkfs、dd 写盘、git push --force、shutdown 等）默认拒绝（SY-PERM-004）且仅用户级 allow 规则可放行（BR-006）；命令分类 16 组用例（只读白名单、管道/链式拆段、重定向判写）；glob 规则匹配（`mcp__github__*`）。
- **Agent 循环（FR-001~006）**：工具往返直至完成；连续只读调用并行批次且结果按调用顺序回填（BR-008）；每个 tool_use 恰好一个 tool_result（BR-009）；中断时未执行调用以 SY-LOOP-003 回填且历史合法；maxTurns 触发 SY-LOOP-001；同参失败 3 次注入提示、5 次终止（BR-011）；未注册工具返回 SY-TOOL-001 结构化错误并列出可用工具；Zod 校验失败返回 SY-TOOL-002 带字段提示；工具超时不挂死循环并继续；20 个并发 agent 实例状态隔离（NFR-004）。
- **管道（BR-012/BR-025）**：截断保头 40% 尾 60% 并附说明；小结果不动；按行数截断。
- **会话（FR-060~062, BR-016）**：内存与 JSONL 文件存储的 append/load/list/fork/delete；损坏行容忍（≤20% 跳过）与超阈值报 SY-SES-002；版本过高报 SY-SES-003。
- **配置（FR-120, BR-002/BR-024）**：用户→项目→环境→代码分层合并且代码层优先；项目级 bypass 被忽略并告警；项目级不能放宽用户 deny（强制回 deny）；非法配置以 SY-CFG-001 报出字段路径。
- **脱敏（FR-045, BR-023）**：8 类常见密钥形态 + 注册值精确替换；只记录类型不记录值；嵌套结构深度脱敏。
- **上下文（FR-050/052）**：提示词分段组装稳定；CJK token 估算重于拉丁。

### 2.2 `@syaocode/providers`（18 项）

- **OpenAI-compatible（FR-012）**：本地 SSE mock 服务器驱动真实 fetch 流式路径；文本增量重组 + usage；流式 tool_calls 聚合为 tool_use 块（参数跨分片拼接）；tool_result 历史转为 role=tool 消息（线上合法性）；401→SY-PRV-001（不重试）、429→SY-PRV-002（可重试）。
- **Anthropic 原生（FR-011）**：message_start/content_block_* 事件流解析；thinking 与 text 块；input_json_delta 碎片聚合为结构化 tool_use；tool_result 原生回传含 is_error；5xx→SY-PRV-009（可重试）；[DONE] 哨兵兼容。
- **G2 合约（同一套测试跑三个 Provider）**：`defineProviderContract` 分别对 MockProvider、OpenAI-compatible、Anthropic 各 5 项（文本流+usage、tool_use 往返、历史合法性、传输错误映射、withRetry 上限=5 次后放弃）——**三Provider 同合约全绿，G2 目标在 v0.1 内核层面达成**。

### 2.3 `@syaocode/tools`（18 项）

- read：行号输出、offset/limit、SY-FS-005；write：新建免读、未读覆写拒绝（SY-FS-001）、外部修改拒绝（SY-FS-002）；edit：唯一匹配替换、多匹配报数量与行号（SY-FS-003）、replace_all、无匹配带近似行提示（SY-FS-004）、未读先改拦截（BR-004/005 全覆盖）；glob/grep：命中、include 过滤、.gitignore 目录/模式排除、非法正则结构化报错；bash：白名单命令执行与 exit 上报、非零退出标记 isError；FileStateTracker 单元。

### 2.4 `@syaocode/testing`（9 项）

MockProvider 请求记录与脚本耗尽语义（SY-PRV-007）；MemoryRuntime 种子/读写/外部修改注入/确定性时钟与 id。

### 2.5 `syaocode` CLI（22 项）

参数解析（-p/exec/--output-format/--model/工具名单/限额）；非法参数与非法枚举含 SY-CLI-001 提示；退出码映射（BR-042）；doctor 无密钥可运行、不打印密钥值（FR-173）。

**交互命令集增量（16 项新增）**：

- **斜杠解析与帮助（纯逻辑）**：命令/参数解析（含空格规整）；/help 覆盖全部 v0.1 命令并标注 M2+/M3+/M4+ 计划项；单命令帮助与未知命令提示。
- **模型配置（FR-121 安全边界）**：Provider 目录完整性（4 个、密钥环境变量映射）；env 文件解析（注释/引号/空行）与序列化往返；`writeEnvFile` 落盘权限恰为 0600；用户配置读写往返；默认模型解析优先级 flag > env > 已保存配置；`keyStatusOf` 能从密钥文件探测就绪状态；`maskKey` 永不泄露完整值。
- **管道式 REPL 冒烟（真实子进程 + 隔离 HOME）**：横幅 + /help + /status + /exit；mock 对话流式渲染回复；**无人值守权限策略**——管道下 write 工具被自动拒绝且输出 SY-CLI-002 说明（BR-042）；/model show 与 /model list 渲染目录与密钥状态；/permissions 展示并切换模式；`!echo` 只读命令放行执行、`!rm -rf /` 危险命令以 SY-PERM-004 拒绝（BR-006）；/mcp /goal 占位提示明确；/doctor 与子命令一致。

## 3. 评测与冒烟

### 3.1 评测集（evals/，G1 种子）

10 项确定性任务经**真实内核**（agent 循环 + 六工具 + 权限引擎 + MemoryRuntime）执行，10/10 通过：

| 任务 | 轮次 | 验证 |
| --- | --- | --- |
| E01 读取并报告 | 1 | 文本包含目标行 |
| E02 新建文件 | 1 | 文件内容一致 |
| E03 唯一匹配编辑 | 2 | 文件内容一致 |
| E04 未读先改防护与恢复 | 3 | 先失败（SY-FS-001）→ 重读 → 成功 |
| E05 glob 查找 | 1 | 结果含目标文件 |
| E06 grep 定位 | 1 | 结果含定义位置 |
| E07 安全命令执行 | 1 | 输出含命令结果 |
| E08 危险命令拒绝 | 1 | rm -rf / 被拒并改述 |
| E09 读→改→验多步流 | 3 | 修复 bug + 检查命令 |
| E10 信息汇总报告 | 1 | 报告含版本号 |

### 3.2 CLI 冒烟（真实进程）

`--version` ✓；`doctor`（12 项检查，无密钥环境正常，不泄露值）✓；`-p` mock text 输出 exit=0 ✓；`--output-format stream-json` 每行含 schemaVersion/sessionId/ts ✓；`--output-format json` 输出版本化结果对象 ✓；非法参数 exit=2 ✓；**真实工作区端到端**（read 工具读真实文件 → mock 汇报 → exit=0）✓。

## 4. 测试驱动的修复与优化（28 项）

| # | 发现 | 修复 |
| --- | --- | --- |
| 1 | tool.start/result 事件只进内部 EventBus，`run()` 消费者看不到（违反 ADR-02 事件流唯一出口） | 事件按调用缓冲、批次结束后按调用顺序 yield，保证确定性顺序 |
| 2 | 忽略 abort 信号的工具会挂死整个循环（违反 NFR-007） | 管道加 hang guard：执行与超时/中断信号 race，永不悬挂 |
| 3 | 中断与超时都报 SY-TOOL-003，语义混用 | guard 区分：外部中断 → SY-LOOP-003 回填（BR-009），超时 → SY-TOOL-004 |
| 4 | **评测发现的真 bug**：权限引擎对相对路径不做工作区锚定，导致 acceptEdits 下所有写入被判"工作区外"（4 个评测任务失败） | `resolve()` 以 workspaceRoots[0] 锚定相对路径 |
| 5 | `SyaoError.is()` 依赖 `name` 字段，子类（SessionError 等）判定失败 | 改为 `Symbol.for` 品牌判定 |
| 6 | `echo hi > out.txt` 被分类为只读（重定向未优先判断） | 重定向检查移到只读白名单之前 |
| 7 | `checkSubject` 不做命令分类，plan 模式误拒 `ls` 类命令 | 分类逻辑内联到引擎入口（FR-043 语义） |
| 8 | `@syaocode/testing` 主入口引入 vitest，导致 evals 等纯 tsx 运行时崩溃 | 合约套件拆到 `@syaocode/testing/contract` 子路径 |
| 9 | **REPL 冒烟发现**：管道输入 EOF 触发 readline `close` 后，`rl.prompt()` 抛 "readline was closed"，后续命令全部丢失 | 全部 prompt/question 调用走 `safePrompt` 关闭守卫；审批器在输入关闭时按拒绝返回 |
| 10 | 流式渲染缺失：循环只发 message.complete，UI 无法增量显示 | 循环转发 provider block_delta 为 `text.delta` 事件（ADR-02），REPL 增量渲染 |
| 11 | **三档冒烟发现**：macOS 上 `--cwd` 指向 `/var/folders/...` 临时目录时，realpath 返回 `/private/var/...`，与未规范化的 workspaceRoot 不匹配 → 误判"工作区外"（SY-PERM-003） | 权限引擎对 workspaceRoots 做一次性 realpath 规范化后缓存再比较 |
| 12 | 档位断言与固定横幅文案冲突（管道模式提示恒含"无人值守"字样） | 断言改用 `SY-CLI-002` 作为实际拒绝标记（测试侧修正，同时印证横幅提示与真实拒绝可区分） |
| 13 | **TUI 翼展断言发现**：蝴蝶翅膀 `\|cos(4πf)\|` 在扇动窗口内完成 4 个开合周期（扇了四下，不是两下） | 改为 `\|cos(2πf)\|`，恰好两个开合周期=扇两下；身体起伏同步改两周期 |
| 14 | **hold 静止断言发现**：艺术字相位后 hold 阶段起点仍取蝴蝶位置，成型后会重新变形一次 | hold 起点取 art 目标（静止），仅保留同层色彩脉动 |
| 15 | 变形缓动按整个相位时长推进：蝴蝶阶段开始 1.4s 后粒子仍在半途，扇动测试测到的是变形进度而非翅膀开合 | 引入变形窗口（skyline 0.8s / butterfly 0.5s），窗口内完成位移、窗口外粒子锁定目标 |
| 16 | **状态栏测试发现**：provider 未上报缓存字段时命中率被当作 0% 显示 | 引入 `sawCacheField` 标记：从未上报 → 显示 —，上报过（含 0）→ 显示百分比 |
| 17 | **pty 冒烟发现**：pty 下 `output.columns=0`，底边框 `'─'.repeat(cols-2)` 抛 "Invalid count value: -2" 直接 fatal | drawChrome 列数下限保护 `max(24, columns ?? 80)` |
| 18 | **欢迎面板翼展断言发现**：蝴蝶触角横向位置做了 `/wing` 补偿，收翅时触角反向张开成 11px，翼展断言失败 | 触角位置固定不随翅膀缩放 |
| 19 | **翼展断言再发现**：收翅点取在半周期（\|cos(π)\|=1 仍全开），与启动动画同源的 \|cos\| 周期陷阱 | 收翅断言点改为 1/4 周期 |
| 20 | **等宽断言发现**：欢迎面板内容行分隔符实际占 7 列而公式按 8 列算，行宽 87≠88 | `leftW+rightW = panelW−7` 修正 |
| 21 | **pty 全序列冒烟发现的严重 bug**：`/setup` 各步永远报"必填为空"卡在第 1 步——`feed()` 同步处理 Enter 时已清空缓冲区，事件循环里再读 `editor.text()` 得到空串 | 向导 submit 改用事件携带的 `ev.text`（与主输入路径一致）；Tab 确认路径回退读编辑器 |
| 22 | 向导脚注行按硬编码 44 列补 padding，实际文本 38 列导致行宽短 6 列 | 统一走 pushRow 宽度计算 |
| 23 | 向导编辑模式无法"回车沿用现有值"（校验先于编辑语义判断） | 编辑模式下文本步空输入跳过必填校验、保留原值 |
| 24 | **pty 探针发现的闪烁根因**：每次 ↑↓ 移动联想整块 `ESC[J` 擦除 + 全量重画（实测 ~44KB/按键、4–5 次全量擦除）；150ms 状态定时器空闲时也在全量重画（~88KB/1.2s）；根因是「清除下方 → 逐行重写」的整块刷新模式在每次按键都执行 | chrome 改为**逐行差分渲染**：只原位重写变化行（`\r`+行+`ESC[K`），帧收缩时原位清空多余行并保持底部锚定；内容未变时**零写入**；整帧用 synchronized update（DEC 2026）包裹。实测 ~440B/按键、0 次全量擦除、空闲 0 字节 |
| 25 | **模拟器/pyte 双重验证发现的光标 off-by-one**：光标尾部定位用 `CUD(aboveBox+2)`，实际落在输入框**底边框**行而非输入行（内容行应为锚点+aboveBox+1）；且帧收缩路径未补偿帧偏移，关闭联想后光标会飞到屏幕顶部 | 光标定位修正为 `aboveBox+1+帧偏移`；新增 `frameInset` 跟踪帧相对锚点的行偏移，差分/收缩路径统一补偿 |
| 26 | **面板测试发现**：`truncateToWidth` 不识别 ANSI 转义，把转义字节算作可见列——带颜色的表格行被提前截断（`yes`→`ye`，甚至截断在转义序列中间产生乱码残留） | 改为转义序列零宽透传（sticky 正则），不再截断于序列内部 |
| 27 | **pty 冒烟发现**：pty 宽度 24 列 + `edit team` 长标题使 `repeat(负数)` 抛 RangeError 崩溃（两个向导同款风险） | 两个向导渲染均做标题截断与 `Math.max(0, fill)` 下限保护 |
| 28 | 命令重写时按范围替换误删 `switchModel`（typecheck 立即报 5 处未定义） | 恢复函数并全局复核引用 |

## 5. TUI 专项（v0.1 追加，36 项单测 + pty 冒烟）

### 5.1 启动粒子动画 `tui/boot.ts`（11 项）

- **相位时间轴**：skyline(2.0s)→butterfly(2.4s)→art(1.0s)→hold(1.0s) 首尾相接，总时长 6.4s，`phaseAt` 边界切换正确。
- **确定性**：同种子同尺寸 `pixelSnapshot` 逐像素相等（可复现测试）。
- **城市天际线**：聚合完成后建筑轮廓冷色（39/45/81）与窗灯暖色（220/226）同时出现，像素量 >150。
- **蝴蝶扇动两下**（数值断言）：扇动窗口 [2.5s, 3.9s] 内翼展呈 开→收→开→收→开 五点采样，收翅翼展 < 开翅 60%、相邻开收比 >2；收势阶段保持全开。*此断言曾抓出真实 bug：初版 `|cos(4πf)|` 实际扇动四下，修正为 `|cos(2πf)|`。*
- **三层色艺术字**：hold 帧蓝（33/39）、绿（46/48）、紫（135/141）三色同屏；蓝色平均行号 < 紫色（蓝上紫下）。
- **hold 静止**：不同时刻两帧像素几何完全一致（仅色彩脉动）——曾抓出 hold 起点误取蝴蝶位置的相位衔接 bug。
- **门控**：终端 <40 列或 <12 行不播放；`--no-boot` 解析。

### 5.2 行编辑器 `tui/editor.ts`（8 项）

插入/提交/Backspace/Delete/左右/Home/End；CJK 按码点删除（不切半个字）且 `cursorCol` 按 2 列计；↑↓ 历史浏览保留草稿、重复提交不入栈；Ctrl+U/K 行编辑；Ctrl+C 中断、Ctrl+D 空行 EOF / 非空充当 Delete；一次 feed 多键（粘贴）。

### 5.3 状态栏 `tui/status.ts`（8 项）

- 轮次（turn.start）/步数（tool.start）计数；usage 累计与缓存命中率 = cacheRead/(cacheRead+input)。
- **"未上报缓存"与"缓存命中 0"区分**：provider 从未返回缓存字段时命中率显示 —（曾把未上报当 0%，已修）。
- **速度语义**：流式期间按实时字符速率估算 tok/s；message.complete 后固定为末次速度（用户需求"工作结束了就是最后一次输出的速度"）。
- formatTokens 分级缩写；状态行含全部六字段；窄终端自动从右丢弃字段。

### 5.4 宽度与字形 `tui/width.ts` + `tui/font5x7.ts`（9 项）

CJK/全角/emoji 列宽；ANSI 转义零列；truncateToWidth 不切半个宽字符；padToWidth 按显示宽度补齐。5x7 点阵：SYAO CODE 坐标在网格界内、gridWidth=字数×6−1、未知字符按空格、两次渲染逐点一致。

### 5.5 pty 冒烟（真实终端仿真，2 项）

macOS `script` 分配 pty 驱动真实 TUI：逐字输入实时回显且光标 ESC 序列按 CJK 宽度前进（4C→8C→12C）；提交回显、mock 流式回复渲染于输入框上方、回合结束 chrome 重绘、/exit 退出；mock 未配脚本时 SY-PRV 错误正常打印于 chrome 上方。*曾抓出 pty 下 `output.columns=0` 导致 `'─'.repeat(-2)` 崩溃，已加列数下限保护。*

### 5.6 实现要点（无第三方依赖）

半块渲染（▀ 上/▄ 下，垂直分辨率 ×2）；粒子系统 tick(tMs) 纯时间驱动（确定性可测）；ESC7/ESC8 + 清除下方实现底部锚定 chrome、流式输出零整屏刷新；raw 模式输入统一走 LineEditor 状态机；权限审批/配置向导复用同一输入框（问题显示于框标题）。

## 6. 欢迎面板与指令联想（v0.1 追加，18 项单测 + pty 冒烟）

### 6.1 欢迎面板 `tui/welcome.ts`（6 项）

- 迷你像素字体（"SYAOCode" 专用变宽 5 行）点阵边界与紧凑宽度 32 列。
- 黑白阴影艺术字：主字亮白 250 + 投影深灰 238，**仅两色无彩色**；纵向 ×2 适配半块正方形像素。
- 多彩蝴蝶：彩虹六色（196/208/226/46/44/21）按曲线角度分区，着色 ≥3 色；1/4 周期处翼展 < 全开 60%（持续扇翅，2.4s 周期）；`t` 与 `t+周期` 逐像素一致（周期性）。
- renderPanel：行数=panelH、首尾行圆角边框、去 ANSI 后每行等宽、含 "Welcome to SYAOCode" 与模型/提示、右侧文本无 CJK（全英文）、两时刻帧不同（动画驱动）。
- 终端 <64 列或 <20 行返回空（调用方回退旧横幅）。

### 6.2 指令联想 `tui/palette.ts` + 编辑器 nav（12 项）

- 提示表 18 条全部 `/` 开头、名字唯一、英文 desc 无 CJK、**中文 brief 非空**（行内简短介绍）。
- 前缀过滤：非 `/` 开头 / 空行 / 已带参数（含空格）不触发；**`/` 返回全部 18 条（不截断）**；`/m` → /model+/manage+/mcp；`/p` → /permission+/permissions；`/c` → /cost+/compact+/clear；`/s` → /status+/setup；大小写不敏感；exactIndex 完整命令名命中。
- **视窗滚动 `paletteWindow`（4 项）**：列表不超视窗时全量显示；顶部/中部/底部窗口滑动且选中项始终可见；任意选中位置（0..N−1）都落在视窗内直至最后一条；偶数/奇数视窗尺寸均不越界。
- 编辑器：navCapture 关闭时 ↑↓ 浏览历史、开启时产生 nav 事件不改内容；独立 Esc 与 Tab 事件（Tab 不再自动插空格，由 TUI 按联想状态决定）；setLine 整行替换并复位历史浏览。

### 6.3 pty 冒烟（sized pty，`stty cols 100 rows 40`）

- 欢迎面板真终端渲染：21 帧动画（150ms 刷新）、圆角标题边框、英文欢迎与提示齐全。
- 联想全链路：`/` → 输入 `m` 过滤出 /model+/mcp → `↓` 选择 /mcp → `Enter` 补全 `/mcp ` → 输入 `list` → `Enter` 执行（占位提示输出）→ `Esc` 关闭 → `/exit` 退出。

## 7. /setup 向导与模型档案管理（v0.1 追加，17 项单测 + pty 全序列冒烟）

### 7.1 向导状态机 `tui/setup-wizard.ts`（11 项）

- 六步顺序与需求一致（名称→地址→Key→协议→认证→档案名）；kind 为 text/text/secret/select/select/text。
- 四协议认证字段集合：anthropic=x-api-key；openai-chat=bearer/x-api-key/query-key；openai-responses=bearer/x-api-key；gemini=query-key/x-goog-api-key。
- 完整流转六步作答 done=true、答案齐备；空模型名/非 http URL/非法或重复档案名逐项校验并停留原步；协议切换使认证字段失效时自动回退默认；编辑模式空输入沿用现值（含同名覆盖允许）。
- 渲染：等宽行、步骤标签齐全、◉/●/○ 三态与 ❯ 选项高亮、错误行渲染、全英文。

### 7.2 档案数据层（4 项）

saveProfile 档案入 config.json、**密钥只入 env 文件（0600）且 config 中不含密钥本体**（BR-023 断言）；空密钥不覆盖已存；deleteProfile 删档并对悬空默认模型回退 mock；档案名校验规则。

### 7.3 协议适配（providers +1 项）

openai-compatible 新增 authStyle：x-api-key 头与 ?key= 查询参数按配置附着（本地 SSE mock 服务器断言实际请求头/URL）；Anthropic 固定原生认证。@profile 解析：openai-chat 档案构建适配器、未实现协议（openai-responses/gemini）抛 SY-PRV-010（注册表新增第 79 码）、未知档案报 not found。

### 7.4 pty 全序列冒烟（真实终端）

/setup 六步依次输入（含协议选择 ↓+Enter、认证 Enter、掩码显示）→ 保存摘要（协议/认证/密钥字段状态）→ `设为当前模型? [Y/n]` 选 n → /manage 列出档案 → 详情（协议/认证/密钥状态）→ 删除确认 → 回到"暂无档案" —— 全程通过；磁盘核对：config.json `models` 字段创建与清空、env 文件创建，密钥不进 config。

### 7.5 蝴蝶冻结

欢迎面板新增 frozen 参数：任意键后蝴蝶取固定姿态（t=0 全开），不同时刻渲染逐字节一致（单测断言）；pty 冒烟中确认冻结后无动画帧差异。

## 8. 渲染稳定性与 `/permission` 指令（v0.1 追加，12 项单测 + 双探针验证）

### 8.1 `/permission`（三档快捷切换，7 项单测 + 1 项 REPL 冒烟 + 1 项 TUI 探针）

- 档位解析 `parsePermissionArg`：三档名正映射（strict→strict / YAO→default / SI→bypass）；大小写不敏感（`YAO`/`yao`、`SI`/`si`）；`default`/`bypass` 模式别名；`acceptEdits`/`plan` 高级模式；无法识别返回 null（`mode`/`allow`/`deny` 保留给子命令）。
- 展示文本：`permissionModeShort` 覆盖全部模式；`permissionTierPanel` 列出三档并以 `●` 标记当前档位（含 plan/acceptEdits 当前态）。
- 集成（REPL 管道冒烟）：`/permission` 展示速查表；`/permission YAO|SI|strict` 三档直接切换且消息含档位说明；非法参数给出用法。
- TUI 路径（PTY 探针）：输入 `/perm` → Tab 补全 `/permission ` → 输入 `YAO` 回车 → 输出区出现切换消息、输入框标题档位更新为「部分权限：读免确认」。
- `/permissions` 与 `/permission` 参数互通（`mode/allow/deny` 子命令与档位参数在同一处理器内解析）。

### 8.2 chrome 帧差分渲染（闪烁消除，PTY 字节级 + 屏幕级双探针）

- **根因**（探针实测）：每次 ↑↓ 移动都整块 `ESC[J` 擦除 + 全量重画（~44KB/按键、4–5 次擦除）；150ms 状态定时器空闲时同样全量重画（~88KB/1.2s）。
- **修复**：`buildChromeFrame` 组帧 + `paintChromeFrame` 三路径——同高/收缩帧逐行差分原位重写（收缩帧保持底部锚定、原位清空多余行）；增高帧/失效帧全量；内容未变**零写入**；整帧 synchronized update（DEC 2026）包裹，支持它的终端原子提交。
- **字节级探针**（24 行 PTY，逐按键统计）：移动 ~440B/按键、窗口滚动步 ~2KB、`ESC[J` 恒为 0；Esc 关闭 193B/0 次擦除；空闲 1.2s **0 字节**；联想首屏 14 条 + 标题 `1-14/18`，↓×10 滚动到 `5-18/18`，底部可见 `/agents /goal /mcp /rewind`。
- **屏幕级探针**（自研最小 VT100 模拟器 + pyte 交叉验证）：启动面板/输入框/状态栏自顶排布；联想层紧贴输入框上方、反显选中行 = /help、行内中文简介随命令显示；Esc 后无残留且输入框保持原区域底部；输入 `abc` 后光标落于输入行文本末尾（修正 off-by-one）；`/permission` 全链路可见。
- 附带修复：打开联想时自动收起欢迎面板（避免弹层与 22 行面板叠加超出屏幕）。

## 9. agent 群与信息面板（v0.1 追加，22 项单测 + pty 全流程冒烟）

### 9.1 agent 群数据层（5 项）

- save/list/get/delete；激活群把 common 角色写入当前模型并记录 `activeAgentGroup`；删除激活群自动清理该标记。
- **同一模型可担任多个角色**（三角色同模型保存并激活通过）；`availableModelRefs` = 内置 Provider 全部模型 + `@档案`。

### 9.2 /set-agents 群向导（6 项）

- 步骤结构 target→name→hyaki→sota→common；有群时先选目标（已有群进入编辑并预填三角色、进入角色步自动高亮预填模型）；无群时直接开始命名。
- 新建完整流程达 done 且答案齐备（含同模型多角色）；空名/非法名/重名校验停留原步；↑↓ 循环选择与选项窗口滚动；渲染等宽、三态标记（◉●○）与角色标签齐全。

### 9.3 信息面板（11 项）

- `panel()`：圆角边框、等宽、标题居中、超宽截断；`table()`：按显示宽度对齐、分隔线；`bar()/badge()/kv()/section()` 基础件（含 clamp 与大小写）。
- views：`/status`（会话+上下文进度条+激活群）、`/cost`（工作区累计+按模型+本次会话，见 §16）、`/tools`（风险表）、`/permissions`（档位徽标+规则表）、`/doctor`（✔/!/✘ 诊断表与失败计数）、`/model`（当前+内置+档案+agent 群三段）、`/manage`（档案表）、`/help`（命令表+输入语法）。

### 9.4 pty 全流程冒烟（80 列 pty）

`/set-agents` 新建群 team（hyaki=mock / sota=deepseek-chat / common=mock，↓ 选择生效）→ 保存摘要三角色齐全 → 激活（"已激活 agent 群"）→ `/model` 面板显示 agent groups 段与 `@team` → `/setting` 进入编辑当前群（标题 `set agents · edit team`，四步回车沿用）→ 再激活 → `/cost` 面板（cache rd 行）→ `/permissions` 问答引导（档位/allow/deny 三问 + 最终面板）→ `/agents` M3 面板（work mode / ships in M3）→ `/exit`。磁盘核对：`agentGroups.team` 三角色、`activeAgentGroup=team`。

### 9.5 交互式命令问答化

- `/permissions`（及 `/permission`）无参数：面板先行，随后逐项引导 —— 切换档位（可空）→ 添加 allow 规则（可空）→ 添加 deny 规则（可空）→ 输出最终状态面板；带参数快路径保持。
- `/set-agents`、`/setting`、`/setup`、`/manage <name>` 全部为问答/向导式；`/model` 面板式展示 + `/model use` 切换（provider:model / @档案 / @群）。

## 10. TUI 稳定性审计（v0.1 追加，pty+pyte 全指令压测）

方法：真实 pty（100×40）+ pyte 终端仿真驱动（`scripts/tui-drive.py`），逐条提交全部斜杠指令、权限问答、向导、多轮对话与连发压测，每步保存屏幕文本与 PNG 截图（工作区 `test/`，含前后对照与审计报告）。

### 10.1 复现并修复的 5 类异常

| # | 异常 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 多轮提交后永久「处理中」、队列卡死、/exit 无法执行 | mock 剧本耗尽触发 `SY-PRV-007` 可重试 → 5 次退避期间 UI 无反馈；**忙碌队列单槽位互相覆盖**丢消息 | 队列改数组（保序/上限 16/标题显示深度）+ 忙碌显示耗时秒数并定时重绘 |
| 2 | 双顶框、残影、擦错区域 | chrome 锚点依赖 `ESC7/ESC8`（DECSC），内容滚动后保存位置漂移 | 改纯相对移动（CUU 回帧首 → ED 清帧 → 重写；收缩 CUD 底部锚定；未变零输出；SYNC 2026 原子刷新），彻底移除 DECSC 依赖 |
| 3 | 快速连按 Enter 时后续答案走失（空 ❯ 行） | 下一问在 `await` 恢复后才注册，同块 submit 落到主输入 | 问答引导答案队列（`guided()` 包装 /permissions /manage /model config） |
| 4 | 欢迎面板 CJK 档位撑破边框 | 右列按字符数而非显示列宽 padding；面板本应英文 | 英文档位短标签 + displayWidth 计算 |
| 5 | 状态栏轮次恒为 1 | `turn.start.turn` 是单次 run 内循环序号 | 仅 `turn===1` 递增为累计用户轮次 |

### 10.2 验证结果

- 全指令场景 38 步：38/38 存活、`/exit` 退出码 0；全部截图程序化校验 0 双顶框 / 0 堆栈 / 边框一致。
- 20 条连发（10 空闲 + 10 忙碌）：20/20 消息获回复（唯一 ID 1–20），零丢失、零崩溃。
- 重试可见性专项：重试期显示 `处理中… Ns · 已排队 1 条`，耗尽后打印 `SY-PRV-007` 并按序消费队列。

### 10.3 终端异常清单复查（24 项，新增 12 项环境专项断言全部通过）

- **渲染**：SYNC 原子刷新/未变零输出/流式 16ms 合批（闪烁）；SIGWINCH + 相对锚点（resize）；CJK/emoji 显示宽度对齐 + `SYAO_TUI_ASCII=1` 降级（乱码）；OSC 11 主题探测（浅色终端艺术字 240/248）；ANSI 零宽截断（截断）；<40×8 最小界面（黑屏/零区域）；崩溃与信号统一恢复光标。
- **输入**：ESC 分片缓冲（方向键分块到达仍生效）；引导异常自动还原输入模式（焦点陷阱）；DEC 2004 括号粘贴 + 换行转空格 + 无 2004 启发式（粘贴）；`/exit\r` 同块不误判（回归测试，见修复 #29）。
- **卡死**：事件驱动无阻塞读；空闲零写入；重试期可见进度。同步大文件读取短暂阻塞为 v0.1 已知限制。
- **崩溃/污染**：`installTerminalGuards`（uncaughtException/unhandledRejection/exit/SIGINT/SIGTERM/SIGHUP）恢复 raw/光标/粘贴/同步输出（SIGTERM 实测 143 退出且终端恢复）；stdout EPIPE 不崩；SIGKILL/OOM 不可拦截（文档给出 reset/stty sane）。
- **环境**：非 TTY 路由 REPL；TERM=xterm 实测正常；不使用 alternate screen 规避 IDE 内嵌终端缺陷；Windows conhost 未验证。

新增 8 项终端健壮层单测（`tui-terminal.test.ts`）：极小窗口判定、转义分片识别、粘贴清洗（含跨块/回归）、OSC 11 亮度解析、ASCII 降级。

## 11. 真实模型端到端验证（v0.1 追加，DeepSeek-V4.1-Flash / OpenAI ChatCompletion 网关）

环境：`https://fun.zionlin.com/v1` + `deepseek-v4.1-flash`，Chat Completions 协议。密钥只写入测试 HOME 的 `~/.syaocode/env`（0600），不进仓库、会话与日志；驱动脚本为工作区 `test/tui-real-model.py`（仓库外，pty+pyte 截图）。

### 11.1 `/setup` 真实配置（6 步向导）

模型名 → 请求地址 → API Key（掩码 `••••••••`）→ 协议选择（↑↓ 选中 OpenAI ChatCompletion）→ 认证字段（Bearer）→ 档案名 `zionlin` → 保存并激活。落盘结果：`~/.syaocode/config.json`（非密）+ `~/.syaocode/env`（0600），`/model` 面板出现 `@zionlin`，原始输入输出中未出现密钥明文。截图：`test/tui-real/01-setup/`。

### 11.2 真实联调发现并修复的 7 个缺陷

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 首轮工具调用反复报 `Invalid arguments for 'write'. path: Required; content: Required`，模型只能靠报错猜测参数名 | zod 3.25 的 `_def.shape` 是函数，`Object.entries(function)` 得到空对象 → 发送给模型的 schema 全是 `{type:'object',properties:{}}` | 重写 `zodToJsonSchema`：兼容函数/对象 shape 与 v3/v4 类型名，补齐 record/union/effects/tuple/nativeEnum/intersection 等；新增 6 项单测（core 66） |
| 2 | 部分请求直接崩溃 `Cannot read properties of null (reading 'prompt_tokens')` | 网关会发送 `"usage": null` 分片，provider 只判 `!== undefined` | 增加 null 守卫 + 回归测试 |
| 3 | 模型思考期间界面只有计时，无任何内容 | 网关用 `delta.reasoning`（不是 `reasoning_content`），被 provider 丢弃 | provider 同时识别两种字段并发出 `block_start`；core 把 thinking block 的 delta 路由为 `thinking.delta`；TUI 用暗色 `⋯` 前缀实时显示，速度统计计入思考 token |
| 4 | 流式正文被拆成大量短行（每个 16ms 批次一行） | `printAbove` 对流式片段也强制补换行 | 新增 `printStream`：不强制换行、chrome 感知；半行期间暂停 chrome 重绘，工具行/正文切换时统一收尾 |
| 5 | 状态栏「上下文 71.1k/128k（56%）」虚报，与 `/status` 面板 13.0k 冲突 | 上下文占用用了累计计费 token（input+output+cache 之和） | 改为最近一次请求的 `input+output`；新增多轮不累加回归测试 |
| 6 | `/cost` 始终显示 `(provider provides no pricing)`，但网关实际返回了费用 | provider 未映射 `usage.cost` / `gateway_cost` | `Usage` 增加可选 `costUsd`，网关上报值优先于本地价目表；`/cost` 显示真实 `$0.0093` |
| 7 | 模型不知道工作目录，也不读取项目规则（P0：FR-051/FR-083 未落地） | CLI 未向 agent 传 `context` | 新增 `buildCliContext`：cwd/平台/日期 + 用户级 `~/.syaocode/AGENTS.md` + 仓库根 `AGENTS.md`（兼容 `CLAUDE.md`，`SYAO_INSTRUCTION_FILES` 可配置），接入 TUI / REPL / `-p`；新增 5 项单测 |

### 11.3 真实编码任务（C++ 单文件）

提示词要求在工作区 `test/` 下实现单文件命令行计算器（+ - * /、除零与非法输入、非零退出码），写完后用 g++ 编译并至少跑 3 个用例。结果：

- 25 次模型请求、32 张过程截图，`/exit` 退出码 0；**0 次工具参数错误**。
- 生成的 `test/calculator.cpp` 通过 `g++ -std=c++17 -O2 -Wall` 编译，实测：`3 + 4 = 7`（退出 0）、`10 / 0`（错误信息 + 非零退出）、`3 + abc`（带位置的错误信息）、`1e308 * 10`（溢出检测）。
- 流式反馈：思考行（暗色 `⋯`）与正文连续成段；工具行 `⚙ write/read/bash` + `✔/✖` 即时出现；最终中文 Markdown 表格在 TUI 中正常对齐。
- 用量：25 requests · 216.6k in / 12.5k out · 缓存命中 46% · 费用 $0.0093；状态栏上下文 14.5k 与 `/status` 面板 14.9k 一致（估算误差 <3%）。
- 权限审批（`--YAO`）：写操作弹出 `⚠ 权限请求`，`y` 本次允许后 write 执行、read 自动放行，最终回复正常。截图：`test/tui-real/02-code/`、`03-perm/`。

## 12. 双语 CLI / 联想弹层下移 / 开机按键跳过（v0.1 追加）

### 12.1 双语支持（默认英语 + 中文支持板块）

- 新增 `packages/cli/src/i18n/{en,zh,index}.ts`：英文目录为键集合的单一事实源，中文目录类型为 `Record<MsgKey, string>`（漏译即 typecheck 失败）；`t(key, vars)` 支持 `{name}` 插值，缺键回退英语。
- 语言保存在 `~/.syaocode/config.json` 的 `language` 字段，启动时最先应用（早于 `--help`/参数错误/doctor 输出）。
- `main.ts` 在解析参数前 `setLanguage(savedLanguage())`；TUI、REPL 与 `-p` 全部走同一语言。
- 中文化范围：欢迎面板、状态栏、输入框标题、权限请求、全部信息面板（status/cost/tools/permissions/doctor/model/manage/help）、`/setup` 与 `/set-agents` 向导、斜杠命令说明、REPL 提示、CLI 用法、doctor 详情、错误提示（中文模式下 `SY-*` 用 09 §9.10 中文表）。英文目录不含中文句子（`language.*` 中的语言原名除外），由单测约束。
- `/language` 指令：无参数进入问答（显示当前语言 + 两个选项），`/language en|zh` 直接指定；选择后**警告当前 CLI 会立即退出、下次启动生效**，确认后写入配置并退出（退出码 0），取消则不变；非法语言码拒绝。
- 新增 10 项单测（目录完整性 / 无 CJK 泄漏 / 插值 / 持久化 / 不覆盖其他配置 / 损坏值回退），并更新受语言影响的 REPL、状态栏、档位、联想测试。

### 12.2 指令联想层：输入框下方、无边框、每页 6 条

- `buildChromeFrame` 调整为：欢迎/向导 → 输入框(3) → **联想层** → 状态栏；光标仍定位在输入行。
- 弹层在光标下方展开，帧变高时 `paintChromeFrame` 先 `CUU growth` 再清屏重画，保持**底部锚定**（输入框位置不跳动，状态栏始终在最底部）。
- **无边框列表**：每条命令一行（命令名 + 简介），不再绘制 `╭─ commands ─╮` 外框与分隔线——各条说明长度不同，框线导致参差留白。
- **每页 6 条**：`paletteViewMax` 固定为 6（极小终端按 `rows-5` 收缩，最少 3）；选中项移出窗口时窗口滑动，旧条目移出、新条目进入。
- 末行显示窗口范围与键位提示（如 `6-11/21 · ↑↓ select · …`），无边框。

### 12.3 开机动画按键跳过

- 动画期间 `input.on('data')` 置 skip 标志，下一 tick 立即结束并清屏；按键被丢弃，不会进入输入框。
- pty 实测：按键后 1.8s 内进入工作区（动画总时长 6.4s），界面无残影、无崩溃。

### 12.4 pty 端到端验证（`test/tui-lang.py`，27/27 PASS）

| 组 | 断言 |
| --- | --- |
| A 英语默认 | 联想在输入框下方且**无边框**、**一页 6 条**、下移 7 次后旧条目移出且仍为 6 条、状态栏仍在最底部、全屏无任何中文字符、`/help`/`/model` 全英文、`/exit` 退出码 0 |
| B 中文模式 | 欢迎面板/状态栏/联想（6 条无边框）/`/help`/`/status`/权限引导均为中文，且无 `Available commands`/`session`/`progress` 等英文界面词；`/exit` 正常 |
| C `/language` | 面板显示当前语言与选项；警告包含“立即退出/下次启动”；确认后退出码 0 且 config 写入 `en`；重启后为英语；取消不改语言；非法语言码被拒绝 |
| D 开机跳过 | 动画期间有粒子输出；任意键后 1.8s 进入工作区；无残影/崩溃 |

## 13. 已知限制（v0.1 范围外，按 WBS 顺延）

- 真实模型已验证 OpenAI ChatCompletion 一条链路（含工具调用/流式/思考/权限/费用）；OpenAI Responses 与 Gemini 原生适配器仍为 M2 规划，`/setup` 可保存配置但调用会抛 `SY-PRV-010`。
- TUI 会话恢复 CLI、自动压缩、MCP、决策层、三角色编排未实现（M2~M4 范围）。
- 评测集为 10 项种子，G1 要求的 30 项任务集在 M1 后续扩充。
- 子目录级 AGENTS.md 惰性加载（DD-6）未实现；当前注入用户级 + 仓库根。
- 语言覆盖 CLI 内置文案；模型/工具返回的数据文本与用户输入保持原样（属数据而非界面）。
- 同步大文件读取期间 UI 短暂阻塞（v0.1 已知限制）。
- CI 工作流已就绪（.github/workflows/ci.yml，ubuntu/macos × Node 22），推送后首跑验证。

## 14. 默认通用配置与配置一致性（v0.1 追加）

针对"配好模型后仍落到 MockProvider / 上手打断多"的反馈，逐项定位并修复：

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `-p`/`exec` 忽略已保存模型，直接用 `mock:default` | `run.ts` 走 `parseModelSpec(args.model)`（默认 mock），与交互模式的 `resolveDefaultModel` 不是同一条链 | `resolveProvider` 统一改用 `resolveDefaultModel`：`--model` > `SYAO_MODEL` > `~/.syaocode/config.json` > mock，三种入口完全一致 |
| 2 | 问"你是什么模型"时模型答不上来 | 系统提示没有模型身份，模型无法自省底层版本 | `buildCliContext` 注入 `Harness:` 与 `Model:`（配置侧事实），TUI/REPL/`-p` 均生效 |
| 3 | 从 mock 切到真实模型后，新模型会去评论旧 mock 回复 | `switchModel` 无条件保留历史 | 跨 mock 边界切换时清空旧上下文并提示（`model.switchedFresh`），真实↔真实切换仍保留历史 |
| 4 | 默认严格档导致读操作也逐条打断 | 无参数时回退 `strict` | 默认改为 `default`（规范 FR-041 的 default：读免确认，写/删/执行仍审批）；`--permission-mode strict` 与 `/permission strict` 随时可切回 |
| 5 | `/setup` 需要逐项手填协议/认证/档案名 | 三步都没有默认值 | 档案名由模型名推导、协议按 URL 推断、认证字段取协议默认值；文本步回车即接受预填 |
| 6 | 状态栏显示 `@档案:模型` 语义不清 | 展示沿用了内部引用语法 | 新增 `modelSpecLabel`：`@档案 (模型)` / `provider:model` |

新增 11 项单测（默认解析顺序 / 保存配置生效 / 优先级 / 展示标签 / 系统提示身份 / 向导智能默认与回车沿用 / 默认档位），并更新受影响的 REPL 与档位测试。真实配置复验：`-p "Reply with exactly: PONG"` → `PONG`（此前会返回 MockProvider 文案）；TUI 询问"你是什么模型" → 回答 `@deepseek-v4.1-flash (deepseek-v4.1-flash)`。

## 15. 飞行场景与运行阶段行（v0.1 追加）

### 15.1 欢迎面板：蝴蝶向右飞

- 当前左侧为**较高天际线带 + 右上满月**：6~12 像素高的建筑带（深蓝底 + 青蓝窗、楼间留空隙），约 60ms/像素无缝向左循环滚动；满月为完整圆盘并带几处月海。
- 侧视蝴蝶（约 15×9 像素、上下三层蓝/紫/绿）**暂时关闭**：`drawSideButterfly` / `sceneButterflyOrigin` / `SCENE_BUTTERFLY_SCALE` 保留并导出，`flightScenePixels` 中的调用以注释保留，后续取消注释即可恢复。
- 用户敲任意键后整个场景冻结（保持原来的防频繁重绘行为）。

### 15.2 运行时阶段行（Claude Code 风格）

- 提交后显示 `❯ 问题`；运行期间 chrome 顶部增加**单行**阶段行：Claude Code 同款单字符旋转动画（`· ✢ ✳ ✶ ✻ ✽`，约 120ms 换帧，ASCII 终端降级为 `. o O * + x`）+ 阶段/动作文案。
- 放弃像素蝴蝶的原因：纯 ANSI 终端按字符格渲染，6×6 半块精灵仍要占 3 行；单宽字符旋转只占 1 列、1 行，是这类 TUI 的标准解法（无需图片素材）。
- 阶段启发式：`Explore`（读/搜索/只读命令）→ `Plan`（有工具活动后模型开始思考/输出）→ `Implement`（首次 write/edit）→ `Validate & Cleanup`（写后执行/读取/回复）。
- 正常：整行蓝（33）；网络重试或 `SY-PRV-*` 错误：整行红（196），显示「重试中（第 N 次，Xs）」。
- 为让长命令执行期间也能实时显示阶段，core 新增 `AgentConfig.onToolStart` 即时回调（事件流仍保持批次有序不变）；`withRetry` 新增 `RetryPolicy.onRetry` 回调（重试前触发，UI 即时转红）。
- 新增 11 项 flight/phase 单测 + 2 项重试回调单测；pty 专项 `test/tui-phase.py` 8/8 PASS（场景滚动、三阶段依次出现、阶段行位于输入框上方、三层色/半块像素）。

## 16. 工作区用量账本（`/cost` 跨会话累计，v0.1 追加）

反馈：`/cost` 只统计本次会话，无法回答"这个项目里我一共花了多少"。

| 项 | 设计 |
| --- | --- |
| 存储位置 | `~/.syaocode/usage/<projectHash>.json`（与 session 日志同样按路径哈希分桶）；桶内以**工作区绝对路径**为索引，哈希碰撞也不会串账 |
| 记录内容 | 每工作区累计 `requests / inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / costUsd`；`models` 下按 `provider:model` 分别累计，含 `firstUsedAt / updatedAt` |
| 写入时机 | TUI/REPL 的每个 `usage` 事件、`-p`/`exec` 每次运行结束（`requests` 取本次运行的 usage 事件数）；tmp + rename **原子替换**，损坏文件按空账本重建，写失败只在界面提示一次、不中断会话 |
| 索引口径 | 工作区 = 启动时的 `cwd`；同一目录下的所有会话（含 `/clear`、`/resume`、重启）汇总到同一条记录 |
| 安全 | 只写数字与模型名（无密钥、无对话内容），路径在 `~/.syaocode` 下，与代码仓库无关 |
| 并发 | 读-改-写合并；同一工作区多开时最后一次写入获胜（本地单用户场景，与 session 单写者假设一致） |

`/cost` 面板改为三段：**WORKSPACE**（路径 + 起始时间）、**WORKSPACE TOTAL (ALL SESSIONS)**（请求/输入/输出/缓存读/合计/费用 + 占比条）、**BY MODEL**（`provider:model` 表格，按总 token 降序，费用无上报显示 `—`）、**THIS SESSION**（本次会话同口径），末尾以暗色行标出账本文件路径。费用优先取 provider 上报的 `usage.cost`（网关会按请求返回），全部为 0 时标注"未提供定价"。

验证：

- 新增 11 项单测（`test/usage-store.test.ts`）：首次记账、跨会话累加、分模型拆分、工作区隔离、`-p` 多次请求计数、无定价、损坏重建、原子写无 tmp 残留、costDataOf/costPanel 输出、按 token 降序、空账本；另更新 1 项既有面板测试。
- pty 专项 `test/tui-cost.py` **15/15 PASS**：首次会话提问后 `/cost` 显示 requests=1 / 100 in / 50 out 与 `mock:default` 行；退出重启后累计仍为 1 而本次会话为 0；再提问后累计 2 / 200 in；账本文件按工作区路径索引且不含密钥。
- 真实模型复验（`@zionlin:deepseek-v4.1-flash`，网关 `usage.cost`）：两次 `-p` 后账本累计 `requests=2, input=4648, output=119, costUsd=0.00041925`，分模型键正确。

## 17. 复现命令

```bash
corepack pnpm install
corepack pnpm typecheck      # 0 errors
corepack pnpm test           # 292 passed
corepack pnpm lint:registry  # 79 codes OK
corepack pnpm test:evals     # 10/10

# 交互模式冒烟（无需密钥）
printf '/help\n/model list\n/status\n/exit\n' | corepack pnpm exec tsx packages/cli/src/main.ts
```
