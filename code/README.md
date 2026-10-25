# SYAOCode

TypeScript coding-agent harness library + reference CLI. Model-neutral, embeddable, auditable.

**Status: v0.1 internal (M0+M1 of the project WBS) — not published.**

## What's in v0.1

| Package | Contents |
| --- | --- |
| `@syaocode/core` | Kernel: content-block message model, Runtime abstraction (all IO injected), event stream, agent loop (streaming, batching, abort, limits, BR-011 loop detection), permission engine (deny>ask>allow, path fence, dangerous-command library), 79-code error registry with zh-CN messages, Zod config layering, JSONL/in-memory session stores, redactor |
| `@syaocode/providers` | OpenAI Chat Completions adapter (DeepSeek-compatible) + native Anthropic Messages adapter; SSE streaming, normalized events, error mapping |
| `@syaocode/tools` | read / write / edit / glob / grep / bash with read-before-write fencing (BR-004), unique-match edits (BR-005), .gitignore-aware search, restricted shell |
| `@syaocode/testing` | MemoryRuntime (fully in-memory), MockProvider (scripted), provider contract suite (G2: same suite over all providers) |
| `syaocode` (CLI) | **权限三档**：默认严格档（一切操作需确认）/ `--yao`（读免确认）/ `--si`（文件增删改查读全免确认，危险命令仍拒绝），会话内可用 **`/permission <档位>`** 直接切换，且支持**对话中热改**（审批挂起时输入 `/permission si` 即按新策略重新评估同一请求、立即可放行，无需二次询问）；**TUI 常驻界面**（TTY 下自研纯 ANSI 实现，零 UI 依赖；所有交互式入口统一先播启动动画）：启动粒子动画（城市天际线→蝴蝶扇两下→蓝/绿/紫三层色 SYAO CODE 艺术字）→ 欢迎面板（左侧"较高天际线带循环后退 + 右上满月"场景（侧视蝴蝶暂时关闭、代码保留备用） + 黑白阴影 SYAOCode 艺术字，右侧当前语言欢迎与指令提示，首次输出或打开联想后收起）+ 指令联想（`/` 触发**全量命令列表 + 行内简介 + 视窗滚动选取**，弹层位于输入框**下方**；↑↓ 选择、Tab/Enter 补全；**逐行差分渲染**，移动与空闲零闪烁）+ **`/setup` 模型配置向导**（Vite 式彩色进度线：模型名/请求地址/APIKey 掩码/四种协议/认证字段/档案名）与 **`/manage`**（档案查看/编辑/删除）+ **`/set-agents` agent 群向导**（hyaki 总结 / sota 思考 / common 执行三角色差异化模型，新建或改群，允许同模型兼多职；`/setting` 快捷修改、`--agents` 启动激活）+ **信息命令面板化**（/status /cost /tools /permissions /doctor /model /help 均为圆角面板/表格/进度条；其中 **/cost 读取按工作区持久化的用量账本**，输出当前工作区跨会话累计 + 按模型拆分 + 本次会话）+ 蝴蝶首键冻结 + 边框输入框 + 实时状态栏（模型/上下文/轮步/token 速度/缓存命中率/总消耗）+ 运行时单行阶段行（Explore/Plan/Implement/Validate & Cleanup + Claude 式单字符旋转动画；网络重试整行转红）；非 TTY 回退 readline REPL（流式渲染、终端权限审批 y/s/n、Ctrl+C 取消、@路径 引用、!命令 经闸门执行）；斜杠命令 `/help /model /permission /permissions /status /cost /tools /compact /clear /resume /doctor /exit`，非交互 `-p`/`exec` 与 `--output-format text/json/stream-json`，BR-042 退出码。完整参考：`docs/COMMANDS.md` |

**开箱默认**：不配任何东西即可 `syao` 直接对话（内置 mock 离线跑通全链路）；配好模型后**交互与 `-p`/`exec` 使用同一套解析顺序**（`--model` > `SYAO_MODEL` > `~/.syaocode/config.json` > mock）。默认权限档为**默认档**（读免确认，写/删/执行仍审批，规范 FR-041 的 default），`--permission-mode strict` 可回到逐条确认；系统提示自动注入工作目录/平台/日期/运行载体/**当前模型身份**，模型能如实回答"你是什么模型"；`/setup` 会按模型名与请求地址自动预填档案名、协议与认证字段，回车即接受。

**双语 CLI**：默认英语，`/language` 可切到中文（写入 `~/.syaocode/config.json`，切换后立即退出、下次启动生效）；界面文案/面板/向导/状态栏/错误提示全部随语言切换，两种语言互不混杂。TUI 指令联想层位于输入框**下方**；启动动画期间按任意键立即跳过。

Out of v0.1 scope (per WBS): 自动压缩、MCP、决策层 (JEV)、三角色编排、/goal。（原计划的 Ink 式 TUI 已在 v0.1 内以零依赖纯 ANSI 方式交付。）

系统提示会自动注入工作目录/平台/日期 + 用户级 `~/.syaocode/AGENTS.md` + 仓库根 `AGENTS.md`（缺失回退 `CLAUDE.md`，`SYAO_INSTRUCTION_FILES` 可配置）。真实模型链路（OpenAI ChatCompletion 网关）已完成配置向导、工具调用、流式思考、权限审批与费用展示的端到端验证，详见 `docs/TEST-REPORT-v0.1.md` §11。

## Commands

**必须在 `code/` 目录内运行**（本仓库自身是 monorepo 根）。若在其上层目录运行 pnpm，pnpm 会向上层查找 package.json 并安装无关项目的依赖（例如误装到家目录的其他项目），导致 `Command "tsx" not found`。

```bash
cd code                                        # ← 先进入本目录
corepack pnpm install                          # install (Node >= 22 required)
corepack pnpm typecheck                        # tsc --noEmit across packages (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess)
corepack pnpm test                             # vitest across packages
corepack pnpm test:evals                       # 10-task deterministic eval harness (no keys needed)
corepack pnpm lint:registry                    # error-registry governance checks

# CLI（开发运行形态；TUI 启动动画 + 常驻界面）：
corepack pnpm start                            # 等价于 exec tsx packages/cli/src/main.ts
corepack pnpm start --no-boot                  # 跳过启动动画
corepack pnpm exec tsx packages/cli/src/main.ts --version
corepack pnpm exec tsx packages/cli/src/main.ts doctor
corepack pnpm exec tsx packages/cli/src/main.ts -p "hello" --output-format stream-json
```

依赖构建脚本说明：pnpm ≥10 默认拦截依赖的 postinstall，本仓库已在 `pnpm-workspace.yaml` 放行 esbuild（`allowBuilds`）；若新增带安装脚本的依赖，运行 `corepack pnpm approve-builds` 审批。

## Publish readiness（面向未来的 npm 发布）

v0.1 内部版不发布，但打包链路已就绪并离线验证：

- **构建**：每包 `tsc -p tsconfig.build.json` 产出 `dist/`（ESM JS + d.ts）；根 `corepack pnpm build` 按依赖分层构建（core → providers/tools/testing → cli）。源码相对 import 一律带 `.js` 后缀（Node ESM 标准），tsc 用 `rewriteRelativeImportExtensions` 兜底。
- **exports 双态**：开发态 `exports` 指向 `./src/*.ts`（workspace 内部直用 TS 源，vitest/tsx 友好）；`pnpm publish`/`pnpm pack` 自动应用 `publishConfig.exports` 切到 `./dist/*.js`（含 `types` 条件）。`workspace:*` 依赖在打包时改写为真实版本号。
- **CLI**：`bin` 为 `syaocode` 与 `syao` 两个名字，均指向带 shebang 的 `dist/main.js`；`files` 只收 `dist/` 与 `LICENSE`；`publishConfig.access: public`（`@syaocode/*` 作用域包必须显式 public，否则发布失败）。
- **离线验证**（发布前可重复执行）：五包 `pnpm pack` → 干净目录 `file:` 安装（用 `pnpm-workspace.yaml` overrides 模拟 registry）→ 纯 Node 实测 `syaocode --version` / `doctor` / mock `-p` 回合 / 管道 REPL / `import '@syaocode/core'` 全部通过。

正式发布流程（先测试后上传，全部通过才允许发布）：

```bash
cd code
corepack pnpm install
corepack pnpm typecheck && corepack pnpm test && corepack pnpm test:evals   # 必须全绿
corepack pnpm build
# 按依赖顺序发布：core → providers/tools/testing → cli（CLI 依赖前四者，逆序会解析失败）
for p in core providers tools testing cli; do (cd packages/$p && corepack pnpm publish --access public); done
```

> 注意：`@syaocode/testing` 是 CLI 的运行时依赖（`mock` provider 的 MockProvider 属于产品功能），其主入口不依赖 vitest（合约套件在 `./contract` 子路径，仅开发用）。

## Design invariants (do not break)

- Deny > ask > allow; **no model output can upgrade a deny** (BR-001/026/027).
- Every `tool_use` gets exactly one `tool_result`, even on abort (BR-009).
- Only `SyaoError` crosses boundaries; identify with `SyaoError.is()`, never `instanceof` (BR-025).
- Error codes: `SY-<domain>-<seq>`; **SY-DEC-007 is an intentional gap** — never fill it.
- All IO goes through the injected Runtime (ADR-03); core depends on nothing but zod.
- Zod is the single schema source (ADR-07); `exports` are ESM-only (ADR-08).

Docs live outside this repo (`../document/SYAOCode/`). Test report: `docs/TEST-REPORT-v0.1.md`.
