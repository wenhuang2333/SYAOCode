# SYAOCode 指令集手册（v0.1）

`syao` 终端命令与交互模式完整参考。对应需求：FR-130/134/135/137/173/174。

---

## 1. 启动方式

| 命令 | 说明 |
| --- | --- |
| `syao` | TTY 终端：播放启动动画后进入 **TUI 常驻界面**（见第 3 节）；管道/非 TTY：进入 readline REPL |
| `syao "解释这个项目"` | 进入交互模式并把该文本作为首轮输入立即执行 |
| `syao --no-boot` | 跳过启动动画直接进入 TUI |
| `syao -p "prompt"` / `syao exec "prompt"` | 非交互：执行一次、打印结果、退出（无 TTY 场景/脚本/管道） |
| `syao doctor` | 环境与配置诊断（无需任何密钥） |
| `syao config list \| get <key> \| path` | 查看生效配置 / 单项 / 配置文件路径 |
| `syao --version` / `syao --help` | 版本 / 帮助 |

当前目录即工作区（可用 `--cwd` 覆盖）。首次使用建议先跑 `syao doctor`，再用 `/model config` 配置模型。

> **开发期运行形态（v0.1 未发布 npm）**：上述 `syao` 均为 `cd code && corepack pnpm start`（或 `corepack pnpm exec tsx packages/cli/src/main.ts`）。**必须在 `code/` 目录内运行**——在上层目录运行 pnpm 会命中其他 package.json（如家目录里的无关项目），报 `Command "tsx" not found`。

## 2. 全局参数（交互与非交互通用）

### 权限三档（核心用法）

| 启动方式 | 档位 | 行为 |
| --- | --- | --- |
| `syao`（无参数） | **默认档（部分权限）** | 读取类操作（read/glob/grep、`ls` 等只读命令）免确认；写、删、执行仍需确认（规范 FR-041 的 default；降低上手打断） |
| `syao --YAO` | **部分权限（显式写法）** | 与默认档相同 |
| `syao --permission-mode strict` | **严格档** | 一切操作（含读取）都需逐条确认；非交互管道下按拒绝处理 |
| `syao --SI` | **完全权限** | 文件增、删、改、查、读全部免确认，不询问用户（危险命令库仍拒绝，见下） |

- 三档互斥：`--SI --YAO` 同用报 `SY-CLI-001`
- 优先级：`--permission-mode` > 档位参数 > 用户配置（`~/.syaocode/config.json` 的 `permissionMode`）> **默认档（读免确认，写/删/执行审批）**
- **安全底线不随档位放宽**：`rm -rf /`、`mkfs`、`git push --force`、格式化磁盘等危险命令在**任何档位（含 --SI）都默认拒绝**（BR-006），需要显式 `--allowed-tools` 用户级规则才可放行；`deny` 永远不能被模型提升为 `allow`
- 档位只是免确认范围的变化；**会话内可直接用 `/permission <档位>` 切换**（如 `/permission YAO` 升档、`/permission strict` 降档，仅本次会话生效），或用 `/permissions mode <m>` 精确设置

### 其他参数

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `-m, --model` | `<provider>:<model>` | 指定模型，如 `mock:default`、`deepseek:deepseek-chat`、`anthropic:claude-sonnet-4`；省略时按 `SYAO_MODEL` > `~/.syaocode/config.json` 的 `model` > mock 解析（`-p`/`exec` 与交互模式一致） |
| `--permission-mode` | `strict` / `default` / `acceptEdits` / `plan` / `bypass` | 精确指定模式（`default` 即 YAO 行为、`bypass` 即 SI 行为；不指定时默认 `default`） |
| `--allowed-tools` | 工具名/通配符（空格分隔） | 预授权，如 `--allowed-tools read grep`；在严格档下可放行读取 |
| `--disallowed-tools` | 工具名/通配符 | 显式拒绝；不可放宽内置硬拒绝 |
| `--max-turns` | 正整数 | 轮次上限，触发出码 4 |
| `--max-budget-usd` | 金额 | 费用上限，触发出码 4 |
| `--cwd` | 路径 | 工作区目录 |
| `--no-boot` | — | 跳过 TUI 启动动画（终端 < 40 列或 < 12 行时自动跳过） |
| `--agents` | 群名 | 启动时激活已保存的 agent 群（common 角色成为执行模型，配合 /set-agents 使用） |
| `--output-format` | `text` / `json` / `stream-json` | 仅 `-p` 模式：结果格式 |
| `--verbose` | — | 诊断信息走 stderr |

优先级：命令行参数 > 环境变量（`SYAO_MODEL`、`SYAO_PERMISSION_MODE`）> 用户配置 > 默认。

## 3. TUI 常驻界面（TTY 终端）

TTY 下 `syao` 进入自研纯 ANSI TUI（零第三方依赖，不依赖 Ink/React）。**所有交互式入口统一先播启动动画**——无论是否带权限档位（`--SI` / `--YAO` / `--permission-mode`）、是否附带首轮 prompt；仅非交互（`-p`/`exec`）与管道输入跳过。

### 启动动画（约 6.4 秒，任意键跳过 / `--no-boot`）

1. **城市天际线**（2.0s）：散落粒子聚合为楼群轮廓，暖色窗灯随机闪烁，天空有星星与月亮
2. **蝴蝶**（2.4s）：粒子变形为参数曲线蝴蝶，**扇动两下**后收翅悬停
3. **SYAO CODE 艺术字**（1.0s + 1.0s hold）：粒子汇成 5x7 点阵放大字样，**纵向三层色：蓝（上）/ 绿（中）/ 紫（下）**，保持期间同层色彩轻微脉动

动画**在备用缓冲区播放**，结束自动清屏进入主界面；`ESC[?25l` 隐藏光标避免闪烁。
**播放期间按任意键立即跳过**（该按键被丢弃，不会进入输入框）；`--no-boot` 或非 TTY 完全不播放。

### 欢迎面板（进入工作区的初始区域，仿 Claude Code / MiMo）

动画结束后首先展示一个圆角矩形欢迎面板（终端 ≥64 列 ×20 行时显示，首次真实输出后自动收起，**内部无中缝分隔线**）：

- **上半区**：左侧是**"城市天际线 + 满月"**的场景——
  - 天际线是画面下方一条**较高的建筑带**（6~12 像素高、铺满宽度），深蓝底 + 青蓝窗，以约 60ms/像素向左循环滚动（图案首尾无缝），楼与楼留有空隙、高度起伏明显
  - **右上角是一轮满月**（完整圆盘 + 几处月海）
  - 侧视蝴蝶（蓝/紫/绿三层）当前**暂时关闭**，代码保留在 `tui/flight.ts` 备用；恢复时取消 `flightScenePixels` 中的注释即可
  - 150ms 刷新，**用户敲任意键后场景立即冻结**（面板保持静态直至首次输出，防频繁重绘）；右侧为当前语言的欢迎语、版本、当前模型与权限档位、常用指令速览（`/help` `/model` `/status` `/exit`）、输入提示（`@file` / `!cmd` / `Ctrl+C`）与 `Type / for command palette` 引导
- **底部**：**黑白阴影画风的 `SYAOCode` 艺术字横向铺满整个面板宽度**（纯白主字 + 右下深灰投影，按宽度自动缩放与均匀字距）

### 指令联想（Command Palette）

输入 `/`（命令名未输完、无空格）即在**输入框下方**弹出联想层（状态栏仍固定在最后一行）：

- **无边框列表**：每条命令一行，只有命令名与**当前语言的简短介绍**（英语界面显示英文，中文界面显示中文）；不加框线是因为各条说明长度不同，框线只会造成参差留白
- **每页只显示 6 条**：`↑/↓` 循环选择，选中项移出窗口时窗口整体滑动——新的条目从下方进入、旧的从上方移出；可从第一条一路 ↓ 选到最后一条
- 末行显示当前窗口范围与键位提示（如 `6-11/21 · ↑↓ select · Tab/Enter complete · Esc close`）
- `Tab` / `Enter` 补全选中命令到输入行（自动带尾随空格等待参数）；输入恰为完整命令名时 `Enter` 直接执行
- `Esc` 关闭联想；继续输入即实时过滤；打开联想时欢迎面板自动收起（为其让出空间）
- 弹层在光标**下方**展开：帧变高时先上移相同行数再重画，保持底部锚定（输入框位置不跳动）
- 渲染为**逐行差分更新**（仅原位重写变化行 + synchronized update 原子提交），
  移动选择零闪烁、空闲零重绘（150ms 状态定时器只在数值变化时改写状态行）

### 常驻界面布局

```
  （流式输出区：回复文本、工具调用 ⚙/✔/✖ 行，自然向上滚动）
┌─ syao (deepseek:deepseek-chat) · 部分权限：读免确认 ──────┐
│ ❯ 输入内容（CJK 宽度感知，超宽横向滚动，↑↓ 历史）      ▮
└────────────────────────────────────────────────────────────┘
 ❯ /help         显示全部命令或某条命令的详细用法
   /model        查看、切换或配置模型与 Provider
   /permission   查看或切换权限档位（仅本次会话生效）
   /permissions  查看或调整权限模式与临时规则
   /status       会话状态：模型、轮次、上下文占用、事件统计
   /cost         当前工作区累计 Token 用量与费用（跨会话）
 1-6/21 · ↑↓ 选择 · Tab/Enter 补全 · Esc 关闭
 模型 deepseek:deepseek-chat  上下文 3.2k/128k（3%）  轮次 2:5  速度 41.2 tok/s  缓存 67%  总 token 9.8k
```

- **输入框**：边框标题实时显示 `provider:model`、当前权限档位、处理中/排队状态；权限审批与 `/model config` 向导的问题也显示在框标题，答案在同一输入框键入
- **状态栏字段**（窄终端下自动从右丢弃）：当前模型 / 上下文占用（最近一次请求的 input+output，含窗口占比；**不累计多轮**）/ 第几轮:第几步 / 实时 token 输出速度（流式期间实时更新，结束后保留末次值）/ 缓存命中率（provider 未上报缓存时显示 —）/ 总消耗 token（累计）
- **流式渲染**：思考（reasoning）以暗色 `⋯` 前缀实时显示，正文与思考都按 16ms 合批后连续成段（不按批次强制换行）；工具行 `⚙` 与结果 `✔/✖` 即时插入
- **chrome 渲染（防闪烁）**：欢迎面板/联想层/输入框/状态栏组成一帧，用**纯相对光标移动**做**逐行差分更新**——只原位重写变化行，帧收缩时原位清空多余行并保持底部锚定，内容未变时零写入（不依赖 ESC7/ESC8，避免滚动后锚点漂移）；整帧写入用 synchronized update（DEC 2026）包裹，支持它的终端原子提交。回复文本在其上方追加（先撤下 chrome、写完再重画）
- 轮次 = 本次会话用户发起的第 N 轮（累计）；步数 = 累计工具执行次数
- **忙碌期间提交**：消息进入队列（保序，最多 16 条，标题显示 `已排队 N 条`），当前轮结束后依次执行；`处理中… Ns` 显示本轮耗时（含 provider 重试退避），不再是"无反馈等待"
- **问答/向导连按 Enter 安全**：引导期间的提前输入进入答案队列，下一问就绪即消费
- `/exit` 在忙碌时同样排队（当前轮后执行）；需立即退出按两次 Ctrl+C
- **粘贴**：多行文本粘贴不会触发多次提交（括号粘贴启用；粘贴内换行自动转为空格）
- **极小终端**：< 40 列或 < 8 行自动切换为无边框最小界面，放大即恢复
- **崩溃/信号**：异常或 SIGTERM/SIGHUP 退出会恢复终端（raw 模式/光标/粘贴模式）；SIGKILL 无法拦截，必要时 `reset` 或 `stty sane`
- **浅色终端**：自动探测背景亮度，欢迎面板艺术字改用深色系；字体缺 BoxDrawing 时设 `SYAO_TUI_ASCII=1` 使用 ASCII 边框

### 运行阶段行（Claude Code 风格，单行）

提交问题后，输出区先显示 `❯ 你的问题`；运行期间输入框上方显示一行：

```
 ✶ Validate & Cleanup  running sleep 2
```

- **左侧**：**单字符旋转动画**（Claude Code 同款帧 `· ✢ ✳ ✶ ✻ ✽`，约 120ms 换一帧）；单宽字符只占 1 列
  - 纯 ANSI 终端无法嵌入位图，像素蝴蝶即使做到 6×6 也会占 3 行、显得笨重；单字符旋转是这类 TUI 的标准做法
  - `SYAO_TUI_ASCII=1` 时自动降级为 `. o O * + x`
- **右侧**：阶段 + 当前动作
- **四个阶段**（启发式推进）：`Explore`（探查：读文件/搜索/只读命令）→ `Plan`（规划：探查后模型开始思考/输出）→ `Implement`（实施：首次 write/edit）→ `Validate & Cleanup`（验证与收尾：写文件后的执行/读取/回复）
- **正常态**：整行蓝色；**网络拥塞/失效**：provider 重试或 `SY-PRV-*` 错误时整行变红，动作显示「网络拥塞/失效——重试中（第 N 次，Xs）…」，下一次成功事件自动恢复
- 阶段行随工具**开始**即时更新（长命令执行期间也能看到正在跑什么），运行结束自动消失

### 键位

| 键 | 行为 |
| --- | --- |
| 可打印字符 / 中文 | 插入输入框（CJK 按码点处理，删除不切半个字） |
| `Enter` | 联想激活时 = 补全选中项（完整命令名则直接执行）；否则提交（生成中提交则排队） |
| `←/→/Home/End` | 光标移动（列宽感知）；`Backspace/Delete` 删除 |
| `↑/↓` | 联想激活时 = 选择候选（列表长于视窗时视窗自动滚动，可一路选到底）；否则浏览输入历史（浏览中保留草稿） |
| `Tab` | 联想激活时 = 补全选中项；否则插入两个空格 |
| `Esc` | 关闭指令联想 |
| `Ctrl+A/E/U/K` | 行首/行尾/清行/删至行尾 |
| `Ctrl+C` | 生成中 = 取消本轮；权限审批 = 拒绝；空闲 2 秒内两次 = 退出 |
| `Ctrl+D` | 空输入框 = 退出 |

## 4. 交互模式输入语法

| 语法 | 说明 |
| --- | --- |
| 普通文本 | 作为用户消息发给模型，流式渲染回复 |
| `@路径` | 把文件内容附加进本次提问（最多 8 个文件、每个截取 500 行），如 `总结 @src/agent.ts 和 @README.md` |
| `!命令` | 直接执行 shell 命令：**仍然经过权限闸门**——危险命令（`rm -rf /`、`git push --force`、`mkfs` 等）直接拒绝，只读命令（`ls`、`git status` 等）直接放行，其余弹出审批 |
| `/命令` | 斜杠命令（见下节） |
| `Ctrl+C` | 生成中 = 取消本轮；空闲时 2 秒内按两次 = 退出（退出码 130） |

### 权限审批（交互模式）

当模型请求写文件或执行命令时，终端弹出：

```
⚠ 权限请求 bash 执行 "npm install"（exec）
  允许执行? [y]本次允许 / [s]本次会话均允许 / [n]拒绝 (默认 n):
```

- `y` = 本次允许；`s` = 本次会话内同类操作不再询问；其他/回车 = 拒绝
- 管道/无人值守输入时**不阻塞**，按拒绝处理并提示 `SY-CLI-002`（BR-042）

## 5. 斜杠命令

### 会话与信息

> **信息类命令均以 TUI 面板输出**（圆角框、对齐表格、进度条、彩色徽标；REPL 下同样逐行渲染）：`/status`（会话 + 上下文进度条）、`/cost`（**当前工作区跨会话累计** + 按模型拆分 + 本次会话）、`/tools`（工具表）、`/permissions`（档位徽标 + 规则表）、`/doctor`（诊断表）、`/model`（当前模型 + 内置 Provider + 自定义档案 + agent 群三段式）、`/manage`（档案表）、`/help`（命令表 + 输入语法）。

| 命令 | 说明 |
| --- | --- |
| `/help [命令]` | 全部命令一览，或单条详细用法 |
| `/permission` | 权限档位速查与切换（三档快捷命令，见「权限管理」节） |
| `/status` | 会话 ID、当前模型、权限模式、轮次、上下文 token 占用百分比 |
| `/cost` | **当前工作区累计**（跨会话持久化，以工作区路径为索引）+ **按模型拆分** + 本次会话：请求次数、输入/输出/缓存读/缓存写 token、费用（优先使用 provider 上报的费用，如网关返回的 `usage.cost`；否则用本地价目表；两者都无则标注无定价）。账本存于 `~/.syaocode/usage/<工作区路径哈希>.json`，只含数字与模型名（无密钥、无对话内容） |
| `/tools` | 已注册工具及风险级别（read/write/exec）、是否只读、并发安全 |
| `/doctor` | 与 `syao doctor` 相同的 12 项诊断 |
| `/setup` | **模型配置向导**（TUI）：进度线引导逐步填写模型名称→请求地址→API Key→API 协议→认证字段→档案名，最后保存（见下节） |
| `/set-agents` | **agent 群配置向导**（TUI）：新建群或修改已有群，为 hyaki（总结）/ sota（思考）/ common（执行）三角色各选一个模型（见下节） |
| `/setting` | 快速修改**当前激活 agent 群**的三角色配置（等价编辑当前群） |
| `/manage` | **管理自定义模型档案**（TUI）：列出已存档案，选择后可查看详情、编辑（重跑向导、空输入沿用现值）或删除 |
| `/agents` | **多智能体工作模式**（M3+）：按已配置的 agent 群分派三角色；当前显示群清单与配置入口 |
| `/clear` | 清空对话历史，开启新会话 |
| `/compact` | 手动压缩：清理旧工具结果（保留最近 6 轮），显示前后 token 对比 |
| `/resume [id]` | 列出最近 5 个会话；`/resume <id>` 恢复指定会话（下一条消息接续其历史） |
| `/exit` `/quit` | 退出 |


### agent 群：`/set-agents` · `/setting` · `/agents`（TUI）

以**差异化模型配置**降本：同一个群内三个角色分工、各绑一个模型，甚至可以让同一模型兼任多个角色（低成本场景三角色全用同一模型即可）。

| 角色 | 职责 | 建议模型 |
| --- | --- | --- |
| **hyaki** | 大规模文本输入与总结 | 低成本（如 deepseek-chat） |
| **sota** | 思考、规划与评审 | 高能力（如 claude-sonnet-4） |
| **common** | 落实与执行 | 均衡（如 deepseek-chat） |

**`/set-agents`** 进入向导（与 /setup 同款进度线风格）：

1. 若已有群：先选目标 —— 已有群（进入修改、角色预填并高亮当前模型）或 `＋ create a new group`
2. 群名（自行命名；修改时回车沿用）
3. 依次为 hyaki / sota / common 选择模型 —— 选项来自**当前已有的模型**：内置 Provider 目录（`mock:default`、`deepseek:deepseek-chat`、`anthropic:claude-sonnet-4` …）与 `/setup` 创建的自定义档案（`@档案名`），↑↓ 选择、Enter 确认
4. 保存后询问 `设为当前 agent 群? [Y/n]`；确认即激活

**激活语义**（在 /agents 模式落地前即可直接使用该群工作）：主工作模型取 **common** 角色，会话照常执行；`activeAgentGroup` 一并记录，M3 的 `/agents` 编排模式启用后将自动按群分派 hyaki/sota/common。

- `/setting`：等价于编辑当前激活的群（三角色配置预填，回车沿用）
- `/model use @群名`：随时切换群（与 `@档案名` 同名时档案优先）
- `syao --agents <群名>`：启动时直接激活
- `/agents`：M3 工作模式入口，当前展示群清单（● 标记激活群）与配置引导
- `/model` 面板中 agent 群以 `hyaki / sota / common` 三列展示，可一眼看清差异化配置

### 自定义模型：`/setup` 向导 与 `/manage` 管理（TUI）

内置 Provider（mock / deepseek / openai-compatible / anthropic）之外的任意端点，用 **`/setup`** 以 Vite create-app 式向导接入：左侧竖向进度线，每个流程点一个彩色圆点、连接线与下一流程点同色（点与线颜色互不相同），当前步高亮、已完成步展示答案、未到步置灰。

**六步流程**（Enter 确认 / 选择步 ↑↓ 选、Enter 确认 / `Esc` 取消）：

| # | 字段 | 说明 |
| --- | --- | --- |
| 1 | model name | 模型名称，如 `deepseek-chat`、`claude-sonnet-4` |
| 2 | request url | 请求地址（须 http/https 开头） |
| 3 | api key | 密钥（**输入时掩码显示**；保存到 `~/.syaocode/env`，权限 0600，绝不入 config.json/日志/会话） |
| 4 | api protocol | **四种协议**：Anthropic Messages / OpenAI ChatCompletion / OpenAI Responses API（适配器规划 M2）/ Gemini Native GenerateContent（适配器规划 M2） |
| 5 | auth field | 认证字段：`Authorization: Bearer` / `x-api-key` / `x-goog-api-key` / `?key=` 查询参数（选项随协议自动收窄，选错协议时自动回退默认） |
| 6 | profile name | 档案名（请求名称），之后以 `@名称` 引用；保存前校验命名与重名 |

保存后询问 `设为当前模型? [Y/n]`：确认即切换（等价 `/model use @名称`，历史保留）；否则可用 `/model use @名称` 随时启用。协议为 Responses/Gemini 的档案可正常保存，但实际调用会报 `SY-PRV-010`（适配器规划于 M2），向导保存时会明确提示。

**`/manage`**：列出全部档案（协议、模型、密钥状态），输入档案名后显示详情（模型/地址/协议/认证/更新时间），可选：

- `e` 编辑：重跑向导并预填现值；文本步**直接回车 = 沿用当前值**，API Key 留空 = 不变更
- `d` 删除：二次确认后移除档案（当前默认模型指向它时自动回退 mock；env 文件中的密钥字段保留，可手动清理）

档案存储于 `~/.syaocode/config.json` 的 `models` 字段（非机密）；引用的密钥以 `SYAO_KEY_<档案名大写>` 存于 `~/.syaocode/env`。管道/REPL 下 `/setup`、`/manage` 提示需 TUI（手动编辑 config.json 的 `models` 字段亦可）。

### 语言：`/language`（TUI 与 REPL 通用）

```
/language            # 面板：显示当前语言 + 两个选项，问答式选择
/language en         # 直接切到英语（默认）
/language zh         # 直接切到中文
```

- **默认语言为英语**；语言状态保存在 `~/.syaocode/config.json` 的 `language` 字段
- 选择后会先打印警告：**切换后当前 CLI 立即退出，新语言在下次启动 syao 时生效**；确认（`y`）后写入配置并退出，取消（`n`/回车）则语言不变
- 两种语言**互不混杂**：界面文案、面板标签、状态栏、向导、提示、错误提示、CLI `--help` 用法全部按当前语言输出；仅保留 logo、命令名、协议名、模型名与工具/模型返回的数据
- 非法语言码（如 `/language fr`）会被拒绝并提示可用取值
- 错误提示：中文模式下 `SY-*` 错误显示错误码对应的中文说明（09 §9.10 表）；英语模式显示原始英文消息

### 模型管理：`/model`

| 用法 | 说明 |
| --- | --- |
| `/model` 或 `/model show` | 当前模型、端点、密钥状态（只显示"已设置/未设置"，不显示值） |
| `/model list` | Provider 目录：4 个 provider、推荐模型、密钥是否就绪 |
| `/model use <provider:model>` | 切换模型（校验密钥就绪），**历史保留**，并保存为下次默认 |
| `/model config [provider]` | **交互式配置向导**：选 provider → 填模型名（有默认）→ 可改 Base URL → 可录入 API Key（存入 `~/.syaocode/env`，权限 0600） |

**Provider 目录（v0.1）**

| Provider | 推荐模型 | 密钥环境变量 | 说明 |
| --- | --- | --- | --- |
| `mock` | `default` | 无 | 离线确定性测试；用 `SYAO_MOCK_SCRIPT` 注入剧本 |
| `deepseek` | `deepseek-chat` / `deepseek-reasoner` | `DEEPSEEK_API_KEY` | OpenAI 兼容 |
| `openai-compatible` | `gpt-4o` / `gpt-4o-mini` | `OPENAI_API_KEY` | OpenAI 及任何兼容端点（可用 `OPENAI_BASE_URL` 覆盖） |
| `anthropic` | `claude-sonnet-4` / `claude-haiku-4` | `ANTHROPIC_API_KEY` | 原生 Messages 协议 |

### 权限管理：`/permission` 与 `/permissions`

**`/permission`（档位快捷切换，推荐）**——对应启动时的三个档位，会话内直接升降档：

| 用法 | 说明 |
| --- | --- |
| `/permission` | 显示当前模式/档位 + 三档速查表（`●` 标记当前档位）+ 本会话临时规则 |
| `/permission strict` | 切回**严格档**：一切操作（含读取）都需确认 |
| `/permission YAO` | **部分权限**：读取免确认；写、删、执行需确认 |
| `/permission SI` | **完全权限**：文件增删改查读全部免确认（危险命令仍拒绝） |

档位名大小写不敏感（`YAO`/`yao`、`SI`/`si` 均可），`default`/`bypass` 作为模式别名同样接受，
高级模式 `acceptEdits`/`plan` 也可直接作为参数。**切换仅本次会话生效**——启动默认仍由命令行档位参数
或配置 `permissionMode` 决定；切换后输入框标题的档位标识即时更新。

**`/permissions`（进阶，两个命令名参数完全互通）**：

| 用法 | 说明 |
| --- | --- |
| `/permissions` | 同 `/permission`（模式 + 档位速查表 + 临时规则列表） |
| `/permissions mode <m>` | 精确切换 `strict`/`default`/`acceptEdits`/`plan`/`bypass` |
| `/permissions allow <tool>` | 添加会话级放行规则（如 `/permissions allow write`、`/permissions allow mcp__github__*`） |
| `/permissions deny <tool>` | 添加会话级拒绝规则 |

规则语义（不可绕过）：`deny > ask > allow`；危险命令任何档位默认拒绝；项目级配置不能放宽用户级 deny（BR-024）；**任何模型输出都不能提升权限**。档位（strict/YAO/SI）只是改变"哪些操作免确认"，不改变这些硬规则。

### 计划中的命令（当前为占位提示）

| 命令 | 计划 | 功能 |
| --- | --- | --- |
| `/agents` | M3+ | 三角色编排（hyaki 摘要 / sota 规划 / common 执行） |
| `/goal` | M3+ | 目标设定与确定性验收（BR-050） |
| `/mcp` | M4+ | MCP 服务器管理（`mcp__{server}__{tool}`） |
| `/rewind` | M2+ | 检查点回滚 |

## 6. 非交互输出协议（`-p` 模式）

- `--output-format text`：仅最终文本到 stdout
- `--output-format json`：单个版本化对象 `{schemaVersion, sessionId, endReason, turns, usage, costUsd?, finalText}`
- `--output-format stream-json`：每行一个事件 `{schemaVersion, sessionId, ts, type, event}`
- stdout 只承载协议数据，诊断/进度走 stderr（FR-174）；无人值守时 ask 一律按拒绝（BR-042）

**退出码（BR-042）**：`0` 完成；`1` 一般错误；`2` 用法/配置错误；`3` 权限拒绝未完成；`4` 轮次/预算/时长上限；`130` 用户中断。

## 7. 配置与密钥文件

| 文件 | 用途 | 权限 |
| --- | --- | --- |
| `~/.syaocode/config.json` | 默认模型、权限模式、语言（`language: en\|zh`）等**非机密**配置 | 普通 |
| `~/.syaocode/env` | `KEY=VALUE` 密钥（`/model config` 写入），启动时合并进环境变量，**不覆盖**已有变量 | 0600 |
| `~/.syaocode/sessions/` | JSONL 会话日志（追加式，BR-016） | 普通 |
| `~/.syaocode/usage/` | **工作区用量账本**（`/cost` 数据源）：按工作区路径哈希分文件，桶内以绝对路径为索引，累计请求数/token/费用并按 `provider:model` 拆分；只含数字与模型名 | 普通 |
| `<项目>/.syaocode/config.json` | 项目级配置；首次使用需信任确认（BR-043） | — |
| `~/.syaocode/AGENTS.md` | 用户级项目指令（注入系统提示，FR-051/FR-083） | 普通 |
| `<工作目录>/AGENTS.md` | 仓库根项目指令，缺失时回退 `CLAUDE.md` | 普通 |

红线：密钥绝不进入会话文件、日志、错误信息与仓库（BR-023）；脱敏器在所有出口前生效。

**系统提示注入**（启动时读取一次）：工作目录 / 平台 / 日期 / 运行载体（Harness）/ **当前模型身份**（`Model: …`，使模型能如实回答"你是什么模型"）+ 用户级与仓库根的项目指令文件；文件名列表可用 `SYAO_INSTRUCTION_FILES=a.md,b.md` 覆盖（默认 `AGENTS.md,CLAUDE.md`）；单个文件超过 32KB 截断。子目录级指令的惰性加载规划于 M2（DD-6）。

## 8. 常见示例

```bash
# 严格档（默认）：每个操作都确认
syao

# 部分权限：读免确认，写/删要确认
syao --YAO
syao --YAO -m deepseek:deepseek-chat "审查这个仓库"

# 完全权限：文件增删改查读都不问（危险命令仍拒绝）
syao --SI "跑一遍测试并修复失败项"

# 只读审查（plan 模式：写/执行一律拒绝）
syao --permission-mode plan "审查 src/agent.ts 的错误处理"

# 脚本化使用
cat error.log | syao -p "分析报错原因" --output-format json --YAO
syao -p "跑测试并修复" --SI --max-turns 20; echo "exit=$?"

# 会话恢复
syao                      # /resume → 选择历史会话 → 继续对话
```

---

*命令语义与错误码以《09-错误体系专项设计》《05-业务规则文档》为准；本文档随版本更新。*
